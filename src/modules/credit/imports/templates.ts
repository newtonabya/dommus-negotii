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
];

export const TEMPLATES = {
  invitations: { title: "Invitations", columns: INVITATION_COLUMNS },
  members: { title: "Members", columns: MEMBER_COLUMNS },
} as const;

export type TemplateName = keyof typeof TEMPLATES;
