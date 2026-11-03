import { z } from "zod";
import { normalizeNigerianPhone } from "@/shell/auth/phone";

/** PRD F5 invitation rules. Link lifetime and sending limits are settings (src/shell/settings). */
export const MAX_CODES_PER_INVITATION_PER_15_MIN = 3;
export const MAX_UPLOADS_PER_INVITATION = 5;

/** Bump when the consent wording changes; each member records the version they accepted. */
export const CONSENT_VERSION = "ndpa-2026-11-v1";

export const CONSENT_TEXT =
  "I consent to MOAUM Consultancy Services processing my personal data (name, phone, email, address, MOAUM ID card " +
  "number and scan, next of kin, remittance source, loans and repayments) to run my cooperative membership and loans, " +
  "as described in the Nigeria Data Protection Act 2023. I can ask for a copy of my data or for corrections at any time.";

export const phoneField = z.string().transform((value, ctx) => {
  const normalized = normalizeNigerianPhone(value);
  if (!normalized) {
    ctx.addIssue({ code: "custom", message: "Enter a Nigerian mobile number, e.g. 0803 123 4567." });
    return z.NEVER;
  }
  return normalized;
});

export const optionalEmail = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase())
  .pipe(z.union([z.literal(""), z.email({ message: "Enter a valid email address." })]))
  .transform((v) => (v === "" ? null : v));

export const invitationSchema = z.object({
  fullName: z.string().trim().min(3, "Enter the person's full name.").max(120),
  phone: phoneField,
  email: optionalEmail,
  remittanceSourceId: z
    .string()
    .transform((v) => (v === "" ? null : v))
    .pipe(z.uuid().nullable()),
});

export type InvitationInput = z.input<typeof invitationSchema>;

/** MOAUM ID card numbers: letters, digits and dashes, stored upper-case. */
export const moaumId = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9/-]{2,29}$/, "Enter the number exactly as printed on your MOAUM ID card.");

export const registrationSchema = z
  .object({
    fullName: z.string().trim().min(3, "Enter your full name.").max(120),
    email: optionalEmail,
    address: z.string().trim().min(10, "Enter your full address.").max(300),
    moaumIdNumber: moaumId,
    idScanEvidenceId: z.uuid({ message: "Upload a scan or photo of your MOAUM ID card." }),
    nextOfKinName: z.string().trim().min(3, "Enter your next of kin's full name.").max(120),
    nextOfKinPhone: phoneField,
    remittanceSourceId: z
      .string()
      .transform((v) => (v === "" || v === "NONE" ? null : v))
      .pipe(z.uuid().nullable()),
    password: z.string().min(10, "Use at least 10 characters.").max(128),
    confirmPassword: z.string(),
    consent: z.literal(true, { message: "You must accept the data protection notice to register." }),
  })
  .refine((v) => v.password === v.confirmPassword, { message: "The two passwords don't match.", path: ["confirmPassword"] });

export type RegistrationInput = z.input<typeof registrationSchema>;

export type InvitationState = "pending" | "opened" | "registered" | "expired" | "revoked";

/** Where an invitation stands right now. */
export function invitationState(
  inv: { expiresAt: Date; openedAt: Date | null; registeredAt: Date | null; revokedAt: Date | null },
  now: Date = new Date(),
): InvitationState {
  if (inv.registeredAt) return "registered";
  if (inv.revokedAt) return "revoked";
  if (inv.expiresAt.getTime() <= now.getTime()) return "expired";
  return inv.openedAt ? "opened" : "pending";
}

export function isUsable(state: InvitationState): boolean {
  return state === "pending" || state === "opened";
}

/** Placeholder login email for members who give none (the login table requires one). */
export function placeholderEmail(e164Phone: string): string {
  return `${e164Phone.replace("+", "")}@members.dommus.invalid`;
}
