import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

/** Module status endpoint (PRD §8 contract 4): code, name, status and emitted event types. Public, for monitoring. */
export async function GET(_request: Request, ctx: RouteContext<"/api/v1/modules/[code]/status">) {
  const { code } = await ctx.params;
  const mod = await getDb().module.findUnique({
    where: { code: code.toUpperCase() },
    select: { code: true, name: true, status: true, eventTypes: true },
  });
  if (!mod) return NextResponse.json({ error: "Unknown module" }, { status: 404 });
  return NextResponse.json(mod, { headers: { "Cache-Control": "no-store" } });
}
