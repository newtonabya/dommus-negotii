import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { localDate, todayInLagos, type LocalDate } from "@/lib/dates";
import { formatNaira, kobo } from "@/lib/money";
import { DRILL_TYPES, drillDown, type DrillType } from "@/modules/credit/reports/dashboard";
import { requireStaffPermission } from "@/shell/auth/session";

export const metadata: Metadata = { title: "Transactions" };

const naira = (v: bigint) => formatNaira(kobo(v));
const LABEL: Record<DrillType, string> = {
  CASH_IN: "Verified money in",
  CASH_OUT: "Verified money out",
  OPENING_BALANCE: "Opening balances",
  INTEREST_INCOME: "Interest income",
  BANK_INTEREST: "Other bank credits (bank interest)",
  REVENUE: "Revenue earned",
};

function dateParam(value: string | string[] | undefined, fallback: LocalDate): LocalDate {
  try {
    return typeof value === "string" ? localDate(value) : fallback;
  } catch {
    return fallback;
  }
}

export default async function DrillDownPage({ searchParams }: PageProps<"/staff/dashboard/ledger">) {
  await requireStaffPermission("dashboard.gmd.read");
  const q = await searchParams;
  const type = (DRILL_TYPES as readonly string[]).includes(String(q.type)) ? (q.type as DrillType) : "CASH_IN";
  const today = todayInLagos();
  const from = dateParam(q.from, localDate(`${today.slice(0, 7)}-01`));
  const to = dateParam(q.to, today);
  const account = typeof q.account === "string" && /^[0-9a-f-]{36}$/i.test(q.account) ? q.account : null;
  const events = await drillDown(getDb(), { type, from, to, bankAccountId: account });
  const amountOf = (e: (typeof events)[number]) => (type === "REVENUE" || type === "INTEREST_INCOME" ? e.revenueAmount : e.cashAmount);
  const total = events.reduce((t, e) => t + amountOf(e), 0n);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/staff/dashboard" className="text-sm underline">
          ← Dashboard
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{LABEL[type]}</h1>
        <p className="text-sm text-muted">
          {from} to {to}
          {account ? " · one account" : ""} · {events.length} transaction(s){events.length === 300 ? " (first 300)" : ""} · total {naira(total)}. Reversals show as negative amounts.
        </p>
      </div>
      <Card>
        {events.length === 0 ? (
          <p className="text-sm text-muted">No transactions.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm tabular-nums">
              <thead className="text-xs text-muted uppercase">
                <tr>
                  <th className="py-1 pr-3">Date</th>
                  <th className="py-1 pr-3">Type · source</th>
                  <th className="py-1 pr-3">Record</th>
                  <th className="py-1 pr-3 text-right">Amount</th>
                  <th className="py-1">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-t border-border align-top">
                    <td className="py-1 pr-3">{e.occurredAt.toISOString().slice(0, 10)}</td>
                    <td className="py-1 pr-3">
                      {e.eventType.replaceAll("_", " ").toLowerCase()} · {e.source.replaceAll("_", " ").toLowerCase()}
                      {e.reversesEventId ? <span className="block text-xs text-muted">reversal</span> : null}
                    </td>
                    <td className="py-1 pr-3 text-xs">
                      {e.moduleEntityType} <span className="font-mono text-muted">{e.moduleEntityId.slice(0, 8)}</span>
                    </td>
                    <td className="py-1 pr-3 text-right">{naira(amountOf(e))}</td>
                    <td className="py-1">
                      {e.evidenceRefs.map((id, i) => (
                        <a key={id} className="mr-2 underline" href={`/api/v1/evidence/${id}`} target="_blank" rel="noopener">
                          file {i + 1}
                        </a>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
