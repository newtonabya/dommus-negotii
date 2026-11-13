import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { formatNaira, kobo } from "@/lib/money";
import { listSources } from "@/modules/credit/members/sources";
import { DeductionError, deductionSchedule, type DeductionSchedule } from "@/modules/credit/reports/deduction-schedule";
import { requireStaffPermission } from "@/shell/auth/session";

export const metadata: Metadata = { title: "Deduction schedule" };

const naira = (v: bigint) => formatNaira(kobo(v));

/** What the bursary should deduct, month by month, for one payroll source (Treasurer, Finance Manager). */
export default async function DeductionSchedulePage({ searchParams }: PageProps<"/staff/remittance/deductions">) {
  await requireStaffPermission("deductionSchedule.read");
  const q = await searchParams;
  const db = getDb();
  const sources = await listSources(db, true);
  const today = todayInLagos();
  const source = typeof q.source === "string" ? q.source : "";
  const month = typeof q.month === "string" && q.month ? q.month : today.slice(0, 7);

  let schedule: DeductionSchedule | null = null;
  let problem: string | null = null;
  if (source) {
    try {
      schedule = await deductionSchedule(db, source, month, today);
    } catch (error) {
      if (!(error instanceof DeductionError)) throw error;
      problem = error.message;
    }
  }
  const link = (format: "xlsx" | "pdf", scope: "all" | "month") => `/api/v1/deduction-schedule?source=${source}&month=${month}&scope=${scope}&format=${format}`;
  const firstMonthTotal = schedule ? schedule.members.reduce((t, m) => t + m.thisMonth, 0n) : 0n;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/staff/remittance" className="text-sm underline">
          ← Remittance
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Deduction schedule</h1>
        <p className="text-sm text-muted">
          What the payroll office should deduct from each member&apos;s salary. Amounts fall every month because interest is charged on the
          reducing balance, so each member has one line per month until their loans are cleared. Produce it again each month: it always
          starts from what has actually been paid.
        </p>
      </div>

      <Card title="Choose the payroll and the first month">
        <form method="get" className="flex flex-wrap items-end gap-4">
          <Field label="Payroll source">
            <Select name="source" required defaultValue={source}>
              <option value="" disabled>
                Choose…
              </option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="First month to deduct" hint="YYYY-MM">
            <Input name="month" required pattern="[0-9]{4}-[0-9]{2}" defaultValue={month} />
          </Field>
          <Button type="submit">Show schedule</Button>
        </form>
      </Card>

      {problem ? <Alert tone="error">{problem}</Alert> : null}

      {schedule ? (
        <>
          {schedule.missingStaffNo.length > 0 ? (
            <Alert tone="error">
              Left out because they have no payroll staff number: {schedule.missingStaffNo.join(", ")}. A Loan Officer records it on the member first.
            </Alert>
          ) : null}

          <Card title={`${schedule.source.name}: ${schedule.members.length} member(s), ${naira(firstMonthTotal)} for ${schedule.month}`}>
            {schedule.members.length === 0 ? (
              <p className="text-sm text-muted">No member on this payroll has a loan to deduct for.</p>
            ) : (
              <>
                <div className="mb-4 flex flex-wrap gap-3 text-sm">
                  <a className="underline" href={link("xlsx", "all")}>
                    Excel for the bursary: every remaining month
                  </a>
                  <a className="underline" href={link("xlsx", "month")}>
                    Excel: {schedule.month} only
                  </a>
                  <a className="underline" href={link("pdf", "all")}>
                    PDF: every remaining month
                  </a>
                  <a className="underline" href={link("pdf", "month")}>
                    PDF: {schedule.month} only
                  </a>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left text-sm tabular-nums">
                    <thead className="text-muted">
                      <tr>
                        <th className="py-2 pr-4 font-medium">Member</th>
                        <th className="py-2 pr-4 font-medium">Staff no.</th>
                        <th className="py-2 pr-4 font-medium">Loans</th>
                        <th className="py-2 pr-4 text-right font-medium">{schedule.month}</th>
                        <th className="py-2 pr-4 text-right font-medium">Still to deduct</th>
                        <th className="py-2 pr-4 font-medium">Last month</th>
                        <th className="py-2 font-medium">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schedule.members.map((m) => (
                        <tr key={m.memberId} className="border-t border-border align-top">
                          <td className="py-2 pr-4">{m.name}</td>
                          <td className="py-2 pr-4 font-mono">{m.staffNo}</td>
                          <td className="py-2 pr-4 font-mono text-xs">{m.loans.join(", ")}</td>
                          <td className="py-2 pr-4 text-right">{naira(m.thisMonth)}</td>
                          <td className="py-2 pr-4 text-right">{naira(m.total)}</td>
                          <td className="py-2 pr-4">{m.lastMonth}</td>
                          <td className="py-2">
                            {[m.isNew ? "New" : null, m.isFinal ? "Final deduction" : null, m.arrears > 0n ? `includes ${naira(m.arrears)} overdue` : null].filter(Boolean).join(" · ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-xs text-muted">
                  The file has the bursary&apos;s six columns only (SN, NAME, PNO, AMOUNT, STARTDATE, ENDDATE), one line per member per month. An
                  instalment is taken from the last salary before it falls due (salaries on day {schedule.payrollDay}; change it in Settings).
                </p>
              </>
            )}
          </Card>

          {schedule.stopped.length > 0 ? (
            <Card title={`Stop deducting (${schedule.stopped.length})`}>
              <p className="mb-2 text-sm text-muted">Loans cleared in the last two months. These members are no longer on the schedule.</p>
              <ul className="text-sm">
                {schedule.stopped.map((s) => (
                  <li key={s.loan}>
                    {s.name} <span className="font-mono">{s.staffNo}</span> · {s.loan} · cleared {s.closedOn}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
