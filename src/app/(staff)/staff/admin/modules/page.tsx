import type { Metadata } from "next";
import { Alert, Button, Input, Select } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { requireStaffPermission } from "@/shell/auth/session";
import { listModules, SHELL_MODULE } from "@/shell/registry/registry";
import { setModuleStatusAction } from "./actions";

export const metadata: Metadata = { title: "Modules" };

const STATUS_STYLE = {
  LIVE: "bg-success/10 text-success",
  DEGRADED: "bg-accent/10 text-accent",
  OFFLINE: "bg-danger/10 text-danger",
} as const;

const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });

export default async function ModulesPage({ searchParams }: PageProps<"/staff/admin/modules">) {
  await requireStaffPermission("modules.manage");
  const { ok, error } = await searchParams;
  const { modules, changes } = await listModules(getDb());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Modules</h1>
        <p className="text-sm text-muted">
          Each module registers its code and the ledger event types it emits; the ledger refuses anything else. Set a
          module to <strong>Degraded</strong> to warn staff, or <strong>Offline</strong> to pause its actions and ledger
          postings (pages stay readable). Every change is audited.
        </p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}

      {modules.map((m) => (
        <article key={m.code} className="rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-medium">
                {m.name} <span className="font-mono text-sm text-muted">{m.code}</span>
              </div>
              <div className="text-sm text-muted">
                Registered {when(m.registeredAt)} · {m.activeRoles} active role assignment{m.activeRoles === 1 ? "" : "s"} ·{" "}
                <a href={`/api/v1/modules/${m.code}/status`} className="underline" target="_blank" rel="noopener">
                  status endpoint
                </a>
              </div>
            </div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[m.status]}`}>{m.status}</span>
          </div>

          <div className="mt-3">
            <div className="text-xs font-medium text-muted uppercase">Ledger event types</div>
            {m.events.length === 0 ? (
              <p className="text-sm text-muted">None: this module posts nothing to the ledger.</p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-2">
                {m.events.map((e) => (
                  <li key={e.type} className="rounded border border-border bg-background px-2 py-0.5 font-mono text-xs">
                    {e.type} <span className="text-muted">· {e.posted.toLocaleString("en-NG")} posted</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {m.code !== SHELL_MODULE ? (
            <form action={setModuleStatusAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-4">
              <input type="hidden" name="code" value={m.code} />
              <Select name="status" defaultValue={m.status} aria-label="New status" className="w-36">
                <option value="LIVE">Live</option>
                <option value="DEGRADED">Degraded</option>
                <option value="OFFLINE">Offline</option>
              </Select>
              <Input name="reason" required minLength={5} placeholder="Reason (staff see it in the banner)" className="min-w-64 flex-1" />
              <Button type="submit" variant="secondary">
                Change status
              </Button>
            </form>
          ) : null}
        </article>
      ))}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Recent status changes</h2>
        {changes.length === 0 ? <p className="text-sm text-muted">None yet.</p> : null}
        <ul className="flex flex-col gap-1 text-sm">
          {changes.map((c) => (
            <li key={c.id}>
              {when(c.at)} · <span className="font-mono">{c.code}</span> {c.before} → <strong>{c.after.status}</strong> by {c.by}
              {c.after.reason ? <span className="text-muted"> — {c.after.reason}</span> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
