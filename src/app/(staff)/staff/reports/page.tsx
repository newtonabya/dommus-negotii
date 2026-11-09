import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button, Card, Field, Input } from "@/components/ui/form";
import { parsePeriod, REPORTS } from "@/modules/credit/reports/staff-reports";
import { requireStaff } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";

export const metadata: Metadata = { title: "Reports" };

/** Reports that need features not built yet; listed so nobody looks for them in vain. */
const LATER = [
  ["Joint reconciliation and exceptions", "with monthly reconciliation (F11)"],
  ["Prior-period adjustments per closed month", "with month close (F11)"],
] as const;

export default async function ReportsPage({ searchParams }: PageProps<"/staff/reports">) {
  const user = await requireStaff();
  const available = REPORTS.filter((r) => hasPermission(user.assignments, r.permission));
  const canAudit = hasPermission(user.assignments, "audit.read");
  if (available.length === 0 && !canAudit) redirect("/forbidden");
  const q = await searchParams;
  const period = parsePeriod(typeof q.from === "string" ? q.from : null, typeof q.to === "string" ? q.to : null);
  const qs = (key: string, usesPeriod: boolean, format?: string) =>
    `${format ? `/api/v1/reports/${key}` : `/staff/reports/${key}`}?${new URLSearchParams({ ...(usesPeriod ? { from: period.from, to: period.to } : {}), ...(format ? { format } : {}) }).toString()}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-muted">Every figure is read from the ledger and the records it came from. Each report opens on screen or downloads as Excel or PDF; downloads are audited.</p>
      </div>

      <Card title="Period">
        <form className="flex flex-wrap items-end gap-3">
          <Field label="From">
            <Input type="date" name="from" defaultValue={period.from} />
          </Field>
          <Field label="To">
            <Input type="date" name="to" defaultValue={period.to} />
          </Field>
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted">Used by the reports marked “for the period”; the others are as at today.</p>
      </Card>

      <ul className="grid gap-3 md:grid-cols-2">
        {available.map((r) => (
          <li key={r.key} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
            <div>
              <div className="font-semibold">{r.title}</div>
              <div className="text-sm text-muted">{r.description}</div>
              <div className="mt-1 text-xs text-muted">{r.usesPeriod ? `For the period ${period.from} to ${period.to}` : "As at today"}</div>
            </div>
            <div className="mt-auto flex flex-wrap gap-3 text-sm">
              <Link className="underline" href={qs(r.key, r.usesPeriod) as never}>
                View
              </Link>
              <a className="underline" href={qs(r.key, r.usesPeriod, "xlsx")}>
                Excel
              </a>
              <a className="underline" href={qs(r.key, r.usesPeriod, "pdf")}>
                PDF
              </a>
            </div>
          </li>
        ))}
        {canAudit ? (
          <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
            <div className="font-semibold">Audit trail extract</div>
            <div className="text-sm text-muted">Search and export the audit trail by user, date, action and record.</div>
            <Link className="mt-auto text-sm underline" href="/staff/audit">
              Open the audit trail
            </Link>
          </li>
        ) : null}
      </ul>

      <Card title="Coming with later features">
        <ul className="list-disc pl-5 text-sm text-muted">
          {LATER.map(([title, when]) => (
            <li key={title}>
              {title}: {when}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
