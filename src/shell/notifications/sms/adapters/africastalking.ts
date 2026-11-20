import { field, getJson, money, networkFailure, postForm, retryableStatus, text } from "../http";
import type { AdapterRequest, AdapterResult, SmsAdapter, SmsBalance } from "../types";

/** Per-recipient status codes: 100 Processed, 101 Sent, 102 Queued are successes; 500/501 are the gateway's fault. */
const SUCCESS_CODES = new Set([100, 101, 102]);
const RETRYABLE_CODES = new Set([500, 501]);

/**
 * Africa's Talking (from the official npm package africastalking@0.8.4,
 * lib/common.js and lib/sms.js, checked 20 Nov 2026; the docs site refuses
 * automated reads). POST https://api[.sandbox].africastalking.com/version1/messaging,
 * form fields username, to, message, from; headers apiKey and Accept: application/json;
 * success is HTTP 201 with SMSMessageData.Recipients[]. The sandbox delivers
 * only to the AT simulator.
 */
export class AfricasTalkingAdapter implements SmsAdapter {
  readonly name = "africastalking" as const;
  private readonly base: string;

  constructor(
    private readonly username: string,
    private readonly apiKey: string,
    private readonly sandbox: boolean,
  ) {
    this.base = sandbox ? "https://api.sandbox.africastalking.com/version1" : "https://api.africastalking.com/version1";
  }

  async send(request: AdapterRequest): Promise<AdapterResult> {
    let reply;
    try {
      reply = await postForm(
        `${this.base}/messaging`,
        {
          username: this.username,
          to: `+${request.to}`,
          message: request.message,
          // The sandbox uses its own shortcode; a live sender ID must be registered with AT.
          ...(request.senderId && !this.sandbox ? { from: request.senderId } : {}),
        },
        { apiKey: this.apiKey },
      );
    } catch (error) {
      return networkFailure(error);
    }
    const recipient = (field(reply.body, "SMSMessageData", "Recipients") as unknown[] | undefined)?.[0];
    const code = Number(field(recipient, "statusCode"));
    if (reply.status < 300 && SUCCESS_CODES.has(code)) {
      return { ok: true, status: code === 102 ? "queued" : "sent", providerMessageId: text(field(recipient, "messageId")), raw: reply.body, retryable: false };
    }
    const reason = text(field(recipient, "status")) ?? text(field(reply.body, "SMSMessageData", "Message")) ?? (typeof reply.body === "string" ? reply.body.slice(0, 200) : undefined);
    return {
      ok: false,
      status: "failed",
      raw: reply.body,
      error: reason ? `${Number.isFinite(code) && code ? `${code} ` : ""}${reason}` : `HTTP ${reply.status}`,
      retryable: retryableStatus(reply.status) || RETRYABLE_CODES.has(code),
    };
  }

  async getBalance(): Promise<SmsBalance> {
    const reply = await getJson(`${this.base}/user?username=${encodeURIComponent(this.username)}`, { apiKey: this.apiKey });
    const raw = text(field(reply.body, "UserData", "balance")) ?? "";
    const amount = money(raw);
    if (reply.status >= 300 || !Number.isFinite(amount)) throw new Error(`Africa's Talking balance check failed (HTTP ${reply.status})`);
    return { amount, currency: raw.match(/^[A-Z]{3}/)?.[0] ?? "", raw: reply.body };
  }
}
