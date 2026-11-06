import { getDb } from "@/lib/db";
import { loanOwner, payoffQuotePdf } from "@/modules/credit/reports/member-documents";
import { serveDocument } from "../../../documents";

/** Payoff quote as a PDF (PRD F6, F13): the member's own, or issued by staff who may. */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/loans/[id]/payoff-quote">) {
  const { id } = await ctx.params;
  const db = getDb();
  return serveDocument(db, {
    ownerOf: () => loanOwner(db, id),
    staffAction: "payoffQuote.issue",
    entityType: "Loan",
    entityId: id,
    action: "payoffQuote.issue",
    build: () => payoffQuotePdf(db, id),
  });
}
