import { STATEMENT_COLUMNS } from "../banking/statements";
import type { TemplateColumn } from "./table";

const SOURCE_NOTE =
  'Code of the member\'s remittance source as set up by Admin (e.g. PAYROLL-A), or NONE if they pay directly. Leave empty if unknown.';

export const INVITATION_COLUMNS: readonly TemplateColumn[] = [
  { name: "full_name", required: true, description: "Full name as on the MOAUM ID card." },
  { name: "phone", required: true, text: true, description: "Nigerian mobile number, e.g. 0803 123 4567. The invitation is sent here by SMS." },
  { name: "email", required: false, description: "Optional. A copy of the invitation is emailed here." },
  { name: "remittance_source_code", required: false, description: SOURCE_NOTE },
];

export const MEMBER_COLUMNS: readonly TemplateColumn[] = [
  { name: "full_name", required: true, description: "Full name as on the MOAUM ID card." },
  { name: "phone", required: true, text: true, description: "Nigerian mobile number. The activation link is sent here by SMS; it becomes the member's login." },
  { name: "email", required: false, description: "Optional email address." },
  { name: "address", required: true, description: "Home address." },
  { name: "moaum_id_number", required: true, text: true, description: "MOAUM ID card number, exactly as printed." },
  { name: "next_of_kin_name", required: true, description: "Next of kin's full name." },
  { name: "next_of_kin_phone", required: true, text: true, description: "Next of kin's Nigerian mobile number." },
  { name: "remittance_source_code", required: true, description: SOURCE_NOTE.replace(" Leave empty if unknown.", "") },
  {
    name: "payroll_staff_no",
    required: false,
    text: true,
    description: "The member's STAFF NO on that source's payroll, e.g. S03020. Required unless the source is NONE: payroll files are matched on it.",
  },
];

export const ADVICE_COLUMNS: readonly TemplateColumn[] = [
  { name: "member_moaum_id", required: true, text: true, description: "MOAUM ID card number of the member, exactly as printed." },
  { name: "member_name", required: true, description: "The member's name as the source wrote it." },
  { name: "amount", required: true, description: "Amount the source deducted for this member in naira, e.g. 25000 or 25,000.50. One row per member." },
];

export const SCHEDULE_ROW_COLUMNS: readonly TemplateColumn[] = [
  { name: "row_type", required: true, description: "PAYROLL (deducted by the source) or DIRECT (paid by the member into a MOAUM account and tagged by the Finance Manager)." },
  { name: "member_moaum_id", required: true, text: true, description: "MOAUM ID card number of the member." },
  { name: "member_name", required: true, description: "The member's name." },
  { name: "loan_account_no", required: false, text: true, description: "Loan number, e.g. CSS-2026-00012. May be blank if the member has at most one active loan." },
  { name: "amount_paid", required: true, description: "Amount in naira, more than 0." },
  { name: "payment_date", required: true, text: true, description: "Date deducted, as YYYY-MM-DD. Not after the end of the month covered." },
  { name: "period_covered", required: false, description: "Optional, for reference only." },
  { name: "receipt_no", required: false, text: true, description: "Optional receipt number." },
  { name: "bank_credit_ref", required: false, text: true, description: "DIRECT rows only: the reference of the tagged bank credit (DP-…), shown on the Bank matching page." },
  { name: "row_note", required: false, description: "Optional note." },
];

export const LODGEMENT_COLUMNS: readonly TemplateColumn[] = [
  { name: "bank_account", required: true, text: true, description: "MOAUM account number the money was paid into." },
  { name: "deposit_date", required: true, text: true, description: "Date of the deposit or transfer, as YYYY-MM-DD." },
  { name: "reference", required: true, text: true, description: "Slip number or transfer reference." },
  { name: "amount", required: true, description: "Amount in naira." },
  { name: "depositor", required: false, description: "Who paid it in." },
  { name: "note", required: false, description: "Optional note." },
];

export const TEMPLATES = {
  invitations: { title: "Invitations", columns: INVITATION_COLUMNS },
  members: { title: "Members", columns: MEMBER_COLUMNS },
  "source-advice": { title: "Advice", columns: ADVICE_COLUMNS },
  "bank-statement": { title: "Statement", columns: STATEMENT_COLUMNS },
  "remittance-schedule": { title: "Rows", columns: SCHEDULE_ROW_COLUMNS, extra: [{ title: "Lodgements", columns: LODGEMENT_COLUMNS }] },
} as const;

export type TemplateName = keyof typeof TEMPLATES;
