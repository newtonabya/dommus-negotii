import { NextResponse } from "next/server";

/**
 * Uptime check (PRD §5). Deliberately does not touch the database, so a
 * monitor polling it never wakes a scaled-to-zero Neon compute.
 */
export function GET() {
  return NextResponse.json(
    { status: "ok", time: new Date().toISOString(), version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
