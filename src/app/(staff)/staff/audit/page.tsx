import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Button, Field, Input, Select } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { AUDIT_EXPORT_LIMIT, AUDIT_PAGE_SIZE, filtersToQuery, formatAuditTime, parseAuditFilters, searchAudit } from "@/shell/audit/search";
import { requireStaffPermission } from "@/shell/auth/session";

export const metadata: Metadata = { title: "Audit trail" };

function Snapshot({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted uppercase">{label}</div>
      <pre className="mt-1 max-w-xl overflow-x-auto rounded bg-background p-2 text-xs whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export default async function AuditPage({ searchParams }: PageProps<"/staff/audit">) {
  await requireStaffPermission("audit.read");
  const params = await searchParams;
  const { filters, errors } = parseAuditFilters(params);
  const requested = typeof params.page === "string" && /^\d{1,6}$/.test(params.page) ? parseInt(params.page, 10) : 1;
  const result = errors.length ? null : await searchAudit(getDb(), filters, Math.max(1, requested));
  const first = result ? (result.page - 1) * AUDIT_PAGE_SIZE + 1 : 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Audit trail</h1>
        <p className="text-sm text-muted">
          Every change in the portal, newest first. Entries can&apos;t be edited or deleted, not even by the database
          owner. Times are Lagos time.
        </p>
      </div>

      <form method="get" className="grid gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-3">
        <Field label="User" hint="Name, email or user id">
          <Input name="user" defaultValue={filters.user ?? ""} />
        </Field>
        <Field label="From">
          <Input name="from" type="date" defaultValue={filters.from ?? ""} />
        </Field>
        <Field label="To">
          <Input name="to" type="date" defaultValue={filters.to ?? ""} />
        </Field>
        <Field label="Action">
          <Select name="action" defaultValue={filters.action ?? ""}>
            <option value="">All actions</option>
            {result?.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Record type">
          <Select name="entityType" defaultValue={filters.entityType ?? ""}>
            <option value="">All records</option>
            {result?.entityTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Record id">
          <Input name="entityId" defaultValue={filters.entityId ?? ""} />
        </Field>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
          <Button type="submit">Search</Button>
          <Link href="/staff/audit" className="text-sm underline">
            Clear filters
          </Link>
          {result && result.total > 0 ? (
            <a href={`/api/v1/audit/export?${filtersToQuery(filters)}`} className="text-sm underline">
              Download Excel ({Math.min(result.total, AUDIT_EXPORT_LIMIT).toLocaleString("en-NG")} entries)
            </a>
          ) : null}
        </div>
      </form>

      {errors.map((e) => (
        <Alert key={e} tone="error">
          {e}
        </Alert>
      ))}

      {result ? (
        <>
          <p className="text-sm text-muted">
            {result.total === 0
              ? "No entries match."
              : `Showing ${first.toLocaleString("en-NG")}–${(first + result.rows.length - 1).toLocaleString("en-NG")} of ${result.total.toLocaleString("en-NG")}`}
            {result.total > AUDIT_EXPORT_LIMIT ? ` · the Excel export holds the newest ${AUDIT_EXPORT_LIMIT.toLocaleString("en-NG")}` : ""}
          </p>
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-border text-xs text-muted uppercase">
                <tr>
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Record</th>
                  <th className="px-4 py-3">Details</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.id} className="border-b border-border align-top last:border-0">
                    <td className="px-4 py-3 whitespace-nowrap">{formatAuditTime(r.occurredAt)}</td>
                    <td className="px-4 py-3">
                      <div>{r.actor.name}</div>
                      <div className="text-xs text-muted">
                        {r.actor.email}
                        {r.ipAddress ? ` · ${r.ipAddress}` : ""}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{r.action}</td>
                    <td className="px-4 py-3">
                      <div>{r.entityType}</div>
                      <div className="font-mono text-xs break-all text-muted">{r.entityId}</div>
                    </td>
                    <td className="px-4 py-3">
                      {r.before !== null || r.after !== null || r.evidenceRef ? (
                        <details>
                          <summary className="cursor-pointer text-accent">Show</summary>
                          <div className="mt-2 flex flex-col gap-2">
                            <Snapshot label="Before" value={r.before} />
                            <Snapshot label="After" value={r.after} />
                            {r.evidenceRef ? (
                              <a href={`/api/v1/evidence/${r.evidenceRef}`} target="_blank" rel="noopener" className="text-xs underline">
                                Open evidence
                              </a>
                            ) : null}
                          </div>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <nav className="flex items-center justify-between text-sm">
              {result.page > 1 ? (
                <Link href={`/staff/audit?${filtersToQuery(filters, { page: String(result.page - 1) })}`} className="underline">
                  ← Newer
                </Link>
              ) : (
                <span />
              )}
              <span className="text-muted">
                Page {result.page} of {result.pages}
              </span>
              {result.page < result.pages ? (
                <Link href={`/staff/audit?${filtersToQuery(filters, { page: String(result.page + 1) })}`} className="underline">
                  Older →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
