import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { addDays, localDate, todayInLagos } from "@/lib/dates";
import { formatNaira, kobo } from "@/lib/money";
import { monthOverview } from "@/modules/credit/reconciliation/close";
import { ITEM_LABEL, latestRun, readiness } from "@/modules/credit/reconciliation/reconciliation";
import { requireStaffPermission } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import { closeMonthAction, runReconciliationAction } from "./actions";

export const metadata: Metadata = { title: "Reconciliation" };

const naira = (v: string | bigint) => formatNaira(kobo(BigInt(v)));
const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });

export default async function ReconciliationPage({ searchParams }: PageProps<"/staff/reconciliation">) {
  const user = await requireStaffPermission("credit.read");
  const can = (a: Parameters<typeof hasPermission>[1]) => hasPermission(user.assignments, a);
  const q = await searchParams;
  const db = getDb();
  const lastMonth = addDays(localDate(`${todayInLagos().slice(0, 7)}-01`), -1).slice(0, 7);
  const month = typeof q.month === "string" && /^\d{4}-\d{2}$/.test(q.month) ? q.month : lastMonth;
  const [run, ready, overview] = await Promise.all([latestRun(db, month), readiness(db, month), monthOverview(db)]);
  const closed = overview.closes.find((c) => c.month === month);
  const r = run?.results;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Monthly reconciliation</h1>
        <p className="text-sm text-muted">
          Once every account&apos;s statements reach the month&apos;s end plus 3 days, the Finance Manager runs the reconciliation:
          each schedule against the bank (shortfall or excess against the source), every statement line against the records, and the
          bank balance against the ledger. Differences become exceptions; loan balances are never changed. Then the month is closed.
        </p>
      </div>
      {typeof q.ok === "string" ? <Alert tone="success">{q.ok}</Alert> : null}
      {typeof q.error === "string" ? <Alert tone="error">{q.error}</Alert> : null}

      <Card title="Month">
        <form className="flex flex-wrap items-end gap-3">
          <Field label="Month">
            <Input name="month" type="month" defaultValue={month} />
          </Field>
          <Button type="submit" variant="secondary">
            Show
          </Button>
        </form>
        <p className="mt-3 text-sm">
          {closed ? (
            <span className="font-semibold text-success">✓ Closed {when(closed.closedAt)}</span>
          ) : ready.missing.length ? (
            <span className="text-danger">Not ready: {ready.missing.join(" ")}</span>
          ) : (
            <span className="text-success">Statements cover {ready.needed}: ready to reconcile.</span>
          )}
          {overview.due ? <span className="block text-muted">Next month to close: {overview.due}.</span> : null}
        </p>
        {!closed && can("reconciliation.run") ? (
          <form action={runReconciliationAction} className="mt-3">
            <input type="hidden" name="month" value={month} />
            <Button type="submit">{run ? "Run again" : "Run reconciliation"}</Button>
          </form>
        ) : null}
      </Card>

      {r ? (
        <>
          <p className="text-sm text-muted">
            Last run {when(run.runAt)}: {r.exceptions.found} exception(s) found, {r.exceptions.raised} new, {r.exceptions.resolved} ready to close ·{" "}
            <Link className="underline" href="/staff/exceptions">
              exceptions
            </Link>
          </p>
          {r.accounts.map((a) => (
            <Card key={a.id} title={`Bank against ledger: ${a.label}, at ${r.end}`}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-sm tabular-nums">
                  <tbody>
                    <tr className="font-semibold">
                      <td className="py-1 pr-3">Statement balance</td>
                      <td className="py-1 text-right">{naira(a.bank)}</td>
                    </tr>
                    <tr className="border-t border-border">
                      <td className="py-1 pr-3">Ledger cash (opening + money in − money out)</td>
                      <td className="py-1 text-right">{naira(a.ledger)}</td>
                    </tr>
                    {a.items.map((i) => (
                      <tr key={i.ref} className="border-t border-border">
                        <td className="py-1 pr-3">
                          {ITEM_LABEL[i.kind]}: {i.label} <span className="text-muted">({i.date})</span>
                        </td>
                        <td className="py-1 text-right">{naira(i.amount)}</td>
                      </tr>
                    ))}
                    <tr className={`border-t-2 border-border font-semibold ${BigInt(a.residual) === 0n ? "text-success" : "text-danger"}`}>
                      <td className="py-1 pr-3">{BigInt(a.residual) === 0n ? "✓ Difference left" : "Difference left (raised as an exception)"}</td>
                      <td className="py-1 text-right">{naira(a.residual)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
          <Card title="Repayments against the bank (all schedules up to the month)">
            <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm tabular-nums">
              <dt className="text-muted">Repayments recorded</dt>
              <dd>{naira(r.trackA.recorded)}</dd>
              <dt className="text-muted">= Bank-verified lodgements</dt>
              <dd>{naira(r.trackA.verified)}</dd>
              <dt className="text-muted">+ Recorded, not yet paid</dt>
              <dd>{naira(r.trackA.notYetPaid)}</dd>
              <dt className="text-muted">− Excess</dt>
              <dd>{naira(r.trackA.excess)}</dd>
            </dl>
            <ul className="mt-3 text-sm tabular-nums">
              {r.trackA.schedules
                .filter((s) => BigInt(s.difference) !== 0n)
                .map((s) => (
                  <li key={s.id} className="border-t border-border py-1">
                    <Link className="underline" href={`/staff/remittance/schedules/${s.id}`}>
                      {s.reference}
                    </Link>{" "}
                    · {s.source} {s.monthCovered} · {BigInt(s.difference) > 0n ? `shortfall ${naira(s.difference)}` : `excess ${naira(-BigInt(s.difference))}`}
                  </li>
                ))}
            </ul>
          </Card>
          {!closed && can("month.close") ? (
            <Card title={`Close ${month}`}>
              <p className="mb-3 text-sm text-muted">
                Saves the month&apos;s reports as PDFs and its ledger totals. A closed month is never reopened; later postings dated inside it
                appear as prior-period adjustments. Months close in order{overview.due ? ` (next: ${overview.due})` : ""}.
              </p>
              <form action={closeMonthAction.bind(null, month)}>
                <Button type="submit">Close {month}</Button>
              </form>
            </Card>
          ) : null}
        </>
      ) : null}

      {overview.closes.length ? (
        <Card title="Closed months">
          <ul className="text-sm">
            {overview.closes.map((c) => (
              <li key={c.month} className="border-t border-border py-2 first:border-0">
                <strong>{c.month}</strong> · closed {when(c.closedAt)} ·{" "}
                {c.snapshots.map((s, i) => (
                  <span key={s.evidenceId}>
                    {i ? " · " : ""}
                    <a className="underline" href={`/api/v1/evidence/${s.evidenceId}`} target="_blank" rel="noopener">
                      {s.title}
                    </a>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
