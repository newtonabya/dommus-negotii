import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { EvidenceError, openEvidence } from "@/evidence/service";
import { getEvidenceStore } from "@/evidence/store";
import { writeAudit } from "@/shell/audit/audit";
import { loadCurrentUser } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";

/**
 * Opens an evidence file: checks the reader's permission, re-verifies the
 * checksum, then redirects to a 5-minute download URL (PRD F3).
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/evidence/[id]">) {
  const { id } = await ctx.params;
  const result = await loadCurrentUser();
  if ("problem" in result) return NextResponse.json({ error: "Sign in to open evidence." }, { status: 401 });
  const user = result.user;
  if ((user.isStaff && !user.twoFactorEnabled) || !hasPermission(user.assignments, "evidence.read")) {
    await writeAudit(getDb(), { action: "auth.forbidden", entityType: "EvidenceFile", entityId: id, userId: user.id, ipAddress: user.ipAddress });
    return NextResponse.json({ error: "You can't open this evidence." }, { status: 403 });
  }
  try {
    const { url } = await openEvidence(getDb(), getEvidenceStore(), user, id);
    return NextResponse.redirect(new URL(url, _request.url), { status: 302, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof EvidenceError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
