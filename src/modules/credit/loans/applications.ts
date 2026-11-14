import { z } from "zod";
import type { Member, PrismaClient } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { parseNaira } from "@/lib/money";
import { linkEvidence } from "@/evidence/service";
import { writeAudit } from "@/shell/audit/audit";
import { normalizeNigerianPhone } from "@/shell/auth/phone";
import { MAX_TENURE } from "../domain/schedule";
import { assertNotOwnLoan, assertWithinLimits, LoanError, moveLoan, nextLoanNumber, type GuarantorKey, type LoanActorUser } from "./common";
import { normalizeMemberNo } from "../members/rules";
import { requestGuarantee } from "./guarantee";

const amountField = z.string().transform((v, ctx) => {
  try {
    const amount = parseNaira(v.trim());
    if (amount > 0n) return amount;
  } catch {
    // fall through
  }
  ctx.addIssue({ code: "custom", message: "Enter the amount in naira, e.g. 150,000." });
  return z.NEVER;
});

const tenureField = z.coerce
  .number()
  .int("Tenure is a whole number of months.")
  .min(1, "Tenure is at least 1 month.")
  .max(MAX_TENURE, `Tenure is at most ${MAX_TENURE} months.`);

export const applicationSchema = z.object({
  amount: amountField,
  tenure: tenureField,
  purpose: z.string().trim().min(5, "Say briefly what the loan is for.").max(300),
  guarantorIsMember: z.boolean(),
  guarantorMoaumId: z.string().trim().toUpperCase().max(30).default(""),
  guarantorName: z.string().trim().max(120).default(""),
  guarantorPhone: z.string().trim().default(""),
  guarantorAddress: z.string().trim().min(10, "Enter the guarantor's full address.").max(300),
  guarantorRelationship: z.string().trim().min(3, "Say how the guarantor knows the applicant.").max(60),
  guarantorFormEvidenceId: z.string().trim().default(""),
});
export type ApplicationInput = z.input<typeof applicationSchema>;

/** What a member's record still lacks before they may apply for a loan (members brought in from MOAUM's records start with only a name, PIN and phone). */
export function missingForLoan(member: Pick<Member, "address" | "nextOfKinName" | "nextOfKinPhone" | "idScanEvidenceId">): string[] {
  return [
    member.address.trim() ? null : "home address",
    member.nextOfKinName.trim() ? null : "next of kin's name",
    member.nextOfKinPhone.trim() ? null : "next of kin's phone",
    member.idScanEvidenceId ? null : "ID card scan",
  ].filter((x): x is string => x !== null);
}

/** The applicant must be an active member with complete details (PRD F5). */
function assertCanBorrow(member: Member): void {
  if (member.status !== "ACTIVE") throw new LoanError("Only active members can apply for a loan.");
  const missing = missingForLoan(member);
  if (missing.length > 0) throw new LoanError(`Before a loan application, complete the member's details: ${missing.join(", ")}. Add them under My details.`);
}

/** Resolves the guarantor: a member by MOAUM ID (name and phone from their record) or a non-member. */
async function resolveGuarantor(db: Db, applicant: Member, data: z.output<typeof applicationSchema>) {
  if (data.guarantorIsMember) {
    if (!data.guarantorMoaumId) throw new LoanError("Enter the guarantor's MOAUM number or payroll PIN.");
    const key = normalizeMemberNo(data.guarantorMoaumId);
    const g = await db.member.findFirst({ where: { OR: [{ memberNo: key }, { payrollStaffNo: key }] }, orderBy: { createdAt: "asc" } });
    if (!g || g.status !== "ACTIVE") throw new LoanError("No active member has that MOAUM number or PIN.");
    if (g.id === applicant.id) throw new LoanError("You can't be your own guarantor.");
    return { memberId: g.id, moaumIdNumber: g.memberNo, fullName: g.fullName, phone: g.phone };
  }
  if (data.guarantorName.length < 3) throw new LoanError("Enter the guarantor's full name.");
  const phone = normalizeNigerianPhone(data.guarantorPhone);
  if (!phone) throw new LoanError("Enter the guarantor's Nigerian mobile number.");
  if (phone === applicant.phone) throw new LoanError("You can't be your own guarantor.");
  return { memberId: null, moaumIdNumber: null, fullName: data.guarantorName, phone };
}

/** The guarantor form must be a file this user uploaded. */
async function assertOwnUpload(db: Db, userId: string, evidenceId: string, what: string): Promise<void> {
  const upload = await db.evidenceUpload.findFirst({ where: { evidenceId, uploadedById: userId, finishedAt: { not: null } } });
  if (!upload) throw new LoanError(`Upload the ${what} again.`);
}

interface SaveResult {
  loanId: string;
  loanAccountNo: string | null;
}

/**
 * A member saves an application as a draft, or submits it. Submitting needs the
 * signed guarantor form, issues the loan number and checks the limits.
 */
export async function saveMemberApplication(
  db: PrismaClient,
  actor: LoanActorUser,
  input: ApplicationInput,
  submit: boolean,
  draftId?: string,
): Promise<SaveResult> {
  const member = await db.member.findUnique({ where: { userId: actor.id } });
  if (!member) throw new LoanError("No membership is linked to this login.");
  assertCanBorrow(member);
  const parsed = applicationSchema.safeParse(input);
  if (!parsed.success) throw new LoanError(parsed.error.issues[0]?.message ?? "Check the form.");
  const data = parsed.data;
  const guarantor = await resolveGuarantor(db, member, data);
  const formId = data.guarantorFormEvidenceId || null;
  if (formId) await assertOwnUpload(db, actor.id, formId, "signed guarantor form");
  // A member guarantor answers by SMS link; a non-member signs the paper form.
  if (submit && !formId && !guarantor.memberId) throw new LoanError("Upload the guarantor form, signed by your guarantor.");
  const today = todayInLagos();
  if (submit) await assertWithinLimits(db, draftId ?? null, member.id, guarantor satisfies GuarantorKey, today);

  const saved = await db.$transaction(async (tx) => {
    let loanId = draftId;
    const fields = { amountRequested: data.amount, tenureRequested: data.tenure, purpose: data.purpose };
    const guarantorRow = { ...guarantor, address: data.guarantorAddress, relationship: data.guarantorRelationship, formEvidenceId: formId };
    if (loanId) {
      const draft = await tx.loan.findUnique({ where: { id: loanId } });
      if (!draft || draft.memberId !== member.id || draft.status !== "DRAFT") throw new LoanError("This draft can no longer be changed.");
      await tx.loan.update({ where: { id: loanId }, data: fields });
      await tx.guarantor.upsert({ where: { loanId }, create: { loanId, ...guarantorRow }, update: guarantorRow });
    } else {
      const loan = await tx.loan.create({ data: { ...fields, memberId: member.id, createdById: actor.id } });
      loanId = loan.id;
      await tx.guarantor.create({ data: { loanId, ...guarantorRow } });
      await tx.loanTransition.create({ data: { loanId, fromStatus: null, toStatus: "DRAFT", byUserId: actor.id, comment: null } });
    }
    let loanAccountNo: string | null = null;
    if (submit) {
      loanAccountNo = await nextLoanNumber(tx, today);
      await moveLoan(tx, { id: loanId, status: "DRAFT" }, "SUBMITTED", "self.loan.apply", actor, null, { loanAccountNo });
      if (formId) {
        await linkEvidence(tx, actor, { evidenceId: formId, entityType: "Loan", entityId: loanId, kind: "PRIMARY", submissionKey: `LOAN_APPLICATION:${loanId}` });
      }
    }
    return { loanId, loanAccountNo };
  }, TX_OPTIONS);
  // Once the application is safely submitted, the member guarantor gets their link.
  if (submit && guarantor.memberId && !formId) await requestGuarantee(db, saved.loanId, actor.id).catch(() => false);
  return saved;
}

/**
 * A Loan Officer captures an application the member signed on paper (PRD F7):
 * created directly as SUBMITTED with the signed form as primary evidence.
 */
export async function captureAssistedApplication(
  db: PrismaClient,
  actor: LoanActorUser,
  memberId: string,
  input: ApplicationInput & { applicationFormEvidenceId: string },
): Promise<SaveResult> {
  const member = await db.member.findUnique({ where: { id: memberId } });
  if (!member) throw new LoanError("Member not found.");
  await assertNotOwnLoan(db, { memberId }, actor);
  assertCanBorrow(member);
  const parsed = applicationSchema.safeParse(input);
  if (!parsed.success) throw new LoanError(parsed.error.issues[0]?.message ?? "Check the form.");
  const data = parsed.data;
  const guarantor = await resolveGuarantor(db, member, data);
  if (!input.applicationFormEvidenceId) throw new LoanError("Upload the signed application form.");
  await assertOwnUpload(db, actor.id, input.applicationFormEvidenceId, "signed application form");
  if (!data.guarantorFormEvidenceId) throw new LoanError("Upload the signed guarantor form.");
  await assertOwnUpload(db, actor.id, data.guarantorFormEvidenceId, "signed guarantor form");
  const today = todayInLagos();
  await assertWithinLimits(db, null, member.id, guarantor, today);

  return db.$transaction(async (tx) => {
    const loanAccountNo = await nextLoanNumber(tx, today);
    const loan = await tx.loan.create({
      data: {
        memberId: member.id,
        status: "SUBMITTED",
        assisted: true,
        amountRequested: data.amount,
        tenureRequested: data.tenure,
        purpose: data.purpose,
        loanAccountNo,
        applicationEvidenceId: input.applicationFormEvidenceId,
        createdById: actor.id,
      },
    });
    await tx.guarantor.create({
      data: { loanId: loan.id, ...guarantor, address: data.guarantorAddress, relationship: data.guarantorRelationship, formEvidenceId: data.guarantorFormEvidenceId },
    });
    await tx.loanTransition.create({ data: { loanId: loan.id, fromStatus: null, toStatus: "SUBMITTED", byUserId: actor.id, comment: "Assisted application from a signed paper form" } });
    await writeAudit(tx, {
      action: "loan.submitted",
      entityType: "Loan",
      entityId: loan.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: input.applicationFormEvidenceId,
      after: { status: "SUBMITTED", assisted: true, loanAccountNo, amountRequested: data.amount.toString(), tenureRequested: data.tenure },
    });
    for (const evidenceId of [input.applicationFormEvidenceId, data.guarantorFormEvidenceId]) {
      await linkEvidence(tx, actor, { evidenceId, entityType: "Loan", entityId: loan.id, kind: "PRIMARY", submissionKey: `LOAN_APPLICATION:${loan.id}` });
    }
    return { loanId: loan.id, loanAccountNo };
  }, TX_OPTIONS);
}

/** The member cancels their own draft or submitted application. */
export async function cancelMemberApplication(db: Db, actor: LoanActorUser, loanId: string, comment: string): Promise<void> {
  const loan = await db.loan.findUnique({ where: { id: loanId }, include: { member: { select: { userId: true } } } });
  if (!loan || loan.member.userId !== actor.id) throw new LoanError("Loan not found.");
  await moveLoan(db, loan, "CANCELLED", "self.loan.apply", actor, comment.trim() || "Cancelled by the member");
}
