import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { collectPersonalData, personalDataPdf } from "@/modules/credit/members/data-copy";
import { writeAudit } from "@/shell/audit/audit";
import { loadCurrentUser } from "@/shell/auth/session";

/**
 * The signed-in member's copy of their personal data (PRD F5, NDPA 2023), as
 * ?format=json or ?format=pdf. Any member record owner may download it, whatever
 * the membership status. Every download is audited.
 */
export async function GET(request: Request) {
  const session = await loadCurrentUser();
  if ("problem" in session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const format = new URL(request.url).searchParams.get("format") === "pdf" ? "pdf" : "json";
  const db = getDb();
  const data = await collectPersonalData(db, session.user.id);
  if (!data) return NextResponse.json({ error: "No membership is linked to this login." }, { status: 404 });

  await writeAudit(db, {
    action: "member.data_copy.downloaded",
    entityType: "Member",
    entityId: data.member.id,
    userId: session.user.id,
    ipAddress: session.user.ipAddress,
    after: { format },
  });
  const name = `my-dommus-data-${todayInLagos()}.${format}`;
  const headers = { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" };
  if (format === "json") {
    return new NextResponse(JSON.stringify(data, null, 2), { headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
  }
  return new NextResponse(Buffer.from(await personalDataPdf(data)), { headers: { ...headers, "Content-Type": "application/pdf" } });
}
