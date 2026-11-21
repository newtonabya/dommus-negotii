/**
 * Notification providers (PRD F2, §5): SMS through the provider-agnostic SMS
 * module (src/shell/notifications/sms, chosen by SMS_PROVIDER), email via
 * Resend, behind one interface so the outbox doesn't care which.
 */

import { isStaging } from "@/lib/stage";
import { smsEnvironment } from "./sms/config";
import { sendSms } from "./sms";

export type Channel = "SMS" | "EMAIL";

export interface OutboundMessage {
  channel: Channel;
  to: string;
  subject?: string;
  text: string;
  /** Holds a one-time code: never printed or logged in full. */
  sensitive?: boolean;
  /** The outbox key, passed on as the SMS reference. */
  reference?: string;
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  response: unknown;
  /** The provider that actually handled it (the SMS fallback, after failover). */
  provider?: string;
  /** Not sent on purpose (staging test-number list, SMS switched off). */
  skipped?: boolean;
  /** Worth sending again later; false for a bad number or sender ID. */
  retryable?: boolean;
  segments?: number;
  error?: string;
  environment?: string;
}

export interface NotificationProvider {
  readonly name: string;
  readonly channel: Channel;
  send(message: OutboundMessage): Promise<SendResult>;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class ResendProvider implements NotificationProvider {
  readonly name = "resend";
  readonly channel = "EMAIL" as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject ?? "", text: message.text }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await readBody(res);
    const id = typeof body === "object" && body !== null && "id" in body ? String(body.id) : undefined;
    return { ok: res.ok, providerMessageId: id, response: { status: res.status, body }, retryable: res.status === 429 || res.status >= 500 };
  }
}

/** SMS through `sendSms`: the configured provider, its retries, failover and the staging rules. */
export class SmsChannelProvider implements NotificationProvider {
  readonly name = "sms";
  readonly channel = "SMS" as const;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const r = await sendSms({ to: message.to, message: message.text, reference: message.reference, sensitive: message.sensitive }, { env: this.env });
    const skipped = r.status === "skipped_staging" || r.status === "disabled";
    return {
      ok: r.ok && !skipped,
      skipped,
      providerMessageId: r.providerMessageId,
      response: { status: r.status, attempts: r.attempts, encoding: r.encoding, body: r.raw },
      provider: r.provider,
      retryable: r.retryable,
      segments: r.segments,
      error: r.status === "skipped_staging" ? "skipped_staging: not on SMS_TEST_RECIPIENTS" : r.error,
      environment: smsEnvironment(this.env),
    };
  }
}

/** Development and staging email only: prints the message to the server log instead of sending. */
export class ConsoleProvider implements NotificationProvider {
  readonly name = "console";
  constructor(readonly channel: Channel) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const text = message.sensitive ? message.text.replace(/\b\d{4,8}\b/g, (m) => "•".repeat(m.length)) : message.text;
    console.info(`\n[notification:${message.channel}] to ${message.to}${message.subject ? ` — ${message.subject}` : ""}\n${text}\n`);
    return { ok: true, response: { printed: true }, environment: smsEnvironment() };
  }
}

/** Picks the provider for a channel. SMS always goes through the SMS module (SMS_PROVIDER decides). */
export function providerFor(channel: Channel, env: NodeJS.ProcessEnv = process.env): NotificationProvider {
  if (channel === "SMS") return new SmsChannelProvider(env);
  // Staging holds test people with real-looking addresses: never email them.
  if (isStaging(env)) return new ConsoleProvider(channel);
  if (env.RESEND_API_KEY && env.RESEND_FROM) return new ResendProvider(env.RESEND_API_KEY, env.RESEND_FROM);
  if (env.NODE_ENV === "production") throw new Error("No EMAIL provider configured (set RESEND_API_KEY and RESEND_FROM)");
  return new ConsoleProvider(channel);
}
