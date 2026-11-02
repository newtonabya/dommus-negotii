/**
 * Money helper (PRD §5): all money is integer kobo held as `bigint`.
 * JS `number` is never used for money or rates.
 */

declare const koboBrand: unique symbol;

/** An amount in kobo (1/100 naira). */
export type Kobo = bigint & { readonly [koboBrand]: true };

/** A rate in basis points (1/100 of a percent). 7.5% = 750 bps. */
export type Bps = bigint & { readonly [koboBrand]: "bps" };

const BPS_DIVISOR = 10_000n;

export function kobo(value: bigint): Kobo {
  return value as Kobo;
}

export function bps(value: bigint): Bps {
  if (value < 0n) throw new RangeError("A rate cannot be negative");
  return value as Bps;
}

export const ZERO = kobo(0n);

export function add(...amounts: Kobo[]): Kobo {
  return kobo(amounts.reduce<bigint>((sum, a) => sum + a, 0n));
}

export function sub(a: Kobo, b: Kobo): Kobo {
  return kobo(a - b);
}

export function negate(a: Kobo): Kobo {
  return kobo(-a);
}

export function min(a: Kobo, b: Kobo): Kobo {
  return a < b ? a : b;
}

export function max(a: Kobo, b: Kobo): Kobo {
  return a > b ? a : b;
}

/**
 * Divides `numerator / denominator` rounding half away from zero
 * (half-up for the non-negative amounts the engine works with).
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("Denominator must be positive");
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const rounded = (abs * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}

/** `round_half_up(rate × amount)` to the kobo. */
export function applyRate(amount: Kobo, rate: Bps): Kobo {
  return kobo(divRoundHalfUp(amount * rate, BPS_DIVISOR));
}

/**
 * Splits `total` into `parts` equal amounts of `round_half_up(total / parts)`,
 * with the final part absorbing the rounding remainder so the sum is exact.
 */
export function spreadEvenly(total: Kobo, parts: number): Kobo[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError("parts must be a positive integer");
  }
  const each = kobo(divRoundHalfUp(total, BigInt(parts)));
  const result: Kobo[] = Array.from({ length: parts - 1 }, () => each);
  result.push(kobo(total - each * BigInt(parts - 1)));
  return result;
}

const NAIRA_PATTERN = /^(-)?₦?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;

/** Parses "141,250.00", "₦141,250", "-500.5" into kobo. Rejects anything else. */
export function parseNaira(text: string): Kobo {
  const match = NAIRA_PATTERN.exec(text.trim());
  if (!match) throw new SyntaxError(`Not a naira amount: "${text}"`);
  const [, sign, whole = "0", fraction = ""] = match;
  const value =
    BigInt(whole.replaceAll(",", "")) * 100n + BigInt(fraction.padEnd(2, "0"));
  return kobo(sign ? -value : value);
}

/** Formats kobo as en-NG naira, e.g. ₦141,250.00 or -₦500.50. */
export function formatNaira(amount: Kobo): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₦${whole}.${fraction}`;
}

/** JSON form: a string of kobo, since JSON has no bigint. */
export function toJSON(amount: Kobo): string {
  return amount.toString();
}

export function fromJSON(value: string): Kobo {
  if (!/^-?\d+$/.test(value)) throw new SyntaxError(`Not a kobo string: "${value}"`);
  return kobo(BigInt(value));
}
