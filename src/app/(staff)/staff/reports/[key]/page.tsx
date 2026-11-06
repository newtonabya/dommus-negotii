import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { displayCell, parsePeriod, reportByKey } from "@/modules/credit/reports/staff-reports";
import { requireStaff } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";

export const metadata: Metadata = { title: "Report" };

export default async function ReportPage({ params, searchParams }: PageProps<"/staff/reports/[key]">) {
  const user = await requireStaff();
  const { key } = await params;
  const def = reportByKey(key);
  if (!def) notFound();
  if (!hasPermission(user.assignments, def.permission)) redirect("/forbidden");
  const q = await searchParams;
  const period = parsePeriod(typeof q.from === "string" ? q.from : null, typeof q.to === "string" ? q.to : null);
  const report = await def.build(getDb(), period);
  const query = new URLSearchParams(def.usesPeriod ? { from: period.from, to: period.to } : {}).toString();
  const shown = report.rows.slice(0, 1000);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/staff/reports?${query}` as never} className="text-sm underline">
          ← Reports
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{report.title}</h1>
        <p className="text-sm text-muted">{report.subtitle}</p>
        <p className="mt-2 flex gap-4 text-sm">
          <a className="underline" href={`/api/v1/reports/${def.key}?${query}${query ? "&" : ""}format=xlsx`}>
            Download Excel
          </a>
          <a className="underline" href={`/api/v1/reports/${def.key}?${query}${query ? "&" : ""}format=pdf`}>
            Download PDF
          </a>
        </p>
      </div>
      <Card>
        {report.rows.length === 0 ? (
          <p className="text-sm text-muted">Nothing to report.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm tabular-nums">
              <thead className="text-xs text-muted uppercase">
                <tr>
                  {report.columns.map((c) => (
                    <th key={c.header} className={`py-1 pr-3 ${c.kind === "money" || c.kind === "count" ? "text-right" : ""}`}>
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i} className="border-t border-border align-top">
                    {r.map((cell, j) => {
                      const c = report.columns[j]!;
                      return (
                        <td key={j} className={`py-1 pr-3 ${c.kind === "money" || c.kind === "count" ? "text-right" : ""} ${c.header === "Evidence" || c.header === "Event id" ? "font-mono text-xs break-all" : ""}`}>
                          {displayCell(cell, c)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {report.totals ? (
                  <tr className="border-t-2 border-border font-semibold">
                    {report.totals.map((cell, j) => {
                      const c = report.columns[j]!;
                      return (
                        <td key={j} className={`py-1 pr-3 ${c.kind === "money" || c.kind === "count" ? "text-right" : ""}`}>
                          {displayCell(cell, c)}
                        </td>
                      );
                    })}
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
        {report.rows.length > shown.length ? <p className="mt-2 text-sm text-muted">Showing the first 1,000 rows; the downloads have them all.</p> : null}
        {report.notes.length ? (
          <ul className="mt-3 list-disc pl-5 text-xs text-muted">
            {report.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
      </Card>
    </div>
  );
}
