import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { formatNaira, kobo } from "@/lib/money";
import { listImportBatches } from "@/modules/credit/imports/batches";
import { listSchedules } from "@/modules/credit/remittance/schedules";
import { listAdvices } from "@/modules/credit/remittance/source-advice";
import { requireStaff } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import { redirect } from "next/navigation";
import { previewScheduleAction, uploadAdviceAction } from "./actions";

export const metadata: Metadata = { title: "Remittance" };

const naira = (v: bigint) => formatNaira(kobo(v));
const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
const ADVICE_STATUS = { AVAILABLE: "Waiting for its schedule", USED: "Matched", SUPERSEDED: "Superseded" } as const;
const FILE = "block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-accent/10 file:px-3 file:py-2 file:text-accent";

export default async function RemittancePage({ searchParams }: PageProps<"/staff/remittance">) {
  const user = await requireStaff();
  const canAdvice = hasPermission(user.assignments, "sourceAdvice.upload");
  const canSchedule = hasPermission(user.assignments, "schedule.upload");
  const canRead = hasPermission(user.assignments, "credit.read");
  if (!canAdvice && !canSchedule && !canRead) redirect("/forbidden");
  const { ok, error } = await searchParams;
  const db = getDb();
  const [sources, advices, schedules, drafts] = await Promise.all([
    db.remittanceSource.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    listAdvices(db),
    listSchedules(db),
    canSchedule ? listImportBatches(db, "REMITTANCE_SCHEDULE", 10) : Promise.resolve([]),
  ]);
  const replacedIds = new Set(advices.flatMap((a) => (a.supersedesId ? [a.supersedesId] : [])));
  const lastMonth = (() => {
    const t = todayInLagos();
    const y = parseInt(t.slice(0, 4), 10);
    const m = parseInt(t.slice(5, 7), 10);
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  })();
  const sourceOptions = sources.map((s) => (
    <option key={s.id} value={s.id}>
      {s.code} — {s.name}
    </option>
  ));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Remittance schedules</h1>
        <p className="text-sm text-muted">
          Payroll deductions, month by month. The Finance Manager first uploads the Source Advice obtained directly from
          the payroll source; the Treasurer then uploads the schedule, checks the dry run and posts it. A schedule whose
          payroll rows don&apos;t match its advice member by member is refused as a whole.
        </p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}

      {canAdvice ? (
        <Card title="Upload a Source Advice">
          <p className="mb-4 text-sm text-muted">
            Rows file: the payroll voucher exactly as it arrives (members are found by their STAFF NO, so record it on
            each member first), or one row per member with <code>member_moaum_id, member_name, amount</code> (
            <a className="underline" href="/api/v1/templates/source-advice.xlsx">
              Excel template
            </a>
            ,{" "}
            <a className="underline" href="/api/v1/templates/source-advice.csv">
              CSV
            </a>
            ). Attach the document exactly as the source sent it.
          </p>
          <form action={uploadAdviceAction} className="grid gap-4 sm:grid-cols-2">
            <Field label="Remittance source">
              <Select name="source" required defaultValue="">
                <option value="" disabled>
                  Choose…
                </option>
                {sourceOptions}
              </Select>
            </Field>
            <Field label="Month covered" hint="YYYY-MM">
              <Input name="month" required pattern="\d{4}-\d{2}" defaultValue={lastMonth} />
            </Field>
            <Field label="Advice reference" hint="As printed on the source's document">
              <Input name="reference" required minLength={2} maxLength={80} />
            </Field>
            <Field label="Control total (₦)">
              <Input name="controlTotal" required inputMode="decimal" placeholder="e.g. 1,250,000" />
            </Field>
            <Field label="Number of members">
              <Input name="rowCount" required inputMode="numeric" pattern="\d+" />
            </Field>
            <Field label="Rows file (.xlsx or .csv)" hint="The payroll voucher, or the advice template">
              <input type="file" name="rows" required accept=".xlsx,.csv" className={FILE} />
            </Field>
            <Field label="Original document from the source" hint="PDF, image or spreadsheet">
              <input type="file" name="document" required accept=".pdf,.jpg,.jpeg,.png,.xlsx,.csv" className={FILE} />
            </Field>
            <Field label="Replaces an earlier advice? (optional)" hint="When the source sends corrected figures">
              <Select name="supersedes" defaultValue="">
                <option value="">No — a new advice</option>
                {advices
                  .filter((a) => a.status !== "SUPERSEDED" && !replacedIds.has(a.id))
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.adviceReference} · {a.remittanceSource.code} {a.monthCovered}
                      {a.schedule ? ` (used by ${a.schedule.scheduleReference})` : ""}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Why it is replaced" hint="Required when replacing">
              <Input name="supersedeReason" maxLength={300} />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit">Save advice</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {canSchedule ? (
        <Card title="Upload a remittance schedule">
          <p className="mb-4 text-sm text-muted">
            Upload the payroll voucher exactly as it arrives; members are found by their STAFF NO. Or use the{" "}
            <a className="underline" href="/api/v1/templates/remittance-schedule.xlsx">
              schedule template
            </a>
            : a <strong>Rows</strong> sheet (one row per deduction) and a <strong>Lodgements</strong> sheet (money paid
            into MOAUM&apos;s bank for it; may be empty). You&apos;ll see a dry run before anything is posted.
          </p>
          <form action={previewScheduleAction} className="grid gap-4 sm:grid-cols-2">
            <Field label="Remittance source">
              <Select name="source" required defaultValue="">
                <option value="" disabled>
                  Choose…
                </option>
                {sourceOptions}
              </Select>
            </Field>
            <Field label="Month covered" hint="YYYY-MM">
              <Input name="month" required pattern="\d{4}-\d{2}" defaultValue={lastMonth} />
            </Field>
            <Field label="Schedule reference">
              <Input name="reference" required minLength={2} maxLength={80} />
            </Field>
            <Field label="Schedule type" hint="One REGULAR per source per month">
              <Select name="type" defaultValue="REGULAR">
                <option value="REGULAR">REGULAR</option>
                <option value="SUPPLEMENTARY">SUPPLEMENTARY</option>
              </Select>
            </Field>
            <Field label="Source Advice reference">
              <Select name="adviceReference" required defaultValue="">
                <option value="" disabled>
                  Choose…
                </option>
                {advices
                  .filter((a) => a.status === "AVAILABLE" && a.supersedes?.status !== "USED")
                  .map((a) => (
                    <option key={a.id} value={a.adviceReference}>
                      {a.adviceReference} · {a.remittanceSource.code} {a.monthCovered} · {naira(a.controlTotal)}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Submitted by" hint="Who sent the schedule">
              <Input name="submittedBy" required minLength={2} placeholder="e.g. Bursary, payroll unit" />
            </Field>
            <Field label="Control total (₦)">
              <Input name="controlTotal" required inputMode="decimal" />
            </Field>
            <Field label="Number of rows">
              <Input name="rowCount" required inputMode="numeric" pattern="\d+" />
            </Field>
            <Field label="Schedule file" hint="The payroll voucher as it arrives, or the template">
              <input type="file" name="file" required accept=".xlsx,.csv" className={FILE} />
            </Field>
            <Field label="Payment date" hint="For a payroll voucher (it has no dates): the day salaries were paid">
              <Input name="paymentDate" type="date" />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit">Check (dry run)</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {drafts.length > 0 ? (
        <Card title="Your recent dry runs">
          <ul className="text-sm">
            {drafts.map((b) => (
              <li key={b.id} className="flex flex-wrap justify-between gap-2 border-t border-border py-2 first:border-0">
                <Link className="underline" href={`/staff/remittance/batches/${b.id}`}>
                  {b.filename}
                </Link>
                <span className="text-muted">
                  {b.status === "PREVIEWED" ? (b.errorRowCount ? "Has errors" : "Ready to post") : b.status === "COMMITTED" ? "Posted" : "Rejected"} ·{" "}
                  {when(b.uploadedAt)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Posted schedules</h2>
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[640px] text-left text-sm tabular-nums">
            <thead className="border-b border-border text-xs text-muted uppercase">
              <tr>
                <th className="px-4 py-3">Schedule</th>
                <th className="px-4 py-3">Source · month</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3">Rows</th>
                <th className="px-4 py-3">Posted</th>
              </tr>
            </thead>
            <tbody>
              {schedules.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted">
                    No schedules posted yet.
                  </td>
                </tr>
              ) : null}
              {schedules.map((s) => (
                <tr key={s.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <Link className="font-mono underline" href={`/staff/remittance/schedules/${s.id}`}>
                      {s.scheduleReference}
                    </Link>
                    <div className="text-xs text-muted">{s.type}</div>
                  </td>
                  <td className="px-4 py-3">
                    {s.remittanceSource.code} · {s.monthCovered}
                  </td>
                  <td className="px-4 py-3 text-right">{naira(s.controlTotal)}</td>
                  <td className="px-4 py-3">
                    {s._count.rows}
                    {s._count.lodgements ? <span className="text-muted"> · {s._count.lodgements} lodgement(s)</span> : null}
                  </td>
                  <td className="px-4 py-3">{when(s.postedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Source Advices</h2>
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[640px] text-left text-sm tabular-nums">
            <thead className="border-b border-border text-xs text-muted uppercase">
              <tr>
                <th className="px-4 py-3">Advice</th>
                <th className="px-4 py-3">Source · month</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3">Members</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {advices.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted">
                    No Source Advice uploaded yet.
                  </td>
                </tr>
              ) : null}
              {advices.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <a className="font-mono underline" href={`/api/v1/evidence/${a.evidenceId}`} target="_blank" rel="noopener">
                      {a.adviceReference}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    {a.remittanceSource.code} · {a.monthCovered}
                  </td>
                  <td className="px-4 py-3 text-right">{naira(a.controlTotal)}</td>
                  <td className="px-4 py-3">{a.rowCount}</td>
                  <td className="px-4 py-3">
                    {a.status === "AVAILABLE" && a.supersedes?.status === "USED" ? "Waiting for the schedule's correction" : ADVICE_STATUS[a.status]}
                    {a.schedule ? <div className="text-xs text-muted">by {a.schedule.scheduleReference}</div> : null}
                    {a.supersedes ? <div className="text-xs text-muted">replaces {a.supersedes.adviceReference}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
