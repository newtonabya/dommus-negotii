import type { BankLineCategory, PrismaClient } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db } from "@/lib/db";
import { daysBetween, localDate, todayInLagos, type LocalDate } from "@/lib/dates";
import { formatNaira, kobo } from "@/lib/money";
import { linkEvidence, storeEvidenceBytes } from "@/evidence/service";
import type { EvidenceStore } from "@/evidence/store";
import { postEvent } from "@/ledger/post";
import { writeAudit } from "@/shell/audit/audit";
import { ForbiddenError } from "@/shell/rbac/permissions";
import { refreshScheduleException } from "../reconciliation/reconciliation";
import { BankError, type BankActor, type UploadedFile } from "./statements";
import { ngn, tellStaff } from "../notices";

/** A credit and its lodgement, or a debit and its voucher, must be within this many days (PRD F10). */
export const MATCH_WINDOW_DAYS = 3;

const naira = (v: bigint) => formatNaira(kobo(v));
const day = (d: Date) => localDate(d.toISOString().slice(0, 10));
const within = (a: Date, b: Date) => Math.abs(daysBetween(day(a), day(b))) <= MATCH_WINDOW_DAYS;

async function openLine(db: Db, lineId: string, direction: "CREDIT" | "DEBIT") {
  const line = await db.bankStatementLine.findUnique({ where: { id: lineId }, include: { tag: true, entry: true, statement: { select: { evidenceId: true } } } });
  if (!line) throw new BankError("Statement line not found.");
  if (line.direction !== direction) throw new BankError(`That line is a ${line.direction.toLowerCase()}, not a ${direction.toLowerCase()}.`);
  if (line.lodgementId || line.voucherId || line.tag || (line.entry && line.entry.status !== "RETURNED")) throw new BankError("That statement line is already matched.");
  return line;
}

// ───────────────────────────── Credits ↔ lodgements ─────────────────────────────

/** Lodgements a credit could be: unverified, same account, same amount, within ±3 days. The system proposes; a person decides. */
export async function proposeLodgements(db: Db, line: { bankAccountId: string; amount: bigint; transactionDate: Date; reference: string }) {
  const candidates = await db.lodgement.findMany({
    where: { bankAccountId: line.bankAccountId, amount: line.amount, status: "UNVERIFIED", statementLine: { is: null } },
    include: { schedule: { select: { scheduleReference: true, remittanceSource: { select: { code: true } } } } },
  });
  const ref = line.reference.toUpperCase();
  return candidates
    .filter((l) => within(l.depositDate, line.transactionDate))
    .map((l) => ({ ...l, sameReference: ref !== "" && l.reference.toUpperCase() === ref }))
    .sort((a, b) => Number(b.sameReference) - Number(a.sameReference));
}

/**
 * Finance Manager confirms a statement credit is a declared lodgement (PRD F10
 * steps 1–3): amount equal, date within ±3 days, reference checked by eye.
 * The lodgement becomes BANK_VERIFIED.
 */
export async function verifyLodgement(db: PrismaClient, actor: BankActor, lineId: string, lodgementId: string) {
  const line = await openLine(db, lineId, "CREDIT");
  const lodgement = await db.lodgement.findUnique({ where: { id: lodgementId }, include: { statementLine: true, schedule: { select: { evidenceId: true, scheduleReference: true } } } });
  if (!lodgement || lodgement.status !== "UNVERIFIED" || lodgement.statementLine) throw new BankError("That lodgement is not waiting for verification.");
  if (lodgement.bankAccountId !== line.bankAccountId) throw new BankError("The lodgement was declared for a different bank account.");
  if (lodgement.amount !== line.amount) throw new BankError(`Amounts differ: the credit is ${naira(line.amount)}, the lodgement ${naira(lodgement.amount)}.`);
  if (!within(lodgement.depositDate, line.transactionDate)) throw new BankError(`The dates are more than ${MATCH_WINDOW_DAYS} days apart.`);
  const now = new Date();
  await db.$transaction(async (tx) => {
    const { count } = await tx.lodgement.updateMany({ where: { id: lodgement.id, status: "UNVERIFIED" }, data: { status: "BANK_VERIFIED", verifiedById: actor.id, verifiedAt: now } });
    if (count !== 1) throw new BankError("That lodgement was verified by someone else just now.");
    await tx.bankStatementLine.update({ where: { id: line.id }, data: { lodgementId: lodgement.id, matchedById: actor.id, matchedAt: now } });
    await postEvent(tx, {
      occurredAt: line.transactionDate,
      moduleCode: "CREDIT",
      eventType: "LODGEMENT_BANK_VERIFIED",
      source: "BANK_STATEMENT",
      evidenceRefs: [line.statement.evidenceId, ...(lodgement.schedule ? [lodgement.schedule.evidenceId] : [])],
      portalUserId: actor.id,
      moduleEntityType: "Lodgement",
      moduleEntityId: lodgement.id,
      bankAccountId: lodgement.bankAccountId,
      uniquenessKey: `CREDIT:LODGEMENT_BANK_VERIFIED:${lodgement.id}`,
      metadata: { amount: lodgement.amount.toString(), lineId: line.id, reference: lodgement.reference, schedule: lodgement.schedule?.scheduleReference ?? null },
    });
    await writeAudit(tx, {
      action: "lodgement.verify",
      entityType: "Lodgement",
      entityId: lodgement.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: line.statement.evidenceId,
      after: { lineId: line.id, amount: lodgement.amount.toString() },
    });
  }, TX_OPTIONS);
  await tellStaff(db, ["CASHIER"], `lodgement.verified:${lodgement.id}`, "staff.lodgement.verified", "A lodgement is verified: record it", `Lodgement ${lodgement.reference} (${ngn(lodgement.amount)}) is verified at the bank and waits to be recorded.`, actor.id);
  // A later verification shrinks the schedule's shortfall (PRD F11); at zero it is ready to close.
  if (lodgement.scheduleId) await refreshScheduleException(db, lodgement.scheduleId);
}

/**
 * Cashier records and applies a BANK_VERIFIED lodgement to its schedule (PRD
 * F10 step 4): CASH_IN and LODGEMENT_APPLIED. Anything not BANK_VERIFIED is
 * refused with 403 and the attempt is audited (AT-f).
 */
export async function recordLodgement(db: PrismaClient, actor: BankActor, lodgementId: string) {
  const lodgement = await db.lodgement.findUnique({
    where: { id: lodgementId },
    include: { statementLine: { include: { statement: { select: { evidenceId: true } } } }, schedule: { select: { evidenceId: true, scheduleReference: true } } },
  });
  if (!lodgement) throw new BankError("Lodgement not found.");
  if (lodgement.status !== "BANK_VERIFIED" || !lodgement.statementLine || !lodgement.scheduleId) {
    await writeAudit(db, {
      action: "lodgement.record.blocked",
      entityType: "Lodgement",
      entityId: lodgement.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      after: { status: lodgement.status, reason: "not BANK_VERIFIED" },
    });
    throw new ForbiddenError(
      lodgement.status === "APPLIED" ? "This lodgement has already been recorded." : "Only lodgements the Finance Manager has verified against the bank statement can be recorded.",
    );
  }
  const line = lodgement.statementLine;
  const evidence = [line.statement.evidenceId, ...(lodgement.schedule ? [lodgement.schedule.evidenceId] : [])];
  const now = new Date();
  await db.$transaction(async (tx) => {
    const { count } = await tx.lodgement.updateMany({ where: { id: lodgement.id, status: "BANK_VERIFIED" }, data: { status: "APPLIED", appliedById: actor.id, appliedAt: now } });
    if (count !== 1) throw new BankError("This lodgement was recorded by someone else just now.");
    const { event } = await postEvent(tx, {
      occurredAt: line.transactionDate,
      moduleCode: "CREDIT",
      eventType: "CASH_IN",
      source: "BANK_STATEMENT",
      evidenceRefs: evidence,
      portalUserId: actor.id,
      moduleEntityType: "Lodgement",
      moduleEntityId: lodgement.id,
      bankAccountId: lodgement.bankAccountId,
      cashAmount: lodgement.amount,
      uniquenessKey: `CREDIT:CASH_IN:LODGEMENT:${lodgement.id}`,
      metadata: { lineId: line.id, scheduleId: lodgement.scheduleId, schedule: lodgement.schedule?.scheduleReference ?? null, reference: lodgement.reference },
    });
    await postEvent(tx, {
      occurredAt: line.transactionDate,
      moduleCode: "CREDIT",
      eventType: "LODGEMENT_APPLIED",
      source: "BANK_STATEMENT",
      evidenceRefs: evidence,
      portalUserId: actor.id,
      moduleEntityType: "Lodgement",
      moduleEntityId: lodgement.id,
      bankAccountId: lodgement.bankAccountId,
      uniquenessKey: `CREDIT:LODGEMENT_APPLIED:${lodgement.id}`,
      metadata: { amount: lodgement.amount.toString(), scheduleId: lodgement.scheduleId },
    });
    await tx.lodgement.update({ where: { id: lodgement.id }, data: { cashEventId: event.id } });
    await writeAudit(tx, {
      action: "lodgement.record",
      entityType: "Lodgement",
      entityId: lodgement.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: line.statement.evidenceId,
      after: { amount: lodgement.amount.toString(), cashEventId: event.id },
    });
  }, TX_OPTIONS);
}

// ───────────────────────────── Direct member payments ─────────────────────────────

/**
 * Finance Manager tags a statement credit to the member who paid it directly
 * (PRD F10). The tagged credit is BANK_VERIFIED; its reference goes on the
 * DIRECT row of the month's schedule as bank_credit_ref.
 */
export async function tagDirectPayment(
  db: PrismaClient,
  store: EvidenceStore,
  actor: BankActor,
  lineId: string,
  input: { member: string; note: string },
  receipt: UploadedFile | null,
) {
  const line = await openLine(db, lineId, "CREDIT");
  const key = input.member.trim().toUpperCase();
  if (!key) throw new BankError("Enter the member's number (MCS-…) or MOAUM ID.");
  const member = await db.member.findFirst({ where: { OR: [{ memberNo: key }, { moaumIdNumber: { equals: key, mode: "insensitive" } }] } });
  if (!member) throw new BankError(`No member ${key}.`);
  if (member.status !== "ACTIVE" && member.status !== "EXITED") throw new BankError(`${member.fullName} is not an active member.`);
  const file = receipt && receipt.bytes.length ? await storeEvidenceBytes(db, store, actor, receipt.filename, receipt.bytes) : null;
  const reference = `DP-${line.id.replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  const tag = await db.$transaction(async (tx) => {
    const created = await tx.directPaymentTag.create({
      data: { lineId: line.id, memberId: member.id, reference, evidenceId: file?.evidenceId ?? null, note: input.note.trim().slice(0, 300) || null, taggedById: actor.id },
    });
    await tx.bankStatementLine.update({ where: { id: line.id }, data: { matchedById: actor.id, matchedAt: new Date() } });
    if (file) await linkEvidence(tx, actor, { evidenceId: file.evidenceId, entityType: "DirectPaymentTag", entityId: created.id, kind: "PRIMARY", submissionKey: `DIRECT_PAYMENT_TAG:${created.id}` });
    await writeAudit(tx, {
      action: "bankCredit.tagMember",
      entityType: "DirectPaymentTag",
      entityId: created.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: file?.evidenceId ?? line.statement.evidenceId,
      after: { lineId: line.id, member: member.memberNo, amount: line.amount.toString(), reference },
    });
    return created;
  }, TX_OPTIONS);
  return { ...tag, member };
}

// ───────────────────────────── Debits ↔ vouchers ─────────────────────────────

export async function proposeVouchers(db: Db, line: { bankAccountId: string; amount: bigint; transactionDate: Date }) {
  const candidates = await db.voucher.findMany({
    where: { bankAccountId: line.bankAccountId, amount: line.amount, status: "VERIFIED", statementLine: { is: null } },
    include: { loan: { select: { loanAccountNo: true } } },
  });
  return candidates.filter((v) => within(v.valueDate, line.transactionDate));
}

/** Finance Manager matches a statement debit to a verified voucher (amount equal, ±3 days, reference). */
export async function matchVoucher(db: PrismaClient, actor: BankActor, lineId: string, voucherId: string) {
  const line = await openLine(db, lineId, "DEBIT");
  const voucher = await db.voucher.findUnique({ where: { id: voucherId }, include: { statementLine: true } });
  if (!voucher || voucher.status !== "VERIFIED" || voucher.statementLine) throw new BankError("That voucher is not a verified, unmatched voucher.");
  if (voucher.bankAccountId !== line.bankAccountId) throw new BankError("The voucher was paid from a different bank account.");
  if (voucher.amount !== line.amount) throw new BankError(`Amounts differ: the debit is ${naira(line.amount)}, the voucher ${naira(voucher.amount)}.`);
  if (!within(voucher.valueDate, line.transactionDate)) throw new BankError(`The dates are more than ${MATCH_WINDOW_DAYS} days apart.`);
  await db.bankStatementLine.update({ where: { id: line.id }, data: { voucherId: voucher.id, matchedById: actor.id, matchedAt: new Date() } });
  await writeAudit(db, { action: "bankDebit.match", entityType: "Voucher", entityId: voucher.id, userId: actor.id, ipAddress: actor.ipAddress, after: { lineId: line.id, amount: voucher.amount.toString() } });
}

// ───────────────────────────── Bank line entries ─────────────────────────────

const CATEGORY_DIRECTION: Record<BankLineCategory, "CREDIT" | "DEBIT" | null> = { BANK_CHARGE: "DEBIT", BANK_INTEREST: "CREDIT", INTERNAL_TRANSFER: null };

/** Cashier records a bank charge, bank interest or internal transfer from a statement line (PRD F10). */
export async function recordBankLineEntry(db: Db, actor: BankActor, lineId: string, category: BankLineCategory, note: string) {
  if (!(category in CATEGORY_DIRECTION)) throw new BankError("Choose what the line is.");
  const line = await db.bankStatementLine.findUnique({ where: { id: lineId }, include: { tag: true, entry: true } });
  if (!line) throw new BankError("Statement line not found.");
  if (line.lodgementId || line.voucherId || line.tag || (line.entry && line.entry.status !== "RETURNED")) throw new BankError("That statement line is already matched.");
  const expected = CATEGORY_DIRECTION[category];
  if (expected && expected !== line.direction) throw new BankError(`A ${category === "BANK_CHARGE" ? "bank charge is a debit" : "bank interest line is a credit"}.`);
  const data = { category, note: note.trim().slice(0, 300) || null, status: "PREPARED" as const, recordedById: actor.id, recordedAt: new Date(), decidedById: null, decidedAt: null, returnReason: null };
  const entry = line.entry ? await db.bankLineEntry.update({ where: { id: line.entry.id }, data }) : await db.bankLineEntry.create({ data: { ...data, lineId } });
  await writeAudit(db, { action: "bankLineEntry.record", entityType: "BankLineEntry", entityId: entry.id, userId: actor.id, ipAddress: actor.ipAddress, after: { lineId, category, amount: line.amount.toString() } });
  await tellStaff(db, ["FINANCE_MANAGER"], `bankEntry.recorded:${entry.id}:${data.recordedAt.getTime()}`, "staff.bank_entry.recorded", "A bank entry waits for verification", `A bank statement entry of ${ngn(line.amount)} was recorded and waits for your verification.`, actor.id);
  return entry;
}

async function preparedEntry(db: Db, id: string, actor: BankActor) {
  const entry = await db.bankLineEntry.findUnique({ where: { id }, include: { line: { include: { statement: { select: { evidenceId: true } } } } } });
  if (!entry) throw new BankError("Entry not found.");
  if (entry.status !== "PREPARED") throw new BankError("This entry has already been decided.");
  if (entry.recordedById === actor.id) throw new BankError("Someone else must verify an entry you recorded.");
  return entry;
}

/** Finance Manager verifies it: CASH_OUT or CASH_IN (source BANK_STATEMENT, metadata.category). Never module revenue. */
export async function verifyBankLineEntry(db: PrismaClient, actor: BankActor, id: string) {
  const entry = await preparedEntry(db, id, actor);
  const line = entry.line;
  await db.$transaction(async (tx) => {
    const { count } = await tx.bankLineEntry.updateMany({ where: { id, status: "PREPARED" }, data: { status: "VERIFIED", decidedById: actor.id, decidedAt: new Date() } });
    if (count !== 1) throw new BankError("This entry was decided by someone else just now.");
    const { event } = await postEvent(tx, {
      occurredAt: line.transactionDate,
      moduleCode: "CREDIT",
      eventType: line.direction === "CREDIT" ? "CASH_IN" : "CASH_OUT",
      source: "BANK_STATEMENT",
      evidenceRefs: [line.statement.evidenceId],
      portalUserId: actor.id,
      moduleEntityType: "BankLineEntry",
      moduleEntityId: entry.id,
      bankAccountId: line.bankAccountId,
      cashAmount: line.amount,
      uniquenessKey: `CREDIT:BANK_LINE_ENTRY:${entry.id}`,
      metadata: { category: entry.category, lineId: line.id, narration: line.narration, note: entry.note },
    });
    await tx.bankLineEntry.update({ where: { id }, data: { ledgerEventId: event.id } });
    await writeAudit(tx, { action: "bankLineEntry.verify", entityType: "BankLineEntry", entityId: id, userId: actor.id, ipAddress: actor.ipAddress, after: { category: entry.category, ledgerEventId: event.id } });
  }, TX_OPTIONS);
}

export async function returnBankLineEntry(db: Db, actor: BankActor, id: string, reason: string) {
  const text = reason.trim();
  if (text.length < 5) throw new BankError("Say why it goes back.");
  await preparedEntry(db, id, actor);
  const { count } = await db.bankLineEntry.updateMany({ where: { id, status: "PREPARED" }, data: { status: "RETURNED", decidedById: actor.id, decidedAt: new Date(), returnReason: text } });
  if (count !== 1) throw new BankError("This entry was decided by someone else just now.");
  await writeAudit(db, { action: "bankLineEntry.return", entityType: "BankLineEntry", entityId: id, userId: actor.id, ipAddress: actor.ipAddress, after: { reason: text } });
}

// ───────────────────────────── Lists and ageing ─────────────────────────────

export const AGE_BUCKETS = ["0–30", "31–60", "61–90", "90+"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export function ageBucket(days: number): AgeBucket {
  return days <= 30 ? "0–30" : days <= 60 ? "31–60" : days <= 90 ? "61–90" : "90+";
}

/** Statement lines not yet matched to anything, credits and debits, with their proposals. */
export async function unmatchedLines(db: Db) {
  const lines = await db.bankStatementLine.findMany({
    where: { lodgementId: null, voucherId: null, tag: { is: null }, OR: [{ entry: { is: null } }, { entry: { status: "RETURNED" } }] },
    orderBy: { transactionDate: "asc" },
    include: { bankAccount: { select: { bankName: true, accountNumber: true } }, entry: true },
    take: 300,
  });
  return Promise.all(
    lines.map(async (l) => ({
      ...l,
      lodgements: l.direction === "CREDIT" ? await proposeLodgements(db, l) : [],
      vouchers: l.direction === "DEBIT" ? await proposeVouchers(db, l) : [],
    })),
  );
}

/**
 * Unapplied Bank Credits (no lodgement, no member tag, no entry) and
 * Unverified Lodgements, each with its age and bucket (PRD F10, AT-g).
 */
export async function ageingReport(db: Db, asOf: LocalDate = todayInLagos()) {
  const [credits, lodgements] = await Promise.all([
    db.bankStatementLine.findMany({
      where: { direction: "CREDIT", lodgementId: null, tag: { is: null }, OR: [{ entry: { is: null } }, { entry: { status: { not: "VERIFIED" } } }] },
      include: { bankAccount: { select: { bankName: true, accountNumber: true } } },
      orderBy: { transactionDate: "asc" },
    }),
    db.lodgement.findMany({
      where: { status: "UNVERIFIED" },
      include: { bankAccount: { select: { bankName: true, accountNumber: true } }, schedule: { select: { scheduleReference: true } } },
      orderBy: { depositDate: "asc" },
    }),
  ]);
  const aged = <T extends { amount: bigint }>(items: T[], dateOf: (t: T) => Date) => {
    const rows = items.map((t) => {
      const days = Math.max(0, daysBetween(day(dateOf(t)), asOf));
      return { ...t, days, bucket: ageBucket(days) };
    });
    const totals = Object.fromEntries(AGE_BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).reduce((s, r) => s + r.amount, 0n)])) as Record<AgeBucket, bigint>;
    return { rows, totals, total: rows.reduce((s, r) => s + r.amount, 0n) };
  };
  return { asOf, unappliedCredits: aged(credits, (c) => c.transactionDate), unverifiedLodgements: aged(lodgements, (l) => l.depositDate) };
}

/** BANK_VERIFIED lodgements waiting for the Cashier, and entries waiting for the Finance Manager. */
export async function cashierQueue(db: Db) {
  const [lodgements, entries] = await Promise.all([
    db.lodgement.findMany({
      where: { status: "BANK_VERIFIED" },
      include: { bankAccount: { select: { bankName: true, accountNumber: true } }, schedule: { select: { scheduleReference: true } }, statementLine: true },
      orderBy: { depositDate: "asc" },
    }),
    db.bankLineEntry.findMany({
      where: { status: { in: ["PREPARED", "RETURNED"] } },
      include: { line: { include: { bankAccount: { select: { bankName: true, accountNumber: true } } } } },
      orderBy: { recordedAt: "asc" },
    }),
  ]);
  return { lodgements, entries };
}

/** Direct-payment tags not yet on a posted schedule. */
export async function openTags(db: Db) {
  return db.directPaymentTag.findMany({
    where: { lodgementId: null },
    include: { line: true, member: { select: { fullName: true, memberNo: true, moaumIdNumber: true } } },
    orderBy: { taggedAt: "asc" },
  });
}
