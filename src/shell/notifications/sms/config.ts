import { toMsisdn } from "./phone";
import { SMS_PROVIDERS, type SmsProviderName } from "./types";

export type SmsEnvironment = "production" | "staging" | "development" | "test";

export interface SmsConfig {
  enabled: boolean;
  provider: SmsProviderName;
  fallback: SmsProviderName | null;
  senderId: string;
  /** Staging only: the numbers (as 234…) allowed to receive real SMS. */
  testRecipients: string[];
  /** Put in front of every message outside production. */
  stagingPrefix: string;
  environment: SmsEnvironment;
  /** Shared secret in the delivery-report URL; reports are refused without it. */
  webhookSecret: string | null;
  /** The site's address, for delivery-report URLs. */
  appUrl: string | null;
}

/** Production, staging (APP_STAGE=staging, also NODE_ENV=production on Vercel), development or test. */
export function smsEnvironment(env: NodeJS.ProcessEnv = process.env): SmsEnvironment {
  if (env.APP_STAGE === "staging") return "staging";
  if (env.NODE_ENV === "production") return "production";
  if (env.NODE_ENV === "test") return "test";
  return "development";
}

/** The variables each provider needs. */
export const REQUIRED_VARS: Record<SmsProviderName, string[]> = {
  log: [],
  bulksmsnigeria: ["BULKSMSNIGERIA_API_TOKEN"],
  smsto: ["SMSTO_API_KEY"],
  africastalking: ["AFRICASTALKING_USERNAME", "AFRICASTALKING_API_KEY"],
  kudisms: ["KUDISMS_API_KEY"],
  termii: ["TERMII_API_KEY"],
};

const isProvider = (value: string): value is SmsProviderName => (SMS_PROVIDERS as readonly string[]).includes(value);
const val = (env: NodeJS.ProcessEnv, name: string) => (env[name] ?? "").trim();

export const africasTalkingSandbox = (env: NodeJS.ProcessEnv) => val(env, "AFRICASTALKING_SANDBOX").toLowerCase() === "true" || val(env, "AFRICASTALKING_USERNAME") === "sandbox";

/**
 * Reads and checks the SMS settings. Returns the problems instead of throwing,
 * so a send can report them; `assertSmsConfig` turns them into a startup failure.
 * Nothing here ever includes a key's value.
 */
export function readSmsConfig(env: NodeJS.ProcessEnv = process.env): { config: SmsConfig; problems: string[] } {
  const problems: string[] = [];
  const environment = smsEnvironment(env);
  const enabled = val(env, "SMS_ENABLED").toLowerCase() !== "false";

  // SMS_PROVIDER, else the older Termii-only settings, else the log driver.
  const rawProvider = val(env, "SMS_PROVIDER").toLowerCase() || (val(env, "TERMII_API_KEY") ? "termii" : "log");
  let provider: SmsProviderName = "log";
  if (isProvider(rawProvider)) provider = rawProvider;
  else problems.push(`SMS_PROVIDER "${rawProvider}" is not one of: ${SMS_PROVIDERS.join(", ")}.`);

  const rawFallback = val(env, "SMS_FALLBACK_PROVIDER").toLowerCase();
  let fallback: SmsProviderName | null = null;
  if (rawFallback) {
    if (!isProvider(rawFallback) || rawFallback === "log") problems.push(`SMS_FALLBACK_PROVIDER "${rawFallback}" must be a real provider: ${SMS_PROVIDERS.filter((p) => p !== "log").join(", ")}.`);
    else if (rawFallback !== provider) fallback = rawFallback;
  }

  const senderId = val(env, "SMS_SENDER_ID") || val(env, "TERMII_SENDER_ID");
  const testRecipients = val(env, "SMS_TEST_RECIPIENTS")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    .flatMap((n) => {
      const msisdn = toMsisdn(n);
      if (!msisdn) problems.push(`SMS_TEST_RECIPIENTS has an invalid number: "${n}".`);
      return msisdn ? [msisdn] : [];
    });

  if (enabled) {
    for (const p of [provider, ...(fallback ? [fallback] : [])]) {
      for (const name of REQUIRED_VARS[p]) if (!val(env, name)) problems.push(`SMS provider "${p}" needs ${name}.`);
    }
    const needsSender = provider !== "log" && !(provider === "africastalking" && africasTalkingSandbox(env));
    if (needsSender && !senderId) problems.push("SMS_SENDER_ID is empty: set the approved sender ID (e.g. MOAUMCSL).");
    if (senderId && !/^[A-Za-z0-9]{3,11}$/.test(senderId)) problems.push("SMS_SENDER_ID must be 3 to 11 letters or digits, no spaces (e.g. MOAUMCSL).");
    if (environment === "production" && provider === "log") {
      problems.push("SMS_PROVIDER is \"log\" in production, so no SMS would be sent. Set a real provider, or SMS_ENABLED=false to run without SMS.");
    }
  }

  const appUrl = (val(env, "BETTER_AUTH_URL") || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : "")).replace(/\/$/, "") || null;
  return {
    config: {
      enabled,
      provider,
      fallback,
      senderId,
      testRecipients,
      stagingPrefix: env.SMS_STAGING_PREFIX === undefined ? "[STAGING]" : val(env, "SMS_STAGING_PREFIX"),
      environment,
      webhookSecret: val(env, "SMS_WEBHOOK_SECRET") || null,
      appUrl,
    },
    problems,
  };
}

/** Startup check (src/instrumentation.ts): production refuses to boot with broken SMS settings. */
export function assertSmsConfig(env: NodeJS.ProcessEnv = process.env): SmsConfig {
  const { config, problems } = readSmsConfig(env);
  if (problems.length === 0) return config;
  const message = `SMS settings are not usable:\n- ${problems.join("\n- ")}`;
  if (config.environment === "production") throw new Error(message);
  console.warn(`[sms] ${message}`);
  return config;
}
