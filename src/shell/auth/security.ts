import { sha256Hex } from "@/lib/hash";

/** PRD F1 account protection. */
export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_MINUTES = 15;
export const STAFF_IDLE_MINUTES = 30;
export const MEMBER_IDLE_MINUTES = 60;
export const MIN_PASSWORD_LENGTH = 10;

const MINUTE = 60_000;

export interface LockoutState {
  locked: boolean;
  /** When the lock ends, if locked. */
  until: Date | null;
}

/**
 * Locked when there have been at least 5 failed sign-ins for an identifier in
 * the last 15 minutes since its last successful password check. The lock lasts
 * 15 minutes from the most recent of those failures.
 */
export function lockoutState(failures: readonly Date[], lastSuccess: Date | null, now: Date): LockoutState {
  const windowStart = now.getTime() - LOCKOUT_MINUTES * MINUTE;
  const recent = failures
    .map((d) => d.getTime())
    .filter((t) => t > windowStart && (lastSuccess === null || t > lastSuccess.getTime()))
    .sort((a, b) => a - b);
  if (recent.length < LOCKOUT_MAX_FAILURES) return { locked: false, until: null };
  const latest = recent[recent.length - 1] as number;
  return { locked: true, until: new Date(latest + LOCKOUT_MINUTES * MINUTE) };
}

/** True when the last activity is older than the idle limit (PRD F1). */
export function isIdle(lastActivity: Date, now: Date, limitMinutes: number): boolean {
  return now.getTime() - lastActivity.getTime() > limitMinutes * MINUTE;
}

export function idleLimitMinutes(isStaff: boolean): number {
  return isStaff ? STAFF_IDLE_MINUTES : MEMBER_IDLE_MINUTES;
}

/** Client IP from proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(headers: Headers | undefined | null): string | null {
  if (!headers) return null;
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || headers.get("x-real-ip")?.trim() || null;
}

/** A stable, non-reversible device label for new-device alerts. */
export function deviceFingerprint(userAgent: string | null | undefined): string {
  return sha256Hex((userAgent ?? "unknown").trim().toLowerCase()).slice(0, 32);
}

export { describeDevice } from "./device";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export { normalizeNigerianPhone } from "./phone";
