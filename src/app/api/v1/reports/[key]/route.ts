import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { parsePeriod, reportByKey, reportPdf, reportXlsx } from "@/modules/credit/reports/staff-reports";
import { writeAudit } from "@/shell/audit/audit";
import { loadCurrentUser } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";

/** A staff report as Excel or PDF (PRD F13): /api/v1/reports/<key>?from=&to=&format=xlsx|pdf. Every export is audited. */
export async function GET(request: Request, ctx: RouteContext<"/api/v1/reports/[key]">) {
  const { key } = await ctx.params;
  const def = reportByKey(key);
  if (!def) return new NextResponse(null, { status: 404 });
  const session = await loadCurrentUser();
  if ("problem" in session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const user = session.user;
  if (!user.isStaff || !user.twoFactorEnabled || !hasPermission(user.assignments, def.permission)) return NextResponse.json({ error: "Not permitted." }, { status: 403 });

  const params = new URL(request.url).searchParams;
  const format = params.get("format") === "pdf" ? "pdf" : "xlsx";
  const period = parsePeriod(params.get("from"), params.get("to"));
  const db = getDb();
  const report = await def.build(db, period);
  await writeAudit(db, {
    action: "report.exported",
    entityType: "Report",
    entityId: def.key,
    userId: user.id,
    ipAddress: user.ipAddress,
    after: { format, ...(def.usesPeriod ? period : {}), rows: report.rows.length },
  });
  const name = `dommus-${def.key}${def.usesPeriod ? `-${period.from}-to-${period.to}` : ""}.${format}`;
  const headers = { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" };
  if (format === "pdf") return new NextResponse(Buffer.from(await reportPdf(report, def.landscape)), { headers: { ...headers, "Content-Type": "application/pdf" } });
  return new NextResponse(Buffer.from(await reportXlsx(report)), {
    headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  });
}
