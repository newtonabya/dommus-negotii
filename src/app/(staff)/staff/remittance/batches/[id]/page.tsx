import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Button, Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import { loadSchedulePreview } from "@/modules/credit/remittance/schedules";
import { requireStaffPermission } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import { commitScheduleAction } from "../../actions";

export const metadata: Metadata = { title: "Schedule dry run" };

const naira = (v: string | bigint) => (v === "" ? "—" : formatNaira(kobo(BigInt(v))));

export default async function ScheduleDryRunPage({ params, searchParams }: PageProps<"/staff/remittance/batches/[id]">) {
  const user = await requireStaffPermission("schedule.upload");
  const { id } = await params;
  const { error } = await searchParams;
  const preview = await loadSchedulePreview(getDb(), id);
  if (!preview || preview.batch.uploadedById !== user.id) notFound();
  const { batch, stored, rows } = preview;
  const h = stored.header;
  const rowErrors = rows.filter((r) => r.errors.length > 0).length;
  const lodgementErrors = stored.lodgements.filter((l) => l.errors.length > 0).length;
  const clean = stored.batchErrors.length === 0 && rowErrors === 0 && lodgementErrors === 0;
  const canCommit = clean && batch.status === "PREVIEWED" && hasPermission(user.assignments, "schedule.commit");
  const difference = BigInt(stored.totals.lodged) - BigInt(stored.totals.payroll);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/staff/remittance" className="text-sm underline">
          ← Remittance
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">
          Dry run: <span className="font-mono">{h.scheduleReference}</span>
        </h1>
        <p className="text-sm text-muted">
          {h.sourceCode} · {h.monthCovered} · {h.type} · advice {h.adviceReference} · submitted by {h.submittedBy} · file{" "}
          <a className="underline" href={`/api/v1/evidence/${batch.evidenceId}`} target="_blank" rel="noopener">
            {batch.filename}
          </a>
        </p>
      </div>
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}
      {batch.status === "COMMITTED" ? <Alert tone="success">This schedule has been posted.</Alert> : null}
      {batch.status === "REJECTED" ? <Alert tone="error">This schedule was rejected at commit. Nothing was posted. Fix the file and upload it again.</Alert> : null}
      {batch.status === "PREVIEWED" && !clean ? (
        <Alert tone="error">
          Nothing can be posted: {stored.batchErrors.length ? `${stored.batchErrors.length} problem(s) with the schedule as a whole, ` : ""}
          {rowErrors} row(s) and {lodgementErrors} lodgement line(s) with errors. The whole batch is refused; fix the file and upload it again.
        </Alert>
      ) : null}

      {stored.batchErrors.length > 0 ? (
        <Card title="Problems with the schedule">
          <ul className="list-disc pl-5 text-sm text-danger">
            {stored.batchErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Totals">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm tabular-nums">
          <dt className="text-muted">Control total</dt>
          <dd>{naira(h.controlTotal)}</dd>
          <dt className="text-muted">Rows</dt>
          <dd>
            {naira(stored.totals.rows)} in {rows.length} rows (row count {h.rowCount})
          </dd>
          <dt className="text-muted">To Overpayment Credit</dt>
          <dd>{naira(stored.totals.credit)}</dd>
          <dt className="text-muted">Lodged at the bank</dt>
          <dd>
            {naira(stored.totals.lodged)}{" "}
            <span className="text-muted">
              ({difference === 0n ? "equal to the payroll total" : `${difference > 0n ? "more" : "less"} than payroll by ${naira(difference < 0n ? -difference : difference)}; reconciled later`})
            </span>
          </dd>
        </dl>
      </Card>

      <Card title="Source Advice match">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-sm tabular-nums">
            <thead className="text-xs text-muted uppercase">
              <tr>
                <th className="py-1 pr-3">Member</th>
                <th className="py-1 pr-3 text-right">Advice</th>
                <th className="py-1 pr-3 text-right">Schedule</th>
                <th className="py-1">Match</th>
              </tr>
            </thead>
            <tbody>
              {stored.adviceMatch.map((m) => (
                <tr key={m.moaumIdNumber} className="border-t border-border">
                  <td className="py-1 pr-3">
                    {m.name} <span className="font-mono text-xs text-muted">{m.moaumIdNumber}</span>
                  </td>
                  <td className="py-1 pr-3 text-right">{naira(m.advice)}</td>
                  <td className="py-1 pr-3 text-right">{naira(m.schedule)}</td>
                  <td className={`py-1 font-semibold ${m.ok ? "text-success" : "text-danger"}`}>{m.ok ? "✓ Matches" : "✗ Differs"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Rows">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm tabular-nums">
            <thead className="text-xs text-muted uppercase">
              <tr>
                <th className="py-1 pr-3">Row</th>
                <th className="py-1 pr-3">Member</th>
                <th className="py-1 pr-3">Loan</th>
                <th className="py-1 pr-3">Date</th>
                <th className="py-1 pr-3 text-right">Amount</th>
                <th className="py-1">Goes to</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rowNo} className="border-t border-border align-top">
                  <td className="py-1 pr-3">{r.rowNo}</td>
                  <td className="py-1 pr-3">
                    {r.raw.member_name}
                    <div className="font-mono text-xs text-muted">{r.raw.payroll_staff_no ? `staff no ${r.raw.payroll_staff_no}` : r.raw.member_moaum_id}</div>
                  </td>
                  <td className="py-1 pr-3 font-mono text-xs">{r.plan?.loanAccountNo ?? (r.raw.loan_account_no || "—")}</td>
                  <td className="py-1 pr-3">{r.raw.payment_date}</td>
                  <td className="py-1 pr-3 text-right">{r.plan ? naira(r.plan.amount) : r.raw.amount_paid}</td>
                  <td className="py-1">
                    {r.errors.length > 0 ? (
                      <ul className="text-danger">
                        {r.errors.map((e) => (
                          <li key={e}>✗ {e}</li>
                        ))}
                      </ul>
                    ) : r.plan?.toCredit ? (
                      <span>Overpayment Credit ({r.plan.creditReason})</span>
                    ) : r.plan?.split ? (
                      <span>
                        Interest {naira(r.plan.split.interest)} · principal {naira(r.plan.split.principal)}
                        {r.plan.split.credit !== "0" ? ` · credit ${naira(r.plan.split.credit)}` : ""}
                        {r.plan.split.earlierChanged ? <span className="block text-xs text-muted">Back-dated: re-spreads earlier payments on this loan.</span> : null}
                      </span>
                    ) : (
                      "Loan"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Lodgements">
        {stored.lodgements.length === 0 ? (
          <p className="text-sm text-muted">No lodgement lines: nothing paid into the bank for this schedule yet.</p>
        ) : (
          <ul className="text-sm tabular-nums">
            {stored.lodgements.map((l) => (
              <li key={l.rowNo} className="border-t border-border py-2 first:border-0">
                Row {l.rowNo}:{" "}
                {l.data ? `${l.data.accountLabel} · ${l.data.depositDate} · ${l.data.reference} · ${naira(l.data.amount)}` : null}
                {l.errors.map((e) => (
                  <div key={e} className="text-danger">
                    ✗ {e}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canCommit ? (
        <Card title="Post the schedule">
          <p className="mb-3 text-sm text-muted">
            Every check is run again when you post. Repayments are applied to the loans at once and members see them on
            their loan page. Lodgements are verified against the bank statement later.
          </p>
          <form action={commitScheduleAction.bind(null, batch.id)}>
            <Button type="submit">Post {rows.length} rows</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
