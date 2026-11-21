import type { AdapterRequest, AdapterResult, SmsAdapter } from "../types";

/** Hides one-time codes (4 to 8 digits in a row). */
export const maskCodes = (text: string) => text.replace(/\b\d{4,8}\b/g, (m) => "•".repeat(m.length));

/**
 * Sends nothing: prints the message to the server log, so development and
 * staging cost ₦0. Codes are masked unless SMS_LOG_SHOW_CODES=true (never
 * honoured in production, where this driver can't run anyway).
 */
export class LogAdapter implements SmsAdapter {
  readonly name = "log" as const;
  constructor(private readonly showCodes = false) {}

  async send(request: AdapterRequest): Promise<AdapterResult> {
    const body = request.sensitive && !this.showCodes ? maskCodes(request.message) : request.message;
    console.info(`\n[sms:log] to ${request.to} from ${request.senderId || "(no sender ID)"}\n${body}\n`);
    return { ok: true, status: "sent", providerMessageId: `log-${Date.now().toString(36)}`, raw: { printed: true }, retryable: false };
  }
}
