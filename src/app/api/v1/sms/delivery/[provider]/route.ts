import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { parseDeliveryReport } from "@/shell/notifications/sms/delivery";
import { SMS_PROVIDERS, type SmsProviderName } from "@/shell/notifications/sms/types";

/**
 * Delivery reports from the SMS provider: marks the logged message DELIVERED
 * or FAILED. The URL carries SMS_WEBHOOK_SECRET as `?token=` (or the
 * `x-webhook-token` header); without the secret set, reports are refused.
 * Providers send one report per message and retry on errors, so this answers
 * 200 for anything it accepted, matched or not.
 *
 * URL to give the provider: https://<site>/api/v1/sms/delivery/<provider>?token=<SMS_WEBHOOK_SECRET>
 * (BulkSMSNigeria and SMS.to get it with every message automatically.)
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const secret = process.env.SMS_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Delivery reports are not set up" }, { status: 503 });
  const url = new URL(request.url);
  const given = Buffer.from(url.searchParams.get("token") ?? request.headers.get("x-webhook-token") ?? "");
  const expected = Buffer.from(secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { provider } = await params;
  if (!(SMS_PROVIDERS as readonly string[]).includes(provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });

  const type = request.headers.get("content-type") ?? "";
  let body: unknown;
  try {
    body = type.includes("application/json") ? await request.json() : Object.fromEntries(new URLSearchParams(await request.text()));
  } catch {
    return NextResponse.json({ error: "Unreadable report" }, { status: 400 });
  }

  const report = parseDeliveryReport(provider as SmsProviderName, body);
  if (!report) return NextResponse.json({ ok: true, matched: 0 });
  // Never downgrade a delivered message; a repeated report changes nothing.
  const { count } = await getDb().notification.updateMany({
    where: { providerMessageId: report.providerMessageId, channel: "SMS", status: { not: "DELIVERED" } },
    data: report.outcome === "delivered" ? { status: "DELIVERED", error: null } : { status: "FAILED", error: `Not delivered: ${report.detail}`.slice(0, 500) },
  });
  return NextResponse.json({ ok: true, matched: count });
}
