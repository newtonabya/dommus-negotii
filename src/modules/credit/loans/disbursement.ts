import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { TX_OPTIONS } from "@/lib/db";
import { compareDates, localDate, todayInLagos } from "@/lib/dates";
import { linkEvidence } from "@/evidence/service";
import { postEvent } from "@/ledger/post";
import { writeAudit } from "@/shell/audit/audit";
import { planSchedule } from "../domain/schedule";
import { assertNotOwnLoan, LoanError, loanTerms, moveLoan, toDbDate, type LoanActorUser } from "./common";

export interface VoucherInput {
  bankAccountId: string;
  valueDate: string;
  transferRef: string;
  beneficiaryName: string;
  beneficiaryBank: string;
  beneficiaryAccountNo: string;
  evidenceId: string;
}

/**
 * Cashier prepares the disbursement voucher (PRD F7): the full approved
 * amount, no deductions, with the transfer evidence and its value date.
 */
export async function prepareDisbursementVoucher(db: PrismaClient, actor: LoanActorUser, loanId: string, input: VoucherInput) {
  const loan = await db.loan.findUnique({ where: { id: loanId } });
  if (!loan) throw new LoanError("Loan not found.");
  await assertNotOwnLoan(db, loan, actor);
  if (loan.amountApproved === null) throw new LoanError("The loan has no approved amount.");
  const account = await db.bankAccount.findUnique({ where: { id: input.bankAccountId } });
  if (!account?.active) throw new LoanError("Choose the MOAUM bank account the money was paid from.");
  let valueDate;
  try {
    valueDate = localDate(input.valueDate.trim());
  } catch {
    throw new LoanError("Enter the transfer's value date.");
  }
  if (compareDates(valueDate, todayInLagos()) > 0) throw new LoanError("The value date can't be in the future: prepare the voucher after the transfer.");
  for (const [value, label] of [
    [input.transferRef, "transfer reference"],
    [input.beneficiaryName, "beneficiary name"],
    [input.beneficiaryBank, "beneficiary bank"],
  ] as const) {
    if (value.trim().length < 2) throw new LoanError(`Enter the ${label}.`);
  }
  if (!/^\d{10}$/.test(input.beneficiaryAccountNo.trim())) throw new LoanError("Enter the 10-digit beneficiary account number (NUBAN).");
  const upload = await db.evidenceUpload.findFirst({ where: { evidenceId: input.evidenceId, uploadedById: actor.id, finishedAt: { not: null } } });
  if (!upload) throw new LoanError("Upload the transfer evidence (bank confirmation or debit advice).");

  return db.$transaction(async (tx) => {
    let voucher;
    try {
      voucher = await tx.voucher.create({
        data: {
          type: "DISBURSEMENT",
          loanId,
          amount: loan.amountApproved!,
          valueDate: toDbDate(valueDate),
          bankAccountId: account.id,
          transferRef: input.transferRef.trim(),
          beneficiaryName: input.beneficiaryName.trim(),
          beneficiaryBank: input.beneficiaryBank.trim(),
          beneficiaryAccountNo: input.beneficiaryAccountNo.trim(),
          evidenceId: input.evidenceId,
          preparedById: actor.id,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new LoanError("A voucher for this loan is already waiting for verification.");
      }
      throw error;
    }
    await linkEvidence(tx, actor, { evidenceId: input.evidenceId, entityType: "Voucher", entityId: voucher.id, kind: "PRIMARY", submissionKey: `DISBURSEMENT_VOUCHER:${voucher.id}` });
    await moveLoan(tx, loan, "DISBURSEMENT_PENDING", "voucher.disbursement.prepare", actor, `Voucher ${voucher.transferRef} prepared`);
    return voucher;
  }, TX_OPTIONS);
}

async function preparedVoucher(db: PrismaClient, voucherId: string, actor: LoanActorUser) {
  const voucher = await db.voucher.findUnique({ where: { id: voucherId }, include: { loan: true } });
  if (!voucher || voucher.type !== "DISBURSEMENT" || !voucher.loan) throw new LoanError("Voucher not found.");
  if (voucher.status !== "PREPARED") throw new LoanError(`This voucher was already ${voucher.status.toLowerCase()}.`);
  if (voucher.preparedById === actor.id) throw new LoanError("You prepared this voucher, so someone else must verify it.");
  await assertNotOwnLoan(db, voucher.loan, actor);
  return voucher as typeof voucher & { loan: NonNullable<typeof voucher.loan> };
}

/**
 * Finance Manager verifies the voucher (PRD F7): CASH_OUT is posted, d0 is the
 * value date, the binding schedule is generated from the approved terms, and
 * the loan becomes ACTIVE, all in one transaction.
 */
export async function verifyDisbursementVoucher(db: PrismaClient, actor: LoanActorUser, voucherId: string) {
  const voucher = await preparedVoucher(db, voucherId, actor);
  const loan = voucher.loan;
  const valueDate = localDate(voucher.valueDate.toISOString().slice(0, 10));
  const terms = loanTerms({ ...loan, d0: voucher.valueDate });
  const schedule = planSchedule(terms);

  await db.$transaction(async (tx) => {
    const { count } = await tx.voucher.updateMany({
      where: { id: voucher.id, status: "PREPARED" },
      data: { status: "VERIFIED", verifiedById: actor.id, verifiedAt: new Date() },
    });
    if (count !== 1) throw new LoanError("This voucher was handled by someone else just now.");
    const { event } = await postEvent(tx, {
      occurredAt: voucher.valueDate,
      moduleCode: "CREDIT",
      eventType: "CASH_OUT",
      source: "DISBURSEMENT_VOUCHER",
      evidenceRefs: [voucher.evidenceId],
      portalUserId: actor.id,
      moduleEntityType: "Loan",
      moduleEntityId: loan.id,
      bankAccountId: voucher.bankAccountId,
      cashAmount: voucher.amount,
      principalAmount: voucher.amount,
      uniquenessKey: `disbursement:${voucher.id}`,
      metadata: { voucherId: voucher.id, loanAccountNo: loan.loanAccountNo, transferRef: voucher.transferRef },
    });
    await tx.voucher.update({ where: { id: voucher.id }, data: { ledgerEventId: event.id } });
    await moveLoan(tx, loan, "ACTIVE", "voucher.disbursement.verify", actor, `Disbursed on ${valueDate}`, {
      d0: voucher.valueDate,
      bindingSchedule: JSON.parse(JSON.stringify(schedule, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as Prisma.InputJsonValue,
    });
    await writeAudit(tx, {
      action: "voucher.verified",
      entityType: "Voucher",
      entityId: voucher.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: voucher.evidenceId,
      after: { loanId: loan.id, amount: voucher.amount.toString(), ledgerEventId: event.id },
    });
  }, TX_OPTIONS);
}

/** Finance Manager returns the voucher with a reason; the Cashier prepares a new one. */
export async function returnDisbursementVoucher(db: PrismaClient, actor: LoanActorUser, voucherId: string, reason: string) {
  const voucher = await preparedVoucher(db, voucherId, actor);
  const why = reason.trim();
  if (why.length < 5) throw new LoanError("Say why the voucher is returned (the Cashier sees it).");
  await db.$transaction(async (tx) => {
    const { count } = await tx.voucher.updateMany({
      where: { id: voucher.id, status: "PREPARED" },
      data: { status: "RETURNED", verifiedById: actor.id, verifiedAt: new Date(), returnReason: why },
    });
    if (count !== 1) throw new LoanError("This voucher was handled by someone else just now.");
    await moveLoan(tx, voucher.loan, "APPROVED", "voucher.disbursement.verify", actor, `Voucher returned: ${why}`);
  }, TX_OPTIONS);
}
