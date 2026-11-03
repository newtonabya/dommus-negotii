import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { writeAudit } from "@/shell/audit/audit";
import { exportAudit, parseAuditFilters } from "@/shell/audit/search";
import { authorizeAction } from "@/shell/auth/session";
import { ForbiddenError } from "@/shell/rbac/permissions";

/** The audit trail as Excel, with the page's filters (PRD F2 DoD). Auditor only; every export is itself audited. */
export async function GET(request: Request) {
  let user;
  try {
    user = await authorizeAction("audit.read");
  } catch (error) {
    if (error instanceof ForbiddenError) return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
  }
  const { filters, errors } = parseAuditFilters(Object.fromEntries(new URL(request.url).searchParams));
  if (errors.length) return NextResponse.json({ error: errors.join(" ") }, { status: 400 });

  const db = getDb();
  const { bytes, total, included } = await exportAudit(db, filters, user.name);
  await writeAudit(db, {
    action: "audit.exported",
    entityType: "AuditLog",
    userId: user.id,
    ipAddress: user.ipAddress,
    after: { filters, total, included },
  });
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="dommus-audit-${todayInLagos()}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
