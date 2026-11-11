import type { PrismaClient } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db } from "@/lib/db";
import { compareDates, localDate, todayInLagos } from "@/lib/dates";
import { formatNaira, kobo, parseNaira } from "@/lib/money";
import { linkEvidence, storeEvidenceBytes } from "@/evidence/service";
import type { EvidenceStore } from "@/evidence/store";
import { postEvent } from "@/ledger/post";
import { writeAudit } from "@/shell/audit/audit";
import { assertNotSelfDealing } from "@/shell/rbac/permissions";
import { overpaymentCredit } from "../loans/queries";
import { ngn, tellMember, tellStaff } from "../notices";

/**
 * Overpayment Credit refunds (PRD F12): a member's request (in the portal, or
 * a signed request captured by a Loan Officer) → Management approves → the
 * Cashier prepares a refund voucher with the transfer evidence → the Finance
 * Manager verifies it (a different person) → CASH_OUT (REFUND_VOUCHER) and
 * DEPOSIT_REFUNDED. Credits are only ever refunded, never moved to a loan.
 */
export class RefundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundError";
  }
}

export interface RefundActor {
  id: string;
  ipAddress: string | null;
}

export interface RefundRequestInput {
  amount: string;
  beneficiaryName: string;
  beneficiaryBank: string;
  beneficiaryAccountNo: string;
  note?: string;
}

const naira = (v: bigint) => formatNaira(kobo(v));

/** Credit not yet refunded and not already asked for by an open refund (other than `except`). */
export async function refundableCredit(db: Db, memberId: string, except?: string) {
  const [credit, open] = await Promise.all([
    overpaymentCredit(db, memberId),
    db.refund.aggregate({ where: { memberId, status: { in: ["REQUESTED", "APPROVED"] }, ...(except ? { id: { not: except } } : {}) }, _sum: { amount: true } }),
  ]);
  return kobo(credit - (open._sum.amount ?? 0n));
}

async function actorMemberId(db: Db, actor: RefundActor) {
  return (await db.member.findUnique({ where: { userId: actor.id }, select: { id: true } }))?.id ?? null;
}

function parseRequest(input: RefundRequestInput) {
  let amount: bigint;
  try {
    amount = parseNaira(input.amount.trim());
  } catch {
    throw new RefundError("Enter the amount in naira, e.g. 15,000.");
  }
  if (amount <= 0n) throw new RefundError("The amount must be more than ₦0.");
  const name = input.beneficiaryName.trim();
  const bank = input.beneficiaryBank.trim();
  const account = input.beneficiaryAccountNo.replace(/\s/g, "");
  if (name.length < 3) throw new RefundError("Enter the account holder's name.");
  if (bank.length < 2) throw new RefundError("Enter the bank's name.");
  if (!/^\d{10}$/.test(account)) throw new RefundError("Enter the 10-digit account number (NUBAN).");
  return { amount, beneficiaryName: name.slice(0, 120), beneficiaryBank: bank.slice(0, 80), beneficiaryAccountNo: account, note: input.note?.trim().slice(0, 300) || null };
}

async function createRequest(db: PrismaClient, actor: RefundActor, memberId: string, input: RefundRequestInput, channel: "PORTAL" | "ASSISTED", requestEvidenceId: string | null) {
  const data = parseRequest(input);
  const member = await db.member.findUnique({ where: { id: memberId } });
  if (!member || (member.status !== "ACTIVE" && member.status !== "EXITED")) throw new RefundError("Only members can be refunded.");
  const available = await refundableCredit(db, memberId);
  if (data.amount > available) throw new RefundError(`The Overpayment Credit available to refund is ${naira(available)}.`);
  if (await db.refund.findFirst({ where: { memberId, status: { in: ["REQUESTED", "APPROVED"] } } })) throw new RefundError("A refund for this member is already in progress.");
  const refund = await db.refund.create({ data: { ...data, memberId, channel, requestEvidenceId, requestedById: actor.id } });
  await writeAudit(db, {
    action: channel === "PORTAL" ? "self.refund.request" : "refund.captureRequest",
    entityType: "Refund",
    entityId: refund.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    evidenceRef: requestEvidenceId,
    after: { memberId, amount: data.amount.toString(), channel },
  });
  await tellStaff(db, ["MANAGEMENT"], `refund.requested:${refund.id}`, "staff.refund.requested", "A refund waits for approval", `A refund of ${ngn(data.amount)} was requested and waits for Management's decision.`, actor.id);
  return refund;
}

/** The member asks, in the portal, for their Overpayment Credit to be refunded. */
export async function requestRefund(db: PrismaClient, actor: RefundActor, input: RefundRequestInput) {
  const member = await db.member.findUnique({ where: { userId: actor.id } });
  if (!member) throw new RefundError("No membership is linked to this login.");
  return createRequest(db, actor, member.id, input, "PORTAL", null);
}

/** A Loan Officer captures a member's signed refund request (by member number or MOAUM ID). */
export async function captureRefundRequest(
  db: PrismaClient,
  store: EvidenceStore,
  actor: RefundActor,
  memberKey: string,
  input: RefundRequestInput,
  signedRequest: { filename: string; bytes: Uint8Array },
) {
  const key = memberKey.trim().toUpperCase();
  const member = await db.member.findFirst({ where: { OR: [{ memberNo: key }, { moaumIdNumber: { equals: key, mode: "insensitive" } }] } });
  if (!member) throw new RefundError(`No member ${key}.`);
  assertNotSelfDealing(await actorMemberId(db, actor), member.id);
  if (signedRequest.bytes.length === 0) throw new RefundError("Attach the member's signed request.");
  const file = await storeEvidenceBytes(db, store, actor, signedRequest.filename, signedRequest.bytes);
  const refund = await createRequest(db, actor, member.id, input, "ASSISTED", file.evidenceId);
  await linkEvidence(db, actor, { evidenceId: file.evidenceId, entityType: "Refund", entityId: refund.id, kind: "PRIMARY", submissionKey: `REFUND_REQUEST:${refund.id}` });
  return refund;
}

/** The member withdraws a request no one has decided yet. */
export async function cancelRefund(db: Db, actor: RefundActor, refundId: string) {
  const refund = await db.refund.findUnique({ where: { id: refundId }, include: { member: { select: { userId: true } } } });
  if (!refund || refund.member.userId !== actor.id) throw new RefundError("Refund not found.");
  const { count } = await db.refund.updateMany({ where: { id: refundId, status: "REQUESTED" }, data: { status: "CANCELLED", decidedAt: new Date(), decidedById: actor.id } });
  if (count !== 1) throw new RefundError("Only a request that hasn't been decided can be withdrawn.");
  await writeAudit(db, { action: "refund.cancel", entityType: "Refund", entityId: refundId, userId: actor.id, ipAddress: actor.ipAddress });
}

async function requested(db: Db, refundId: string, actor: RefundActor) {
  const refund = await db.refund.findUnique({ where: { id: refundId } });
  if (!refund) throw new RefundError("Refund not found.");
  if (refund.status !== "REQUESTED") throw new RefundError("This refund has already been decided.");
  assertNotSelfDealing(await actorMemberId(db, actor), refund.memberId);
  return refund;
}

/** Management approves the refund; the credit must still cover it. */
export async function approveRefund(db: Db, actor: RefundActor, refundId: string, comment: string) {
  const refund = await requested(db, refundId, actor);
  const available = await refundableCredit(db, refund.memberId, refund.id);
  if (refund.amount > available) throw new RefundError(`The member's credit now covers only ${naira(available)}. Reject this request; they can ask again.`);
  const { count } = await db.refund.updateMany({ where: { id: refundId, status: "REQUESTED" }, data: { status: "APPROVED", decidedById: actor.id, decidedAt: new Date(), decisionComment: comment.trim() || null } });
  if (count !== 1) throw new RefundError("This refund was decided by someone else just now.");
  await writeAudit(db, { action: "refund.approve", entityType: "Refund", entityId: refundId, userId: actor.id, ipAddress: actor.ipAddress, after: { amount: refund.amount.toString(), comment } });
  await tellMember(db, refund.memberId, `refund.approved:${refundId}`, "refund.approved", `your refund of ${ngn(refund.amount)} is approved. Payment follows.`);
  await tellStaff(db, ["CASHIER"], `refund.approved:${refundId}`, "staff.refund.approved", "A refund is approved: prepare the voucher", `A refund of ${ngn(refund.amount)} is approved. Prepare the refund voucher after the transfer.`, actor.id);
}

export async function rejectRefund(db: Db, actor: RefundActor, refundId: string, comment: string) {
  const why = comment.trim();
  if (why.length < 5) throw new RefundError("Say why the refund is rejected (the member sees it).");
  const refund = await requested(db, refundId, actor);
  const { count } = await db.refund.updateMany({ where: { id: refundId, status: "REQUESTED" }, data: { status: "REJECTED", decidedById: actor.id, decidedAt: new Date(), decisionComment: why } });
  if (count !== 1) throw new RefundError("This refund was decided by someone else just now.");
  await writeAudit(db, { action: "refund.reject", entityType: "Refund", entityId: refundId, userId: actor.id, ipAddress: actor.ipAddress, after: { comment: why } });
  await tellMember(db, refund.memberId, `refund.rejected:${refundId}`, "refund.rejected", `your refund request of ${ngn(refund.amount)} was not approved. Sign in to see why.`);
}

export interface RefundVoucherInput {
  bankAccountId: string;
  valueDate: string;
  transferRef: string;
}

/** The Cashier prepares the refund voucher with the transfer evidence (full approved amount to the member's account). */
export async function prepareRefundVoucher(db: PrismaClient, store: EvidenceStore, actor: RefundActor, refundId: string, input: RefundVoucherInput, transfer: { filename: string; bytes: Uint8Array }) {
  const refund = await db.refund.findUnique({ where: { id: refundId } });
  if (!refund || refund.status !== "APPROVED") throw new RefundError("Only an approved refund can be paid.");
  assertNotSelfDealing(await actorMemberId(db, actor), refund.memberId);
  if (await db.voucher.findFirst({ where: { refundId, status: "PREPARED" } })) throw new RefundError("A voucher for this refund is already waiting for the Finance Manager.");
  const account = await db.bankAccount.findUnique({ where: { id: input.bankAccountId } });
  if (!account?.active) throw new RefundError("Choose the MOAUM bank account the money was paid from.");
  let valueDate;
  try {
    valueDate = localDate(input.valueDate.trim());
  } catch {
    throw new RefundError("Enter the transfer's value date.");
  }
  if (compareDates(valueDate, todayInLagos()) > 0) throw new RefundError("The value date can't be in the future: prepare the voucher after the transfer.");
  const ref = input.transferRef.trim();
  if (ref.length < 3) throw new RefundError("Enter the transfer reference.");
  if (transfer.bytes.length === 0) throw new RefundError("Attach the transfer evidence.");
  const file = await storeEvidenceBytes(db, store, actor, transfer.filename, transfer.bytes);
  const voucher = await db.voucher.create({
    data: {
      type: "REFUND",
      refundId,
      amount: refund.amount,
      valueDate: new Date(`${valueDate}T00:00:00Z`),
      bankAccountId: account.id,
      transferRef: ref.slice(0, 80),
      beneficiaryName: refund.beneficiaryName,
      beneficiaryBank: refund.beneficiaryBank,
      beneficiaryAccountNo: refund.beneficiaryAccountNo,
      evidenceId: file.evidenceId,
      preparedById: actor.id,
    },
  });
  await linkEvidence(db, actor, { evidenceId: file.evidenceId, entityType: "Voucher", entityId: voucher.id, kind: "PRIMARY", submissionKey: `REFUND_VOUCHER:${voucher.id}` });
  await writeAudit(db, { action: "voucher.refund.prepare", entityType: "Voucher", entityId: voucher.id, userId: actor.id, ipAddress: actor.ipAddress, evidenceRef: file.evidenceId, after: { refundId, amount: refund.amount.toString(), valueDate } });
  await tellStaff(db, ["FINANCE_MANAGER"], `refund.voucher:${voucher.id}`, "staff.refund.voucher", "A refund voucher waits for verification", `A refund voucher of ${ngn(refund.amount)} (${ref.slice(0, 80)}) waits for your verification.`, actor.id);
  return voucher;
}

async function preparedRefundVoucher(db: Db, voucherId: string, actor: RefundActor) {
  const voucher = await db.voucher.findUnique({ where: { id: voucherId }, include: { refund: true } });
  if (!voucher || voucher.type !== "REFUND" || !voucher.refund) throw new RefundError("Voucher not found.");
  if (voucher.status !== "PREPARED") throw new RefundError("This voucher has already been handled.");
  if (voucher.preparedById === actor.id) throw new RefundError("Someone else must verify a voucher you prepared.");
  assertNotSelfDealing(await actorMemberId(db, actor), voucher.refund.memberId);
  return voucher as typeof voucher & { refund: NonNullable<typeof voucher.refund> };
}

/** The Finance Manager verifies: CASH_OUT (REFUND_VOUCHER) and DEPOSIT_REFUNDED, in one transaction. */
export async function verifyRefundVoucher(db: PrismaClient, actor: RefundActor, voucherId: string) {
  const voucher = await preparedRefundVoucher(db, voucherId, actor);
  const refund = voucher.refund;
  const available = await refundableCredit(db, refund.memberId, refund.id);
  if (refund.amount > available) throw new RefundError(`The member's credit now covers only ${naira(available)}; return the voucher.`);
  const now = new Date();
  await db.$transaction(async (tx) => {
    const { count } = await tx.voucher.updateMany({ where: { id: voucher.id, status: "PREPARED" }, data: { status: "VERIFIED", verifiedById: actor.id, verifiedAt: now } });
    if (count !== 1) throw new RefundError("This voucher was handled by someone else just now.");
    const { event } = await postEvent(tx, {
      occurredAt: voucher.valueDate,
      moduleCode: "CREDIT",
      eventType: "CASH_OUT",
      source: "REFUND_VOUCHER",
      evidenceRefs: [voucher.evidenceId],
      portalUserId: actor.id,
      moduleEntityType: "Refund",
      moduleEntityId: refund.id,
      bankAccountId: voucher.bankAccountId,
      cashAmount: refund.amount,
      uniquenessKey: `CREDIT:REFUND:${refund.id}:CASH_OUT`,
      metadata: { voucherId: voucher.id, memberId: refund.memberId, transferRef: voucher.transferRef },
    });
    await postEvent(tx, {
      occurredAt: voucher.valueDate,
      moduleCode: "CREDIT",
      eventType: "DEPOSIT_REFUNDED",
      source: "REFUND_VOUCHER",
      evidenceRefs: [voucher.evidenceId],
      portalUserId: actor.id,
      moduleEntityType: "Member",
      moduleEntityId: refund.memberId,
      depositDelta: refund.amount,
      uniquenessKey: `CREDIT:REFUND:${refund.id}:DEPOSIT_REFUNDED`,
      metadata: { refundId: refund.id, voucherId: voucher.id },
    });
    await tx.voucher.update({ where: { id: voucher.id }, data: { ledgerEventId: event.id } });
    const paid = await tx.refund.updateMany({ where: { id: refund.id, status: "APPROVED" }, data: { status: "PAID", paidAt: now } });
    if (paid.count !== 1) throw new RefundError("The refund changed just now; reload.");
    await writeAudit(tx, { action: "voucher.refund.verify", entityType: "Voucher", entityId: voucher.id, userId: actor.id, ipAddress: actor.ipAddress, evidenceRef: voucher.evidenceId, after: { refundId: refund.id, amount: refund.amount.toString(), ledgerEventId: event.id } });
    await tellMember(tx, refund.memberId, `refund.paid:${refund.id}`, "refund.paid", `your refund of ${ngn(refund.amount)} was paid to ${refund.beneficiaryBank} account ending ${refund.beneficiaryAccountNo.slice(-4)}.`);
  }, TX_OPTIONS);
}

/** The Finance Manager sends the voucher back; the refund stays approved for a new voucher. */
export async function returnRefundVoucher(db: Db, actor: RefundActor, voucherId: string, reason: string) {
  const why = reason.trim();
  if (why.length < 5) throw new RefundError("Say why the voucher is returned (the Cashier sees it).");
  const voucher = await preparedRefundVoucher(db, voucherId, actor);
  const { count } = await db.voucher.updateMany({ where: { id: voucher.id, status: "PREPARED" }, data: { status: "RETURNED", verifiedById: actor.id, verifiedAt: new Date(), returnReason: why } });
  if (count !== 1) throw new RefundError("This voucher was handled by someone else just now.");
  await writeAudit(db, { action: "voucher.refund.return", entityType: "Voucher", entityId: voucher.id, userId: actor.id, ipAddress: actor.ipAddress, after: { reason: why } });
}

/** Refunds for the staff page, newest first, with their latest voucher. */
export async function listRefunds(db: Db, take = 100) {
  return db.refund.findMany({
    orderBy: { requestedAt: "desc" },
    take,
    include: { member: { select: { fullName: true, memberNo: true } }, vouchers: { orderBy: { preparedAt: "desc" }, include: { bankAccount: true } } },
  });
}

/**
 * The member's Overpayment Credit history from the ledger: every credit and
 * refund with the running balance (PRD F12: the statement shows them).
 */
export async function creditMovements(db: Db, memberId: string) {
  const events = await db.ledgerEvent.findMany({
    where: { moduleEntityType: "Member", moduleEntityId: memberId, eventType: { in: ["DEPOSIT_CREDITED", "DEPOSIT_REFUNDED"] } },
    orderBy: [{ occurredAt: "asc" }, { postedAt: "asc" }],
  });
  let balance = 0n;
  return events.map((e) => {
    const change = e.eventType === "DEPOSIT_REFUNDED" ? -e.depositDelta : e.depositDelta;
    balance += change;
    const meta = e.metadata as { reason?: string; reclassificationId?: string; refundId?: string; loanAccountNo?: string };
    const what =
      e.eventType === "DEPOSIT_REFUNDED"
        ? e.reversesEventId
          ? "Refund reversed"
          : "Refund paid"
        : e.reversesEventId
          ? "Credit reversed (correction)"
          : meta.reclassificationId
            ? "Prepayment moved to credit at your request"
            : meta.reason
              ? `Payment credited (${meta.reason.toLowerCase()})`
              : "Overpayment after the loan was repaid";
    return { id: e.id, date: e.occurredAt.toISOString().slice(0, 10), what, change: kobo(change), balance: kobo(balance) };
  });
}
