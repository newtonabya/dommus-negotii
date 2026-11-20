import { africasTalkingSandbox, readSmsConfig, type SmsConfig } from "./config";
import { createAdapter, PER_MESSAGE_CALLBACK } from "./factory";
import { INVALID_NUMBER, toMsisdn } from "./phone";
import { countSegments, SEGMENT_WARNING } from "./segments";
import type { AdapterResult, SmsAdapter, SmsBalance, SmsProviderName, SmsRequest, SmsResult } from "./types";

export type { SmsRequest, SmsResult, SmsBalance, SmsProviderName } from "./types";

/** Waits between tries on network/5xx errors: two retries, then give up. */
export const RETRY_DELAYS_MS = [1_000, 3_000];

export interface SendOptions {
  env?: NodeJS.ProcessEnv;
  /** Tests: replace the provider adapters. */
  adapter?: (name: SmsProviderName) => SmsAdapter;
  /** Tests: skip the real waiting between retries. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Staging with a real gateway only texts the numbers on SMS_TEST_RECIPIENTS (Africa's Talking sandbox and the log driver text no one). */
export function blockedOnStaging(config: SmsConfig, msisdn: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (config.environment !== "staging" || config.provider === "log") return false;
  if (config.provider === "africastalking" && africasTalkingSandbox(env)) return false;
  return !config.testRecipients.includes(msisdn);
}

async function trySend(adapter: SmsAdapter, request: Parameters<SmsAdapter["send"]>[0], retries: number, sleep: (ms: number) => Promise<void>) {
  let attempts = 0;
  let result: AdapterResult;
  for (;;) {
    attempts++;
    result = await adapter.send(request);
    if (result.ok || !result.retryable || attempts > retries) return { result, attempts };
    await sleep(RETRY_DELAYS_MS[attempts - 1] ?? 3_000);
  }
}

/**
 * Sends one SMS through the configured provider. The only way the app sends
 * SMS: callers go through the notification outbox (notify / queueFor…), which
 * calls this. Never throws for a provider problem: the result says what happened.
 */
export async function sendSms(input: SmsRequest, options: SendOptions = {}): Promise<SmsResult> {
  const env = options.env ?? process.env;
  const { config, problems } = readSmsConfig(env);
  const shaped = config.environment === "production" || !config.stagingPrefix ? input.message : `${config.stagingPrefix} ${input.message}`;
  const { segments, encoding } = countSegments(shaped);
  const base = { provider: config.provider, raw: null, segments, encoding, attempts: 0 } as const;

  const msisdn = toMsisdn(input.to);
  if (!msisdn) return { ...base, ok: false, status: "failed", to: null, error: INVALID_NUMBER, retryable: false };
  if (!config.enabled) return { ...base, ok: false, status: "disabled", to: msisdn, error: "SMS is switched off (SMS_ENABLED=false)", retryable: false };
  if (problems.length) return { ...base, ok: false, status: "failed", to: msisdn, error: problems.join(" "), retryable: false };

  if (config.environment === "development" && segments > SEGMENT_WARNING) {
    console.warn(`[sms] ${input.reference ?? "message"} is ${segments} SMS units (${encoding}, ${shaped.length} characters); each unit is charged.`);
  }
  if (blockedOnStaging(config, msisdn, env)) {
    return { ...base, ok: true, status: "skipped_staging", to: msisdn, raw: { skipped: "not on SMS_TEST_RECIPIENTS" }, retryable: false };
  }

  const make = options.adapter ?? ((name: SmsProviderName) => createAdapter(name, env));
  const sleep = options.sleep ?? wait;
  const request = (name: SmsProviderName) => ({
    to: msisdn,
    message: shaped,
    senderId: config.senderId,
    unicode: encoding === "UCS-2",
    reference: input.reference,
    sensitive: input.sensitive,
    callbackUrl:
      config.webhookSecret && config.appUrl && PER_MESSAGE_CALLBACK.has(name)
        ? `${config.appUrl}/api/v1/sms/delivery/${name}?token=${encodeURIComponent(config.webhookSecret)}`
        : undefined,
  });

  const primary = await trySend(make(config.provider), request(config.provider), RETRY_DELAYS_MS.length, sleep);
  let used: SmsProviderName = config.provider;
  let { result } = primary;
  let attempts = primary.attempts;
  // Fail over only when the primary itself is unreachable or failing, never for a bad number or sender ID.
  if (!result.ok && result.retryable && config.fallback && config.environment !== "development") {
    const second = await trySend(make(config.fallback), request(config.fallback), 0, sleep);
    result = second.result;
    attempts += second.attempts;
    used = config.fallback;
  }
  return {
    ok: result.ok,
    provider: used,
    providerMessageId: result.providerMessageId,
    status: result.status,
    raw: result.raw,
    error: result.error,
    retryable: result.retryable,
    to: msisdn,
    segments,
    encoding,
    attempts,
  };
}

/** The configured provider's wallet balance, or null when it has none to report (log driver, SMS off). */
export async function getSmsBalance(env: NodeJS.ProcessEnv = process.env): Promise<(SmsBalance & { provider: SmsProviderName }) | null> {
  const { config, problems } = readSmsConfig(env);
  if (!config.enabled || config.provider === "log" || problems.length) return null;
  const adapter = createAdapter(config.provider, env);
  if (!adapter.getBalance) return null;
  return { ...(await adapter.getBalance()), provider: config.provider };
}
