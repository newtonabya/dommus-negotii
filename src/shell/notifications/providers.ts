/**
 * Notification providers (PRD F2, §5): SMS via Termii, email via Resend,
 * behind one interface so providers can be swapped.
 */

import { isStaging } from "@/lib/stage";

export type Channel = "SMS" | "EMAIL";

export interface OutboundMessage {
  channel: Channel;
  to: string;
  subject?: string;
  text: string;
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  response: unknown;
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
    });
    const body = await readBody(res);
    const id = typeof body === "object" && body !== null && "id" in body ? String(body.id) : undefined;
    return { ok: res.ok, providerMessageId: id, response: { status: res.status, body } };
  }
}

export class TermiiProvider implements NotificationProvider {
  readonly name = "termii";
  readonly channel = "SMS" as const;
  constructor(
    private readonly apiKey: string,
    private readonly senderId: string,
    private readonly baseUrl: string,
    /** "dnd" reaches numbers on Do-Not-Disturb, needed for codes in Nigeria. */
    private readonly route: string,
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/sms/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        to: message.to.replace(/^\+/, ""),
        from: this.senderId,
        sms: message.text,
        type: "plain",
        channel: this.route,
      }),
    });
    const body = await readBody(res);
    const id =
      typeof body === "object" && body !== null && "message_id" in body ? String(body.message_id) : undefined;
    return { ok: res.ok, providerMessageId: id, response: { status: res.status, body } };
  }
}

/** Development and staging only: prints the message to the server log instead of sending. */
export class ConsoleProvider implements NotificationProvider {
  readonly name = "console";
  constructor(readonly channel: Channel) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    console.info(
      `\n[notification:${message.channel}] to ${message.to}${message.subject ? ` — ${message.subject}` : ""}\n${message.text}\n`,
    );
    return { ok: true, response: { printed: true } };
  }
}

/** Picks the configured provider for a channel. Production never falls back to the console. */
export function providerFor(channel: Channel, env: NodeJS.ProcessEnv = process.env): NotificationProvider {
  // Staging holds test people with real-looking numbers: never message them.
  if (isStaging(env)) return new ConsoleProvider(channel);
  if (channel === "EMAIL" && env.RESEND_API_KEY && env.RESEND_FROM) {
    return new ResendProvider(env.RESEND_API_KEY, env.RESEND_FROM);
  }
  if (channel === "SMS" && env.TERMII_API_KEY && env.TERMII_SENDER_ID) {
    return new TermiiProvider(
      env.TERMII_API_KEY,
      env.TERMII_SENDER_ID,
      env.TERMII_BASE_URL ?? "https://api.ng.termii.com",
      env.TERMII_ROUTE ?? "dnd",
    );
  }
  if (env.NODE_ENV === "production") {
    throw new Error(`No ${channel} provider configured (set the Resend or Termii variables)`);
  }
  return new ConsoleProvider(channel);
}
