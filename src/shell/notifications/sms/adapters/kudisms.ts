import { field, money, networkFailure, postJson, retryableStatus, text } from "../http";
import type { AdapterRequest, AdapterResult, SmsAdapter, SmsBalance } from "../types";

/** KudiSMS codes that mean "try again later" (could not be processed now). */
const RETRYABLE_CODES = new Set(["187", "401"]);

/**
 * KudiSMS (https://kudisms.net/docs, checked 20 Nov 2026). Base
 * https://my.kudisms.net/api. Route "corporate" (/corporate, an approved
 * corporate sender ID: transactional, reaches DND) or "sms" (/sms, promotional,
 * gateway 2: DND numbers are refunded, not delivered). The key goes in a
 * `token` field. error_code "000" is the only success, even with HTTP 200;
 * data is "234…|<message id>".
 */
export class KudiSmsAdapter implements SmsAdapter {
  readonly name = "kudisms" as const;
  private readonly base = "https://my.kudisms.net/api";

  constructor(
    private readonly token: string,
    private readonly route: "corporate" | "sms" = "corporate",
  ) {}

  async send(request: AdapterRequest): Promise<AdapterResult> {
    let reply;
    try {
      reply = await postJson(`${this.base}/${this.route}`, {
        token: this.token,
        senderID: request.senderId,
        recipients: request.to,
        message: request.message,
        ...(this.route === "sms" ? { gateway: "2" } : {}),
      });
    } catch (error) {
      return networkFailure(error);
    }
    const code = text(field(reply.body, "error_code"));
    if (reply.status < 300 && code === "000") {
      const data = field(reply.body, "data");
      const first = Array.isArray(data) ? data[0] : data;
      return { ok: true, status: "sent", providerMessageId: text(first)?.split("|")[1], raw: reply.body, retryable: false };
    }
    return {
      ok: false,
      status: "failed",
      raw: reply.body,
      error: `${code ? `${code}: ` : ""}${text(field(reply.body, "msg")) ?? `HTTP ${reply.status}`}`,
      retryable: retryableStatus(reply.status) || (code !== undefined && RETRYABLE_CODES.has(code)),
    };
  }

  /** The docs give the endpoint but not the reply's shape: read `balance` wherever it is. */
  async getBalance(): Promise<SmsBalance> {
    const reply = await postJson(`${this.base}/balance`, { token: this.token });
    const amount = money(field(reply.body, "balance") ?? field(reply.body, "data", "balance") ?? field(reply.body, "current_balance"));
    if (reply.status >= 300 || !Number.isFinite(amount)) throw new Error(`KudiSMS balance check failed (HTTP ${reply.status})`);
    return { amount, currency: "NGN", raw: reply.body };
  }
}
