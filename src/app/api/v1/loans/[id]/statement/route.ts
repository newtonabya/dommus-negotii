import { getDb } from "@/lib/db";
import { loanOwner, loanStatementPdf } from "@/modules/credit/reports/member-documents";
import { serveDocument } from "../../../documents";

/** The loan statement as a PDF (PRD F13): the member's own, or for staff who read credit records. */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/loans/[id]/statement">) {
  const { id } = await ctx.params;
  const db = getDb();
  return serveDocument(db, {
    ownerOf: () => loanOwner(db, id),
    staffAction: "credit.read",
    entityType: "Loan",
    entityId: id,
    action: "loan.statement.downloaded",
    build: () => loanStatementPdf(db, id),
  });
}
