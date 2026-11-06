import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import { gmdDashboard, monthRange } from "@/modules/credit/reports/dashboard";
import { requireStaffPermission } from "@/shell/auth/session";

export const metadata: Metadata = { title: "GMD dashboard" };

const naira = (v: bigint) => formatNaira(kobo(v));
const MODULE_STATUS = { LIVE: "Live", DEGRADED: "Degraded", OFFLINE: "Offline" } as const;

function Figure({ label, value, href, note }: { label: string; value: string; href?: string; note?: string }) {
  const body = (
    <>
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {note ? <div className="text-xs text-muted">{note}</div> : null}
    </>
  );
  return href ? (
    <Link href={href as never} className="rounded-lg border border-border p-3 hover:border-accent">
      {body}
    </Link>
  ) : (
    <div className="rounded-lg border border-border p-3">{body}</div>
  );
}

export default async function GmdDashboardPage() {
  await requireStaffPermission("dashboard.gmd.read");
  const d = await gmdDashboard(getDb());
  const { from, to } = monthRange(d.month);
  const drill = (type: string, extra = "") => `/staff/dashboard/ledger?type=${type}&from=${from}&to=${to}${extra}`;
  const yearFrom = `${d.asOf.slice(0, 4)}-01-01`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">GMD dashboard</h1>
        <p className="text-sm text-muted">
          As at {d.asOf}, read from the ledger and bank records on every load. Recorded and bank-verified figures are shown
          separately. Select a figure to see the transactions and their evidence.
        </p>
      </div>

      <Card title="Cash position">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Figure label="Bank balances (latest statements)" value={naira(d.cash.statementTotal)} href="/staff/bank" />
          <Figure label="Cash per the ledger" value={naira(d.cash.ledgerTotal)} note="Opening balances + verified money in − out" />
          <Figure label={`Verified money in, ${d.month}`} value={naira(d.cash.cashInMonth)} href={drill("CASH_IN")} />
          <Figure label={`Verified money out, ${d.month}`} value={naira(d.cash.cashOutMonth)} href={drill("CASH_OUT")} />
          <Figure label="Unapplied Bank Credits" value={naira(d.cash.unappliedBankCredits)} href="/staff/bank/ageing" note="In the bank, not matched" />
          <Figure label="Unverified Lodgements" value={naira(d.cash.unverifiedLodgements)} href="/staff/bank/ageing" note="Declared, not yet seen at the bank" />
          <Figure label="Recorded, not yet paid" value={naira(d.cash.recordedNotYetPaid)} note="Schedules posted beyond verified lodgements" />
          <Figure label="Excess" value={naira(d.cash.excess)} note="Verified lodgements beyond schedules" />
        </div>
        {d.cash.accounts.length ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm tabular-nums">
              <thead className="text-xs text-muted uppercase">
                <tr>
                  <th className="py-1 pr-3">Account</th>
                  <th className="py-1 pr-3 text-right">Latest statement</th>
                  <th className="py-1 text-right">Ledger cash</th>
                </tr>
              </thead>
              <tbody>
                {d.cash.accounts.map((a) => (
                  <tr key={a.id} className="border-t border-border">
                    <td className="py-1 pr-3">{a.label}</td>
                    <td className="py-1 pr-3 text-right">{a.statementBalance === null ? "No statement yet" : `${naira(a.statementBalance)} (${a.statementDate})`}</td>
                    <td className="py-1 text-right">{naira(a.ledgerCash)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <Card title="Revenue earned">
        <p className="mb-3 text-sm text-muted">
          Interest income net of reversals. Principal recovered, opening balances, Overpayment Credits and bank interest are not revenue;
          bank interest is shown separately as Other bank credits.
        </p>
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          <Figure label={`Revenue, ${d.asOf.slice(0, 4)} to date`} value={naira(d.revenue.ytd)} href={`/staff/dashboard/ledger?type=REVENUE&from=${yearFrom}&to=${d.asOf}`} />
          <Figure label={`Revenue, ${d.month}`} value={naira(d.revenue.months.at(-1)?.amount ?? 0n)} href={drill("REVENUE")} />
          <Figure label={`Other bank credits, ${d.month}`} value={naira(d.cash.otherBankCreditsMonth)} href={drill("BANK_INTEREST")} note="Bank interest" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm tabular-nums">
            <thead className="text-xs text-muted uppercase">
              <tr>
                <th className="py-1 pr-3">Month</th>
                <th className="py-1 pr-3 text-right">Revenue</th>
                <th className="py-1 pr-3 text-right">Other bank credits</th>
                <th className="py-1 pr-3 text-right">Repayments recorded</th>
                <th className="py-1 text-right">Lodgements verified</th>
              </tr>
            </thead>
            <tbody>
              {d.revenue.months.map((m, i) => (
                <tr key={m.month} className="border-t border-border">
                  <td className="py-1 pr-3">{m.month}</td>
                  <td className="py-1 pr-3 text-right">{naira(m.amount)}</td>
                  <td className="py-1 pr-3 text-right">{naira(d.revenue.otherBankCredits[i]?.amount ?? 0n)}</td>
                  <td className="py-1 pr-3 text-right">{naira(d.trends.repayments[i]?.amount ?? 0n)}</td>
                  <td className="py-1 text-right">{naira(d.trends.lodged[i]?.amount ?? 0n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Track A: schedules against the bank">
        {d.cash.differences.length === 0 ? (
          <p className="text-sm text-muted">Every posted schedule is fully backed by bank-verified lodgements.</p>
        ) : (
          <>
            <p className="mb-2 text-sm text-muted">
              A positive difference is recorded but not yet paid; a negative one is excess. Shortfall and excess exceptions are
              raised by the monthly reconciliation (F11). Loan balances are never changed by these differences.
            </p>
            <ul className="text-sm tabular-nums">
              {d.cash.differences.map((s) => (
                <li key={s.id} className="flex flex-wrap justify-between gap-2 border-t border-border py-2 first:border-0">
                  <Link className="underline" href={`/staff/remittance/schedules/${s.id}`}>
                    {s.scheduleReference} · {s.source} {s.monthCovered}
                  </Link>
                  <span>
                    {naira(s.recorded)} recorded · {naira(s.paid)} verified ·{" "}
                    <strong className={s.difference > 0n ? "text-warning" : "text-accent"}>
                      {s.difference > 0n ? `${naira(s.difference)} not yet paid` : `${naira(-s.difference)} excess`}
                    </strong>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Credit Super Store">
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm tabular-nums">
            <dt className="text-muted">Active members</dt>
            <dd>{d.credit.activeMembers}</dd>
            <dt className="text-muted">Active loans</dt>
            <dd>{d.credit.activeLoans}</dd>
            <dt className="text-muted">Principal outstanding</dt>
            <dd>{naira(d.credit.outstandingPrincipal)}</dd>
            <dt className="text-muted">Disbursed this year</dt>
            <dd>{naira(d.credit.disbursedYtd)}</dd>
            <dt className="text-muted">Revenue this year</dt>
            <dd>{naira(d.credit.revenueYtd)}</dd>
            <dt className="text-muted">Overpayment Credits held</dt>
            <dd>{naira(d.credit.overpaymentCredits)}</dd>
          </dl>
          <p className="mt-2 text-xs text-muted">Credit is the only module in Phase 1; other modules join this table as they go live.</p>
        </Card>

        <Card title="Modules and exceptions">
          <ul className="mb-3 text-sm">
            {d.modules.map((m) => (
              <li key={m.code} className="flex justify-between border-t border-border py-1 first:border-0">
                <span>{m.name}</span>
                <span className={m.status === "LIVE" ? "text-success" : "font-semibold text-danger"}>{MODULE_STATUS[m.status]}</span>
              </li>
            ))}
          </ul>
          {d.exceptions.total === 0 ? (
            <p className="text-sm text-muted">No open exceptions.</p>
          ) : (
            <table className="w-full text-left text-sm tabular-nums">
              <thead className="text-xs text-muted uppercase">
                <tr>
                  <th className="py-1 pr-3">Open exceptions</th>
                  <th className="py-1 pr-3 text-right">Open</th>
                  <th className="py-1 pr-3 text-right">Under review</th>
                  <th className="py-1 text-right">Oldest (days)</th>
                </tr>
              </thead>
              <tbody>
                {d.exceptions.byType.map((e) => (
                  <tr key={e.type} className="border-t border-border">
                    <td className="py-1 pr-3">{e.type.replaceAll("_", " ").toLowerCase()}</td>
                    <td className="py-1 pr-3 text-right">{e.open}</td>
                    <td className="py-1 pr-3 text-right">{e.underReview}</td>
                    <td className="py-1 text-right">{e.oldestDays}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
