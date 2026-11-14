import type { Db } from "@/lib/db";
import { PdfWriter } from "@/lib/pdf";
import { formatNaira, kobo } from "@/lib/money";
import { getCountSetting } from "@/shell/settings/settings";

/**
 * The guarantor form for a guarantor who is not a MOAUM member, printed by the
 * Loan Officer for the applicant to take to their guarantor. The signed form is
 * what the applicant (or the Loan Officer, for a paper application) uploads as
 * the guarantor form. A member guarantor needs no form: they accept by SMS link.
 */
export interface GuarantorFormApplicant {
  fullName: string;
  memberNo: string;
  pin: string | null;
  phone: string;
  loanNo: string | null;
  amount: bigint | null;
  tenure: number | null;
  purpose: string | null;
}

/** "+2348031234567" → "0803 123 4567". */
const localPhone = (e164: string) => (e164.startsWith("+234") ? `0${e164.slice(4, 7)} ${e164.slice(7, 10)} ${e164.slice(10)}` : e164);

export async function guarantorFormPdf(options: { applicant?: GuarantorFormApplicant | null; maxGuarantees?: number } = {}): Promise<Uint8Array> {
  const a = options.applicant ?? null;
  const max = options.maxGuarantees ?? 2;
  const pdf = await PdfWriter.create("Guarantor form", "MOAUM Credit Super Store · Guarantor form for a non-member");
  pdf.title(
    "Guarantor form",
    "For a guarantor who is not a member of MOAUM Credit Super Store. Fill it in clearly, sign it, and return it to the applicant, who hands it in with the loan application.",
  );

  pdf.heading("A. The applicant");
  pdf.fillIn([
    [{ label: "Full name", value: a?.fullName, width: 2 }, { label: "MOAUM number", value: a?.memberNo }],
    [{ label: "Payroll PIN (staff number)", value: a ? (a.pin ?? "None — pays directly") : undefined }, { label: "Phone", value: a ? localPhone(a.phone) : undefined }, { label: "Application number", value: a?.loanNo ?? undefined }],
    [{ label: "Loan amount applied for (₦)", value: a?.amount ? formatNaira(kobo(a.amount)) : undefined }, { label: "Repayment period (months)", value: a?.tenure ? String(a.tenure) : undefined }],
    [{ label: "Purpose of the loan", value: a?.purpose ?? undefined }],
  ]);

  pdf.heading("B. The guarantor");
  pdf.box("Affix a recent passport photograph", 84, 100);
  const inset = 100;
  pdf.fillIn(
    [
      [{ label: "Full name (surname first)" }],
      [{ label: "Phone (Nigerian mobile number)" }, { label: "Email (optional)" }],
      [{ label: "Home address" }],
    ],
    inset,
  );
  pdf.fillIn([
    [{ label: "Home address (continued)" }],
    [{ label: "Occupation" }, { label: "Employer or business" }],
    [{ label: "Relationship to the applicant" }, { label: "How many years they have known the applicant" }],
    [{ label: "Means of identification (e.g. NIN, voter's card, international passport)" }, { label: "ID number" }],
  ]);

  pdf.heading("C. The guarantor's undertaking");
  pdf.paragraph(
    "I, the guarantor named in Section B, confirm that I know the applicant named in Section A and agree to stand as guarantor for the loan described there, from MOAUM Credit Super Store. " +
      "I understand that if the applicant does not repay as agreed, MOAUM may contact me and look to me for what remains owed on the loan. " +
      `I confirm that the details I have given are true, and that I am not guarantor for more than ${max} open loans with MOAUM, including this one. ` +
      "I agree that MOAUM may keep and use these details to manage this loan, as allowed by the Nigeria Data Protection Act 2023.",
  );
  pdf.gap(4);
  pdf.fillIn([
    [{ label: "Guarantor's signature", width: 2 }, { label: "Date" }],
    [{ label: "Applicant's signature", width: 2 }, { label: "Date" }],
  ]);

  pdf.heading("D. Witness");
  pdf.fillIn([[{ label: "Witness's full name", width: 2 }, { label: "Witness's signature", width: 1.5 }, { label: "Date" }]]);

  pdf.heading("For MOAUM's use");
  pdf.fillIn([[{ label: "Received by (Loan Officer)", width: 2 }, { label: "Date received" }, { label: "Application number", value: a?.loanNo ?? undefined }]]);
  pdf.paragraph("You will also get an SMS link to confirm this guarantee: the loan is not paid until you accept. A guarantor who is a MOAUM member does not use this form.", 8, true);
  return pdf.bytes();
}

/** The form with the applicant's details from an application already filled in. */
export async function guarantorFormForLoan(db: Db, loanId: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(loanId)) return null;
  const loan = await db.loan.findUnique({ where: { id: loanId }, include: { member: { select: { fullName: true, memberNo: true, payrollStaffNo: true, phone: true } } } });
  if (!loan) return null;
  const bytes = await guarantorFormPdf({
    maxGuarantees: await getCountSetting(db, "max_open_guarantees_per_guarantor"),
    applicant: {
      fullName: loan.member.fullName,
      memberNo: loan.member.memberNo,
      pin: loan.member.payrollStaffNo,
      phone: loan.member.phone,
      loanNo: loan.loanAccountNo,
      amount: loan.amountRequested,
      tenure: loan.tenureRequested,
      purpose: loan.purpose,
    },
  });
  return { bytes, filename: `guarantor-form-${loan.loanAccountNo ?? "draft"}.pdf` };
}
