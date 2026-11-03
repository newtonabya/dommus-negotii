import type { Metadata } from "next";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { listSources } from "@/modules/credit/members/sources";
import { requireStaffPermission } from "@/shell/auth/session";
import { createSourceAction, toggleSourceAction } from "./actions";

export const metadata: Metadata = { title: "Remittance sources" };

export default async function SourcesPage({ searchParams }: PageProps<"/staff/admin/sources">) {
  await requireStaffPermission("sources.manage");
  const { ok, error } = await searchParams;
  const sources = await listSources(getDb());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Remittance sources</h1>
        <p className="text-sm text-muted">
          The payroll offices that send monthly remittance schedules. Members choose one when they register; members
          who pay into the bank themselves choose &quot;None — pays directly&quot;. Sources are switched off, never deleted.
        </p>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}

      <Card title="Add a source">
        <form action={createSourceAction} className="grid gap-4 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
          <Field label="Code" hint="e.g. PAYROLL-A">
            <Input name="code" required pattern="[A-Za-z0-9_-]{2,20}" />
          </Field>
          <Field label="Name">
            <Input name="name" required minLength={3} placeholder="e.g. Head Office Payroll" />
          </Field>
          <Button type="submit">Add</Button>
        </form>
      </Card>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-muted uppercase">
            <tr>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {sources.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted">
                  No sources yet.
                </td>
              </tr>
            ) : null}
            {sources.map((s) => (
              <tr key={s.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3 font-mono">{s.code}</td>
                <td className="px-4 py-3">{s.name}</td>
                <td className="px-4 py-3">{s.active ? "Active" : <span className="text-muted">Off</span>}</td>
                <td className="px-4 py-3 text-right">
                  <form action={toggleSourceAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="active" value={String(!s.active)} />
                    <Button type="submit" variant="secondary" className="px-2 py-1 text-xs">
                      {s.active ? "Switch off" : "Switch on"}
                    </Button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
