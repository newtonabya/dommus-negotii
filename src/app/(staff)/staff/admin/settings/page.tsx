import type { Metadata } from "next";
import { Alert, Button, Field, Input } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { requireStaffPermission } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import type { SettingDefinition } from "@/shell/settings/definitions";
import { settingsOverview } from "@/shell/settings/settings";
import { approveChangeAction, changeSettingAction, proposeChangeAction, rejectChangeAction, withdrawChangeAction } from "./actions";

export const metadata: Metadata = { title: "Settings" };

const STATUS_STYLE = {
  PENDING: "bg-accent/10 text-accent",
  APPROVED: "bg-success/10 text-success",
  REJECTED: "bg-danger/10 text-danger",
  WITHDRAWN: "bg-background text-muted",
} as const;

const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });

function ValueInput({ def }: { def: SettingDefinition }) {
  if (def.kind === "date") return <Input name="value" type="date" required />;
  if (def.kind === "rate") return <Input name="value" inputMode="decimal" required placeholder="e.g. 7.5" pattern="\d{1,3}(\.\d{1,2})?%?" />;
  return <Input name="value" type="number" required min={def.min} max={def.max} step={1} />;
}

export default async function SettingsPage({ searchParams }: PageProps<"/staff/admin/settings">) {
  const user = await requireStaffPermission("settings.read");
  const canChange = hasPermission(user.assignments, "settings.change");
  const canPropose = hasPermission(user.assignments, "settings.financial.propose");
  const canApprove = hasPermission(user.assignments, "settings.financial.approve");
  const { ok, error } = await searchParams;
  const { today, settings, history } = await settingsOverview(getDb());
  const financial = settings.filter((s) => s.def.financial);
  const operational = settings.filter((s) => !s.def.financial);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted">
          Financial settings change money outcomes: the Admin proposes a change with an effective date and a reason, and
          it has no effect until Management approves it. Effective dates can&apos;t be in the past. Operational settings
          take effect as soon as the Admin saves them. Every change is recorded in the audit trail.
        </p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Financial settings</h2>
        {financial.map((s) => (
          <article key={s.def.key} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-xl">
                <div className="font-medium">{s.def.label}</div>
                <p className="text-sm text-muted">{s.def.description}</p>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold">{s.current}</div>
                <div className="text-xs text-muted">{s.isDefault ? "PRD default" : `since ${s.since}`}</div>
              </div>
            </div>
            {s.upcoming.map((u) => (
              <p key={u.effectiveFrom} className="mt-2 text-sm">
                Approved: becomes <strong>{u.value}</strong> on {u.effectiveFrom}.
              </p>
            ))}

            {s.pending ? (
              <div className="mt-3 rounded-md border border-accent/40 bg-accent/5 p-3 text-sm">
                <p>
                  <strong>Waiting for Management:</strong> change to <strong>{s.pending.value}</strong> from{" "}
                  {s.pending.effectiveFrom}, proposed by {s.pending.proposedBy} on {when(s.pending.proposedAt)}.
                </p>
                <p className="mt-1 text-muted">Reason: {s.pending.reason}</p>
                {s.pending.overdue ? (
                  <p className="mt-1 text-danger">
                    The effective date has passed, so this can&apos;t be approved. Reject it, then propose again with a new date.
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  {canApprove && s.pending.proposedById !== user.id && !s.pending.overdue ? (
                    <form action={approveChangeAction} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="id" value={s.pending.id} />
                      <Input name="note" placeholder="Note (optional)" className="min-w-48" />
                      <Button type="submit">Approve</Button>
                    </form>
                  ) : null}
                  {canApprove && s.pending.proposedById !== user.id ? (
                    <form action={rejectChangeAction} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="id" value={s.pending.id} />
                      <Input name="note" required minLength={5} placeholder="Reason for rejecting" className="min-w-48" />
                      <Button type="submit" variant="danger">
                        Reject
                      </Button>
                    </form>
                  ) : null}
                  {s.pending.proposedById === user.id ? (
                    <form action={withdrawChangeAction}>
                      <input type="hidden" name="id" value={s.pending.id} />
                      <Button type="submit" variant="secondary">
                        Withdraw
                      </Button>
                    </form>
                  ) : null}
                </div>
              </div>
            ) : canPropose ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium text-accent">Propose a change</summary>
                <form action={proposeChangeAction} className="mt-3 grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="key" value={s.def.key} />
                  <Field label="New value" hint={s.def.kind === "rate" ? "Percent per month, e.g. 7.5" : undefined}>
                    <ValueInput def={s.def} />
                  </Field>
                  <Field label="Effective from" hint={`Today (${today}) or later.`}>
                    <Input name="effectiveFrom" type="date" required min={today} defaultValue={today} />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="Reason" hint="Management sees this. At least 10 characters.">
                      <Input name="reason" required minLength={10} />
                    </Field>
                  </div>
                  <div className="sm:col-span-2">
                    <Button type="submit">Send for approval</Button>
                  </div>
                </form>
              </details>
            ) : null}
          </article>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Operational settings</h2>
        {operational.map((s) => (
          <article key={s.def.key} className="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-border bg-surface p-4">
            <div className="max-w-xl">
              <div className="font-medium">{s.def.label}</div>
              <p className="text-sm text-muted">{s.def.description}</p>
              <p className="mt-1 text-sm">
                <strong>{s.current}</strong>{" "}
                <span className="text-muted">{s.isDefault ? "(PRD default)" : `(since ${s.since}, by ${s.changedBy})`}</span>
              </p>
            </div>
            {canChange ? (
              <form action={changeSettingAction} className="flex items-end gap-2">
                <input type="hidden" name="key" value={s.def.key} />
                <ValueInput def={s.def} />
                <Button type="submit" variant="secondary">
                  Save
                </Button>
              </form>
            ) : null}
          </article>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Recent proposals</h2>
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-border text-xs text-muted uppercase">
              <tr>
                <th className="px-4 py-3">Setting</th>
                <th className="px-4 py-3">Proposed</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Decision</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted">
                    No proposals yet.
                  </td>
                </tr>
              ) : null}
              {history.map((h) => (
                <tr key={h.id} className="border-b border-border align-top last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{h.label}</div>
                    <div className="text-xs text-muted">
                      {h.value} from {h.effectiveFrom}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>
                      {h.proposedBy}, {when(h.proposedAt)}
                    </div>
                    <div className="text-xs text-muted">{h.reason}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[h.status]}`}>{h.status}</span>
                  </td>
                  <td className="px-4 py-3">
                    {h.decidedAt && h.status !== "WITHDRAWN" ? (
                      <>
                        <div>
                          {h.decidedBy}, {when(h.decidedAt)}
                        </div>
                        {h.decisionNote ? <div className="text-xs text-muted">{h.decisionNote}</div> : null}
                      </>
                    ) : null}
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
