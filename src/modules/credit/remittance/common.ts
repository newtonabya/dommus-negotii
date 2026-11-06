import type { Db } from "@/lib/db";
import { formatNaira, kobo, parseNaira, type Kobo } from "@/lib/money";

/** Messages from this error are written for the user and safe to show. */
export class RemittanceError extends Error {
  constructor(
    message: string,
    /** Per-row or per-member reasons when a whole batch is refused. */
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "RemittanceError";
  }
}

export interface RemittanceActor {
  id: string;
  ipAddress: string | null;
}

/** Bulk postings write many rows and events in one transaction. */
export const REMITTANCE_TX = { maxWait: 15_000, timeout: 300_000 } as const;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseMonth(text: string): string {
  const value = text.trim();
  if (!MONTH.test(value)) throw new RemittanceError("Month covered: use the form YYYY-MM, e.g. 2026-10.");
  return value;
}

/** Last day of a YYYY-MM month as YYYY-MM-DD. */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map((n) => parseInt(n, 10)) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

/** A positive naira amount from a form or cell, or null with the reason. */
export function positiveAmount(text: string): { value: Kobo } | { error: string } {
  try {
    const value = parseNaira(text.replace(/\s/g, ""));
    if (value <= 0n) return { error: "must be more than ₦0" };
    return { value };
  } catch {
    return { error: `"${text}" is not a naira amount` };
  }
}

export function parseCount(text: string, label: string): number {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new RemittanceError(`${label}: enter a whole number of rows.`);
  return n;
}

export const naira = (v: bigint) => formatNaira(kobo(v));

/** The remittance source by its id or code (active only). */
export async function activeSource(db: Db, idOrCode: string) {
  const value = idOrCode.trim();
  const source = /^[0-9a-f-]{36}$/i.test(value)
    ? await db.remittanceSource.findUnique({ where: { id: value } })
    : await db.remittanceSource.findFirst({ where: { code: { equals: value, mode: "insensitive" } } });
  if (!source) throw new RemittanceError("Choose the remittance source.");
  if (!source.active) throw new RemittanceError(`${source.code} is switched off.`);
  return source;
}

export interface PayrollMember {
  id: string;
  fullName: string;
  status: "PENDING" | "ACTIVE" | "DECLINED" | "EXITED";
  moaumIdNumber: string;
  memberNo: string;
}

/**
 * Members named on a payroll file: by their staff number on this source's
 * payroll, or by the system member number (MCS-…) once payroll quotes it.
 * Keys are normalised (no spaces, upper case).
 */
export async function membersByPayrollKey(db: Db, remittanceSourceId: string, keys: string[]): Promise<Map<string, PayrollMember>> {
  const wanted = [...new Set(keys.filter(Boolean))];
  const result = new Map<string, PayrollMember>();
  if (wanted.length === 0) return result;
  const select = { id: true, fullName: true, status: true, moaumIdNumber: true, memberNo: true, payrollStaffNo: true } as const;
  const [byStaff, byNo] = await Promise.all([
    db.member.findMany({ where: { remittanceSourceId, payrollStaffNo: { in: wanted } }, select }),
    db.member.findMany({ where: { memberNo: { in: wanted } }, select }),
  ]);
  for (const m of byNo) result.set(m.memberNo, m);
  for (const m of byStaff) if (m.payrollStaffNo) result.set(m.payrollStaffNo, m);
  return result;
}
