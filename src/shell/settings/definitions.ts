import { bps, type Bps } from "@/lib/money";
import { localDate, type LocalDate } from "@/lib/dates";

/**
 * Every setting the portal knows (PRD F2). Financial settings change money
 * outcomes, so a change needs Management approval and an effective date that
 * is not in the past. Operational settings take effect immediately.
 *
 * Values are stored as JSON: rates as a string of basis points ("750"),
 * dates as "YYYY-MM-DD", counts as numbers.
 */
interface Base {
  key: string;
  label: string;
  description: string;
  financial: boolean;
}

export interface RateSetting extends Base {
  kind: "rate";
  default: Bps;
  min: Bps;
  max: Bps;
}

export interface CountSetting extends Base {
  kind: "count";
  unit: string;
  default: number;
  min: number;
  max: number;
}

export interface DateSetting extends Base {
  kind: "date";
  /** null: not set yet. */
  default: LocalDate | null;
}

export type SettingDefinition = RateSetting | CountSetting | DateSetting;

export const SETTINGS = [
  {
    key: "interest_rate_bps",
    label: "Interest rate",
    description: "Monthly rate on the reducing balance (PRD F6). Applies to loans approved on or after its effective date; each loan keeps the rate it was approved at.",
    financial: true,
    kind: "rate",
    default: bps(750n),
    min: bps(1n),
    max: bps(5000n),
  },
  {
    key: "go_live_date",
    label: "Go-live date",
    description: "The cutover date at which legacy loan and bank opening balances are struck (PRD F8, F10).",
    financial: true,
    kind: "date",
    default: null,
  },
  {
    key: "reconciliation_window_days",
    label: "Reconciliation date window",
    description: "How many days either side of a declared date a bank line may fall and still match (PRD F11).",
    financial: true,
    kind: "count",
    unit: "days",
    default: 3,
    min: 0,
    max: 14,
  },
  {
    key: "max_open_loans_per_member",
    label: "Open loans per member",
    description: "The most loans a member may have open (submitted to active). Applies to applications submitted from its effective date (PRD F7).",
    financial: true,
    kind: "count",
    unit: "loans",
    default: 2,
    min: 1,
    max: 10,
  },
  {
    key: "max_open_guarantees_per_guarantor",
    label: "Open guarantees per guarantor",
    description: "The most open loans one person may guarantee (PRD F7).",
    financial: true,
    kind: "count",
    unit: "guarantees",
    default: 2,
    min: 1,
    max: 10,
  },
  {
    key: "invitation_ttl_days",
    label: "Invitation link lifetime",
    description: "How long a member invitation or activation link works (PRD F5).",
    financial: false,
    kind: "count",
    unit: "days",
    default: 7,
    min: 1,
    max: 30,
  },
  {
    key: "max_invites_per_sender_per_day",
    label: "Invitations per sender per day",
    description: "Limits SMS cost and abuse (PRD F5).",
    financial: false,
    kind: "count",
    unit: "invitations",
    default: 50,
    min: 1,
    max: 500,
  },
  {
    key: "max_invites_per_phone_per_week",
    label: "Invitations per phone number per week",
    description: "Stops one number being sent links over and over (PRD F5).",
    financial: false,
    kind: "count",
    unit: "invitations",
    default: 3,
    min: 1,
    max: 10,
  },
] as const satisfies readonly SettingDefinition[];

export type SettingKey = (typeof SETTINGS)[number]["key"];
export type RateKey = Extract<(typeof SETTINGS)[number], { kind: "rate" }>["key"];
export type CountKey = Extract<(typeof SETTINGS)[number], { kind: "count" }>["key"];
export type DateKey = Extract<(typeof SETTINGS)[number], { kind: "date" }>["key"];

export function definitionOf(key: string): SettingDefinition | undefined {
  return (SETTINGS as readonly SettingDefinition[]).find((s) => s.key === key);
}

/** "7.5" or "7.50%" → 750 bps. Up to two decimals; never goes through a float. */
export function parsePercent(text: string): Bps {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/.exec(text.trim());
  if (!match) throw new SyntaxError("Enter a percentage like 7.5");
  const [, whole = "0", fraction = ""] = match;
  return bps(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")));
}

/** 750 bps → "7.5%". */
export function formatPercent(rate: Bps): string {
  const whole = rate / 100n;
  const fraction = (rate % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}%`;
}

export type StoredValue = string | number | null;

/** Checks text typed into the settings form and returns the value to store, or a message. */
export function parseInput(def: SettingDefinition, text: string): { value: StoredValue } | { error: string } {
  const raw = text.trim();
  try {
    if (def.kind === "rate") {
      const rate = parsePercent(raw);
      if (rate < def.min || rate > def.max) {
        return { error: `${def.label} must be between ${formatPercent(def.min)} and ${formatPercent(def.max)}.` };
      }
      return { value: rate.toString() };
    }
    if (def.kind === "date") return { value: localDate(raw) };
    if (!/^\d{1,4}$/.test(raw)) return { error: `${def.label}: enter a whole number.` };
    const count = parseInt(raw, 10);
    if (count < def.min || count > def.max) return { error: `${def.label} must be between ${def.min} and ${def.max} ${def.unit}.` };
    return { value: count };
  } catch {
    return { error: def.kind === "date" ? `${def.label}: enter a date as YYYY-MM-DD.` : `${def.label}: enter a percentage like 7.5.` };
  }
}

/** A stored value as people read it: "7.5%", "3 days", "2027-01-01" or "Not set". */
export function formatValue(def: SettingDefinition, value: StoredValue): string {
  if (value === null) return "Not set";
  if (def.kind === "rate") return formatPercent(bps(BigInt(String(value))));
  if (def.kind === "count") return `${value} ${def.unit}`;
  return String(value);
}

/** The default in stored form. */
export function defaultValue(def: SettingDefinition): StoredValue {
  if (def.kind === "rate") return def.default.toString();
  return def.default;
}
