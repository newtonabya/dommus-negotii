import { getDb } from "@/lib/db";
import { receiptPdf, rowOwner } from "@/modules/credit/reports/member-documents";
import { serveDocument } from "../../documents";

/** Receipt for one posted repayment row (PRD F13). */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/receipts/[rowId]">) {
  const { rowId } = await ctx.params;
  const db = getDb();
  return serveDocument(db, {
    ownerOf: () => rowOwner(db, rowId),
    staffAction: "credit.read",
    entityType: "RemittanceRow",
    entityId: rowId,
    action: "receipt.downloaded",
    build: () => receiptPdf(db, rowId),
  });
}
