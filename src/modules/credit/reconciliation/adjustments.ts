import type { Db } from "@/lib/db";
import type { LocalDate } from "@/lib/dates";
import { monthBounds } from "./reconciliation";

const toDb = (d: LocalDate) => new Date(`${d}T00:00:00Z`);

/**
 * Prior-period adjustments (PRD F11): ledger events dated inside a closed
 * month but posted after it closed. Optionally only those posted in a period.
 */
export async function priorPeriodAdjustments(db: Db, postedIn?: { from: LocalDate; to: LocalDate }) {
  const closes = await db.periodClose.findMany({ orderBy: { month: "asc" } });
  const out = [];
  for (const c of closes) {
    const { start, end } = monthBounds(c.month);
    const events = await db.ledgerEvent.findMany({
      where: {
        occurredAt: { gte: toDb(start), lte: toDb(end) },
        postedAt: { gt: c.closedAt, ...(postedIn ? { gte: toDb(postedIn.from), lte: new Date(`${postedIn.to}T23:59:59.999Z`) } : {}) },
      },
      orderBy: { postedAt: "asc" },
    });
    for (const e of events) out.push({ closedMonth: c.month, event: e });
  }
  return out;
}

