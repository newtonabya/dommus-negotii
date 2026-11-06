import { NextResponse } from "next/server";
import { pdfHeaders } from "@/lib/pdf";
import { DocumentError } from "@/modules/credit/reports/member-documents";
import { writeAudit } from "@/shell/audit/audit";
import { loadCurrentUser } from "@/shell/auth/session";
import { hasPermission, type Action } from "@/shell/rbac/permissions";
import type { Db } from "@/lib/db";

/**
 * Serves a member document as a PDF to its owner, or to staff holding
 * `staffAction`. Every download is audited.
 */
export async function serveDocument(
  db: Db,
  input: {
    ownerOf: () => Promise<string>;
    staffAction: Action;
    entityType: string;
    entityId: string;
    action: string;
    build: () => Promise<{ bytes: Uint8Array; filename: string }>;
  },
) {
  const session = await loadCurrentUser();
  if ("problem" in session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const user = session.user;
  try {
    const owner = await input.ownerOf();
    const staffOk = user.isStaff && user.twoFactorEnabled && hasPermission(user.assignments, input.staffAction);
    if (owner !== user.id && !staffOk) return NextResponse.json({ error: "Not yours to open." }, { status: 403 });
    const { bytes, filename } = await input.build();
    await writeAudit(db, { action: input.action, entityType: input.entityType, entityId: input.entityId, userId: user.id, ipAddress: user.ipAddress, after: { filename } });
    return new NextResponse(Buffer.from(bytes), { headers: pdfHeaders(filename) });
  } catch (error) {
    if (error instanceof DocumentError) return NextResponse.json({ error: error.message }, { status: 404 });
    throw error;
  }
}
