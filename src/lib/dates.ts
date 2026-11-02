/**
 * Calendar dates in Africa/Lagos (PRD §5). Business dates are plain
 * `YYYY-MM-DD` values with no time or zone, so month logic never drifts.
 */

declare const localDateBrand: unique symbol;

export type LocalDate = string & { readonly [localDateBrand]: true };

export const TIME_ZONE = "Africa/Lagos";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Parts {
  year: number;
  month: number; // 1–12
  day: number;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function format({ year, month, day }: Parts): LocalDate {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${mm}-${dd}` as LocalDate;
}

function parts(date: LocalDate): Parts {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new SyntaxError(`Not a date: "${date}"`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function localDate(text: string): LocalDate {
  const match = DATE_PATTERN.exec(text);
  if (!match) throw new SyntaxError(`Not a YYYY-MM-DD date: "${text}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`Invalid date: "${text}"`);
  }
  return text as LocalDate;
}

/** Today's date in Lagos for the given instant. */
export function todayInLagos(now: Date = new Date()): LocalDate {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return localDate(formatted);
}

/** Negative if a < b, zero if equal, positive if a > b. */
export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const { year, month, day } = parts(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return format({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const a = parts(from);
  const b = parts(to);
  const ms = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000);
}

/**
 * Anniversary k of disbursement date d0 (PRD F6): d0's day of the month,
 * k months later, clamped to the last day of shorter months. Always anchored
 * to d0, so 31 Jan → 28/29 Feb → 31 Mar.
 */
export function anniversary(d0: LocalDate, k: number): LocalDate {
  if (!Number.isInteger(k) || k < 0) throw new RangeError("k must be a whole number ≥ 0");
  const { year, month, day } = parts(d0);
  const monthIndex = month - 1 + k;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = (monthIndex % 12) + 1;
  return format({
    year: targetYear,
    month: targetMonth,
    day: Math.min(day, daysInMonth(targetYear, targetMonth)),
  });
}

/**
 * The cycle a date belongs to (PRD F6). Cycle 1 is [d0, A1]; cycle k ≥ 2 is
 * (A(k−1), Ak]. A date on an anniversary belongs to the cycle ending that day.
 */
export function cycleOf(d0: LocalDate, date: LocalDate): number {
  if (compareDates(date, d0) < 0) {
    throw new RangeError(`${date} is before the disbursement date ${d0}`);
  }
  const start = parts(d0);
  const target = parts(date);
  let k = Math.max(1, (target.year - start.year) * 12 + (target.month - start.month));
  while (k > 1 && compareDates(date, anniversary(d0, k - 1)) <= 0) k -= 1;
  while (compareDates(date, anniversary(d0, k)) > 0) k += 1;
  return k;
}
