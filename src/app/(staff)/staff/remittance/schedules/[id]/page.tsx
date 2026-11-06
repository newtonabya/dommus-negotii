import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { formatNaira, kobo } from "@/lib/money";
import { scheduleCorrections } from "@/modules/credit/remittance/corrections";
import { requireStaffPermission } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import { prepareCorrectionAction, returnCorrectionAction, verifyCorrectionAction } from "../../actions";

export const metadata: Metadata = { title: "Schedule" };

const naira = (v: bigint) => formatNaira(kobo(v));
const day = (d: Date) => d.toISOString().slice(0, 10);
const FILE = "block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-accent/10 file:px-3 file:py-2 file:text-accent";
const CORRECTION_STATUS = { PREPARED: "Waiting for the Finance Manager", VERIFIED: "Posted", RETURNED: "Returned" } as const;
const LODGEMENT = { UNVERIFIED: "Not yet verified", BANK_VERIFIED: "Verified at the bank", APPLIED: "Applied" } as const;

export default async function SchedulePage({ params, searchParams }: PageProps<"/staff/remittance/schedules/[id]">) {
  const user = await requireStaffPermission("credit.read");
  const { id } = await params;
  const { ok, error } = await searchParams;
  const db = getDb();
  const schedule = await db.remittanceSchedule.findUnique({
    where: { id },
    include: {
      remittanceSource: true,
      advice: { select: { adviceReference: true, evidenceId: true } },
      rows: {
        orderBy: { rowNo: "asc" },
        include: {
          member: { select: { fullName: true, moaumIdNumber: true } },
          loan: { select: { id: true, loanAccountNo: true, legacyAccountNo: true } },
        },
      },
      lodgements: { include: { bankAccount: true } },
    },
  });
  if (!schedule) notFound();
  const { corrections, pending } = await scheduleCorrections(db, schedule.id);
  const canPrepare = hasPermission(user.assignments, "correction.prepare") && schedule.uploadedById === user.id && !pending;
  const canVerify = hasPermission(user.assignments, "correction.verify") && pending !== null && pending.correction.preparedById !== user.id;
  const live = schedule.rows.filter((r) => r.reversedAt === null);
  const liveTotal = live.reduce((t, r) => t + r.amount, 0n);
  const appliedTo = (r: (typeof schedule.rows)[number]) =>
    r.loan && !r.toCredit ? (r.loan.loanAccountNo ?? r.loan.legacyAccountNo ?? "loan") : "Overpayment Credit";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/staff/remittance" className="text-sm underline">
          ← Remittance
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">
          Schedule <span className="font-mono">{schedule.scheduleReference}</span>
        </h1>
        <p className="text-sm text-muted">
          {schedule.remittanceSource.code} · {schedule.monthCovered} · {schedule.type} · {naira(schedule.controlTotal)} in {schedule.rowCount} rows ·
          advice{" "}
          <a className="underline" href={`/api/v1/evidence/${schedule.advice.evidenceId}`} target="_blank" rel="noopener">
            {schedule.advice.adviceReference}
          </a>{" "}
          ·{" "}
          <a className="underline" href={`/api/v1/evidence/${schedule.evidenceId}`} target="_blank" rel="noopener">
            schedule file
          </a>{" "}
          · posted {schedule.postedAt.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" })}
        </p>
        <p className="font-mono text-xs break-all text-muted">SHA-256 {schedule.checksum}</p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}
      {liveTotal !== schedule.controlTotal ? (
        <Alert tone="info">
          After corrections the live rows total {naira(liveTotal)} (posted as {naira(schedule.controlTotal)}).
        </Alert>
      ) : null}

      <Card title="Rows">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-sm tabular-nums">
            <thead className="text-xs text-muted uppercase">
              <tr>
                <th className="py-1 pr-3">Row</th>
                <th className="py-1 pr-3">Member</th>
                <th className="py-1 pr-3">Applied to</th>
                <th className="py-1 pr-3">Date</th>
                <th className="py-1 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {schedule.rows.map((r) => (
                <tr key={r.id} className={`border-t border-border align-top ${r.reversedAt ? "text-muted" : ""}`}>
                  <td className="py-1 pr-3">
                    {r.rowNo}
                    {r.reversedAt ? <span className="block text-xs">reversed</span> : null}
                    {r.correctionId ? <span className="block text-xs text-muted">added by correction</span> : null}
                  </td>
                  <td className={`py-1 pr-3 ${r.reversedAt ? "line-through" : ""}`}>
                    {r.member.fullName} <span className="font-mono text-xs text-muted">{r.member.moaumIdNumber}</span>
                  </td>
                  <td className={`py-1 pr-3 ${r.reversedAt ? "line-through" : ""}`}>
                    {r.loan && !r.toCredit ? (
                      <Link className="font-mono underline" href={`/staff/loans/${r.loan.id}`}>
                        {appliedTo(r)}
                      </Link>
                    ) : (
                      appliedTo(r)
                    )}
                  </td>
                  <td className="py-1 pr-3">{day(r.paymentDate)}</td>
                  <td className={`py-1 text-right ${r.reversedAt ? "line-through" : ""}`}>{naira(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {pending ? (
        <Card title="Correction waiting for verification">
          <p className="text-sm">
            <strong>Reason:</strong> {pending.correction.reason} ·{" "}
            <a className="underline" href={`/api/v1/evidence/${pending.correction.evidenceId}`} target="_blank" rel="noopener">
              document
            </a>
          </p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm tabular-nums">
            <dt className="text-muted">Rows reversed</dt>
            <dd>{pending.evaluation.reversed.length ? pending.evaluation.reversed.map((r) => `row ${r.rowNo} (${naira(r.amount)})`).join(", ") : "None"}</dd>
            <dt className="text-muted">Rows added</dt>
            <dd>
              {pending.evaluation.replacements.length
                ? pending.evaluation.replacements
                    .map((r) => `${r.data.memberName || r.data.moaumIdNumber}: ${naira(BigInt(r.data.amount))} to ${r.data.toCredit ? "Overpayment Credit" : (r.data.loanAccountNo ?? "loan")}`)
                    .join("; ")
                : "None"}
            </dd>
            <dt className="text-muted">Live total after</dt>
            <dd>{naira(pending.evaluation.totals.liveAfter)}</dd>
            <dt className="text-muted">Must match advice</dt>
            <dd>
              {pending.evaluation.advice.adviceReference}
              {pending.evaluation.advice.id !== schedule.adviceId ? " (the replacement advice; it takes over when this is verified)" : ""}
            </dd>
          </dl>
          {pending.evaluation.errors.length ? (
            <ul className="mt-3 list-disc pl-5 text-sm text-danger">
              {pending.evaluation.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm font-semibold text-success">✓ Every check passes as of now.</p>
          )}
          {canVerify ? (
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
              {pending.evaluation.errors.length === 0 ? (
                <form action={verifyCorrectionAction.bind(null, schedule.id, pending.correction.id)}>
                  <Button type="submit">Verify and post</Button>
                </form>
              ) : null}
              <form action={returnCorrectionAction.bind(null, schedule.id, pending.correction.id)} className="flex flex-1 flex-wrap gap-2">
                <Input name="comment" required minLength={5} placeholder="Why it goes back to the Treasurer" className="min-w-56 flex-1" />
                <Button type="submit" variant="danger">
                  Return
                </Button>
              </form>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">The Finance Manager verifies it; nothing changes until then.</p>
          )}
        </Card>
      ) : null}

      {canPrepare ? (
        <Card title="Prepare a correction">
          <p className="mb-3 text-sm text-muted">
            Tick the rows to reverse and, if needed, upload the replacement rows (the payroll voucher or the template&apos;s Rows sheet).
            Afterwards the schedule must still match its Source Advice. If the source&apos;s own figures were wrong, the Finance Manager
            first uploads the corrected advice as a replacement. Nothing is posted until the Finance Manager verifies it.
          </p>
          <form action={prepareCorrectionAction.bind(null, schedule.id)} className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-1 text-sm">
              <legend className="mb-1 font-medium">Rows to reverse</legend>
              {live.map((r) => (
                <label key={r.id} className="flex items-center gap-2">
                  <input type="checkbox" name="reverse" value={r.id} className="h-4 w-4" />
                  Row {r.rowNo}: {r.member.fullName} · {naira(r.amount)} · {appliedTo(r)}
                </label>
              ))}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Replacement rows (optional)" hint="Payroll voucher or template, .xlsx or .csv">
                <input type="file" name="replacements" accept=".xlsx,.csv" className={FILE} />
              </Field>
              <Field label="Payment date" hint="Only for a payroll voucher, which has no dates">
                <Input name="paymentDate" type="date" />
              </Field>
              <Field label="Reason">
                <Input name="reason" required minLength={10} maxLength={300} />
              </Field>
              <Field label="Document explaining it" hint="For example the payroll office's letter">
                <input type="file" name="evidence" required accept=".pdf,.jpg,.jpeg,.png,.xlsx,.csv" className={FILE} />
              </Field>
            </div>
            <div>
              <Button type="submit">Prepare correction</Button>
            </div>
          </form>
        </Card>
      ) : null}

      {corrections.length ? (
        <Card title="Corrections">
          <ul className="text-sm">
            {corrections.map((c) => (
              <li key={c.id} className="border-t border-border py-2 first:border-0">
                <strong>{CORRECTION_STATUS[c.status]}</strong> · {c.reason} · prepared by {c.preparedByName}
                {c.decidedByName ? ` · ${c.status === "RETURNED" ? "returned" : "verified"} by ${c.decidedByName}` : ""}
                {c.returnComment ? <div className="text-muted">Returned because: {c.returnComment}</div> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Lodgements">
        {schedule.lodgements.length === 0 ? (
          <p className="text-sm text-muted">None declared.</p>
        ) : (
          <ul className="text-sm tabular-nums">
            {schedule.lodgements.map((l) => (
              <li key={l.id} className="border-t border-border py-2 first:border-0">
                {l.bankAccount.bankName} {l.bankAccount.accountNumber} · {day(l.depositDate)} · {l.reference} · {naira(l.amount)} ·{" "}
                <span className="text-muted">{LODGEMENT[l.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
