import { normalizeNigerianPhone } from "@/shell/auth/phone";

/**
 * A Nigerian mobile number in the form SMS gateways want: 2348031234567.
 * Accepts 0803…, 803…, +234803…, 234803… (spaces and dashes ignored).
 */
export function toMsisdn(input: string): string | null {
  const e164 = normalizeNigerianPhone(input);
  return e164 ? e164.slice(1) : null;
}

/** The friendly refusal shown or logged for a number that isn't a Nigerian mobile. */
export const INVALID_NUMBER = "That isn't a valid Nigerian mobile number. Use a number like 0803 123 4567.";
