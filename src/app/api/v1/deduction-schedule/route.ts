import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { DeductionError, deductionPdf, deductionSchedule, deductionXlsx, scheduleRows } from "@/modules/credit/reports/deduction-schedule";
import { writeAudit } from "@/shell/audit/audit";
import { loadCurrentUser } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";

/**
 * The deduction schedule for a payroll office, as Excel (the bursary's six
 * columns) or PDF: /api/v1/deduction-schedule?source=&month=&scope=all|month&format=xlsx|pdf.
 * Every download is audited.
 */
export async function GET(request: Request) {
  const session = await loadCurrentUser();
  if ("problem" in session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const user = session.user;
  if (!user.isStaff || !user.twoFactorEnabled || !hasPermission(user.assignments, "deductionSchedule.read")) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }
  const params = new URL(request.url).searchParams;
  const format = params.get("format") === "pdf" ? "pdf" : "xlsx";
  const scope = params.get("scope") === "month" ? "month" : "all";
  const db = getDb();
  let schedule;
  try {
    schedule = await deductionSchedule(db, params.get("source") ?? "", params.get("month") ?? "");
  } catch (error) {
    if (error instanceof DeductionError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
  const rows = scheduleRows(schedule, scope);
  await writeAudit(db, {
    action: "deductionSchedule.exported",
    entityType: "RemittanceSource",
    entityId: schedule.source.id,
    userId: user.id,
    ipAddress: user.ipAddress,
    after: { format, scope, month: schedule.month, rows: rows.length, members: schedule.members.length, total: rows.reduce((t, r) => t + r.amount, 0n).toString() },
  });
  const name = `deduction-schedule-${schedule.source.code}-${schedule.month}${scope === "month" ? "" : "-onwards"}.${format}`;
  const headers = { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" };
  if (format === "pdf") return new NextResponse(Buffer.from(await deductionPdf(schedule, rows)), { headers: { ...headers, "Content-Type": "application/pdf" } });
  return new NextResponse(Buffer.from(await deductionXlsx(rows)), {
    headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  });
}
