import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { pdfHeaders } from "@/lib/pdf";
import { guarantorFormForLoan, guarantorFormPdf } from "@/modules/credit/loans/guarantor-form";
import { writeAudit } from "@/shell/audit/audit";
import { loadCurrentUser } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import { getCountSetting } from "@/shell/settings/settings";

/**
 * The printable guarantor form for a non-member guarantor (Loan Officer):
 * /api/v1/guarantor-form for a blank one, ?loan=<id> with the applicant's
 * details filled in. Every download is audited.
 */
export async function GET(request: Request) {
  const session = await loadCurrentUser();
  if ("problem" in session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const user = session.user;
  if (!user.isStaff || !user.twoFactorEnabled || !hasPermission(user.assignments, "guarantorForm.print")) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }
  const db = getDb();
  const loanId = new URL(request.url).searchParams.get("loan");
  let doc: { bytes: Uint8Array; filename: string } | null;
  if (loanId) {
    doc = await guarantorFormForLoan(db, loanId);
    if (!doc) return NextResponse.json({ error: "Application not found." }, { status: 404 });
  } else {
    doc = { bytes: await guarantorFormPdf({ maxGuarantees: await getCountSetting(db, "max_open_guarantees_per_guarantor") }), filename: "guarantor-form.pdf" };
  }
  await writeAudit(db, { action: "guarantorForm.printed", entityType: loanId ? "Loan" : "Form", entityId: loanId ?? "guarantor-form", userId: user.id, ipAddress: user.ipAddress, after: { filename: doc.filename } });
  return new NextResponse(Buffer.from(doc.bytes), { headers: pdfHeaders(doc.filename) });
}
