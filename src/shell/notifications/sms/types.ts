/**
 * The SMS contract. The rest of the app sends through `sendSms` (index.ts),
 * never through an adapter directly; adapters only speak to one provider.
 */

export const SMS_PROVIDERS = ["log", "bulksmsnigeria", "smsto", "africastalking", "kudisms", "termii"] as const;
export type SmsProviderName = (typeof SMS_PROVIDERS)[number];

/** Where a message ended up. `skipped_staging`: staging, recipient not on SMS_TEST_RECIPIENTS. */
export type SmsStatus = "queued" | "sent" | "delivered" | "failed" | "skipped_staging" | "disabled";

export interface SmsRequest {
  /** Any common Nigerian form: 0803…, 803…, +234803…, 234803…. */
  to: string;
  message: string;
  /** Caller's reference (e.g. the outbox key). The outbox makes it send-once. */
  reference?: string;
  /** Holds a one-time code: never printed or logged in full. */
  sensitive?: boolean;
}

export interface SmsResult {
  ok: boolean;
  /** The provider that handled it last (the fallback, if failover happened). */
  provider: SmsProviderName;
  providerMessageId?: string;
  status: SmsStatus;
  /** The provider's answer (keys removed), for the log. */
  raw: unknown;
  error?: string;
  /** Worth trying again later (network trouble or a provider outage), not a bad number or sender. */
  retryable: boolean;
  /** 2348031234567, or null when the number was invalid. */
  to: string | null;
  segments: number;
  encoding: "GSM-7" | "UCS-2";
  attempts: number;
}

/** What an adapter receives: everything already checked and formatted. */
export interface AdapterRequest {
  /** Always 234XXXXXXXXXX (no plus); adapters reformat if their API wants otherwise. */
  to: string;
  message: string;
  senderId: string;
  unicode: boolean;
  reference?: string;
  /** Delivery-report URL for providers that take one per message. */
  callbackUrl?: string;
  /** Holds a one-time code (the log driver masks it). */
  sensitive?: boolean;
}

export interface AdapterResult {
  ok: boolean;
  status: "queued" | "sent" | "failed";
  providerMessageId?: string;
  raw: unknown;
  error?: string;
  /** True only for network errors, timeouts, 429 and 5xx: never for a bad number or sender ID. */
  retryable: boolean;
}

export interface SmsBalance {
  amount: number;
  currency: string;
  raw: unknown;
}

export interface SmsAdapter {
  readonly name: SmsProviderName;
  send(request: AdapterRequest): Promise<AdapterResult>;
  getBalance?(): Promise<SmsBalance>;
}
