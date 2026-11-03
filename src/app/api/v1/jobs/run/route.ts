import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { JOBS } from "@/jobs/definitions";
import { runAllJobs } from "@/shell/jobs/runner";

/** Jobs can take a while on a cold database. */
export const maxDuration = 60;

/**
 * Vercel Cron entry point (vercel.json): runs the whole job batch. Vercel sends
 * `Authorization: Bearer $CRON_SECRET`; without CRON_SECRET set, nothing runs.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const runs = await runAllJobs(getDb(), JOBS, "cron");
  return NextResponse.json({ runs: runs.map((r) => ({ job: r.job, status: r.status, summary: r.summary, error: r.error })) });
}
