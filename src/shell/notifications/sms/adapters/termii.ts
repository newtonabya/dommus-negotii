import { field, getJson, money, networkFailure, postJson, retryableStatus, text } from "../http";
import type { AdapterRequest, AdapterResult, SmsAdapter, SmsBalance } from "../types";

/**
 * Termii (https://developers.termii.com/messaging-api, checked 20 Nov 2026).
 * Every account has its own base URL (Termii dashboard), set as TERMII_BASE_URL.
 * POST <base>/api/sms/send, JSON { api_key, to, from, sms, type: "plain", channel };
 * channel "dnd" is the transactional route (reaches DND numbers; required for codes).
 * Success: HTTP 200 { code: "ok", message_id, balance, ... }.
 */
export class TermiiAdapter implements SmsAdapter {
  readonly name = "termii" as const;
  private readonly base: string;

  constructor(
    private readonly apiKey: string,
    baseUrl: string,
    private readonly channel: string = "dnd",
  ) {
    this.base = baseUrl.replace(/\/$/, "");
  }

  async send(request: AdapterRequest): Promise<AdapterResult> {
    let reply;
    try {
      reply = await postJson(`${this.base}/api/sms/send`, {
        api_key: this.apiKey,
        to: request.to,
        from: request.senderId,
        sms: request.message,
        type: "plain",
        channel: this.channel,
      });
    } catch (error) {
      return networkFailure(error);
    }
    if (reply.status < 300 && field(reply.body, "code") === "ok") {
      const id = text(field(reply.body, "message_id_str")) ?? text(field(reply.body, "message_id"));
      return { ok: true, status: "sent", providerMessageId: id, raw: reply.body, retryable: false };
    }
    return { ok: false, status: "failed", raw: reply.body, error: text(field(reply.body, "message")) ?? `HTTP ${reply.status}`, retryable: retryableStatus(reply.status) };
  }

  async getBalance(): Promise<SmsBalance> {
    const reply = await getJson(`${this.base}/api/get-balance?api_key=${encodeURIComponent(this.apiKey)}`);
    const amount = money(field(reply.body, "balance"));
    if (reply.status >= 300 || !Number.isFinite(amount)) throw new Error(`Termii balance check failed (HTTP ${reply.status})`);
    return { amount, currency: text(field(reply.body, "currency")) ?? "NGN", raw: reply.body };
  }
}
