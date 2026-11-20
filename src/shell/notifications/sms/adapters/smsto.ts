import { field, getJson, money, networkFailure, postJson, retryableStatus, text } from "../http";
import type { AdapterRequest, AdapterResult, SmsAdapter, SmsBalance } from "../types";

/**
 * SMS.to (from the official SDK github.com/intergo/sms.to-php, checked 20 Nov
 * 2026; the docs site is script-rendered and couldn't be read). POST
 * https://api.sms.to/sms/send, Authorization: Bearer <key>, JSON
 * { to (+E.164), message, sender_id, callback_url }. The SDK treats
 * `success: false` as failure; the id field is taken as `message_id`.
 */
export class SmsToAdapter implements SmsAdapter {
  readonly name = "smsto" as const;
  constructor(private readonly apiKey: string) {}

  private get auth() {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  async send(request: AdapterRequest): Promise<AdapterResult> {
    let reply;
    try {
      reply = await postJson(
        "https://api.sms.to/sms/send",
        { to: `+${request.to}`, message: request.message, sender_id: request.senderId, ...(request.callbackUrl ? { callback_url: request.callbackUrl } : {}) },
        this.auth,
      );
    } catch (error) {
      return networkFailure(error);
    }
    const ok = reply.status < 300 && field(reply.body, "success") !== false;
    const id = text(field(reply.body, "message_id")) ?? text(field(reply.body, "messageId"));
    if (ok) return { ok: true, status: "queued", providerMessageId: id, raw: reply.body, retryable: false };
    return { ok: false, status: "failed", raw: reply.body, error: text(field(reply.body, "message")) ?? `HTTP ${reply.status}`, retryable: retryableStatus(reply.status) };
  }

  async getBalance(): Promise<SmsBalance> {
    const reply = await getJson("https://auth.sms.to/api/balance", this.auth);
    const amount = money(field(reply.body, "balance"));
    if (reply.status >= 300 || !Number.isFinite(amount)) throw new Error(`SMS.to balance check failed (HTTP ${reply.status})`);
    return { amount, currency: text(field(reply.body, "currency")) ?? "", raw: reply.body };
  }
}
