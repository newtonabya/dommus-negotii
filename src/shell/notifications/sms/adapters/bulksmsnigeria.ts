import { field, getJson, money, networkFailure, postJson, retryableStatus, text } from "../http";
import type { AdapterRequest, AdapterResult, SmsAdapter, SmsBalance } from "../types";

/**
 * BulkSMSNigeria REST API v2 (https://www.bulksmsnigeria.com/api-documentation,
 * checked 20 Nov 2026: v2 is "recommended", v1 /api/v1/sms/create is "legacy").
 * Bearer token; JSON { from, to, body, gateway, unicode, callback_url }.
 * Success: { status: "success", code: "BSNG-0000", data: { message_id, cost, ... } }.
 * Errors: { status: "error", code: "BSNG-XXXX", error: { message } } with a matching HTTP status.
 */
export class BulkSmsNigeriaAdapter implements SmsAdapter {
  readonly name = "bulksmsnigeria" as const;
  private readonly base: string;

  constructor(
    private readonly token: string,
    options: { sandbox?: boolean; gateway?: string } = {},
  ) {
    this.base = options.sandbox ? "https://www.bulksmsnigeria.com/api/sandbox/v2" : "https://www.bulksmsnigeria.com/api/v2";
    this.gateway = options.gateway || "corporate";
  }

  /** "corporate" or "otp" reach DND numbers where the sender ID is approved; others fall back to direct-refund. */
  private readonly gateway: string;

  private get auth() {
    return { Authorization: `Bearer ${this.token}` };
  }

  async send(request: AdapterRequest): Promise<AdapterResult> {
    let reply;
    try {
      reply = await postJson(
        `${this.base}/sms`,
        {
          from: request.senderId,
          to: request.to,
          body: request.message,
          gateway: this.gateway,
          unicode: request.unicode,
          ...(request.callbackUrl ? { callback_url: request.callbackUrl } : {}),
        },
        this.auth,
      );
    } catch (error) {
      return networkFailure(error);
    }
    const ok = reply.status < 300 && field(reply.body, "status") === "success";
    if (ok) {
      return { ok: true, status: "sent", providerMessageId: text(field(reply.body, "data", "message_id")), raw: reply.body, retryable: false };
    }
    const code = text(field(reply.body, "code")) ?? text(field(reply.body, "error", "code"));
    const message = text(field(reply.body, "error", "message")) ?? text(field(reply.body, "message")) ?? `HTTP ${reply.status}`;
    return { ok: false, status: "failed", raw: reply.body, error: code ? `${code}: ${message}` : message, retryable: retryableStatus(reply.status) };
  }

  async getBalance(): Promise<SmsBalance> {
    const reply = await getJson(`${this.base}/balance`, this.auth);
    const amount = money(field(reply.body, "balance", "total_balance"));
    if (reply.status >= 300 || !Number.isFinite(amount)) throw new Error(`BulkSMSNigeria balance check failed (HTTP ${reply.status})`);
    return { amount, currency: "NGN", raw: reply.body };
  }
}
