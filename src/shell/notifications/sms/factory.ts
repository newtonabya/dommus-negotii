import { AfricasTalkingAdapter } from "./adapters/africastalking";
import { BulkSmsNigeriaAdapter } from "./adapters/bulksmsnigeria";
import { KudiSmsAdapter } from "./adapters/kudisms";
import { LogAdapter } from "./adapters/log";
import { SmsToAdapter } from "./adapters/smsto";
import { TermiiAdapter } from "./adapters/termii";
import { africasTalkingSandbox, smsEnvironment } from "./config";
import type { SmsAdapter, SmsProviderName } from "./types";

const val = (env: NodeJS.ProcessEnv, name: string) => (env[name] ?? "").trim();

/** Builds the adapter named by SMS_PROVIDER (or SMS_FALLBACK_PROVIDER) from its env vars. */
export function createAdapter(name: SmsProviderName, env: NodeJS.ProcessEnv = process.env): SmsAdapter {
  switch (name) {
    case "log":
      return new LogAdapter(smsEnvironment(env) !== "production" && val(env, "SMS_LOG_SHOW_CODES").toLowerCase() === "true");
    case "bulksmsnigeria":
      return new BulkSmsNigeriaAdapter(val(env, "BULKSMSNIGERIA_API_TOKEN"), {
        sandbox: val(env, "BULKSMSNIGERIA_SANDBOX").toLowerCase() === "true",
        gateway: val(env, "BULKSMSNIGERIA_GATEWAY") || "corporate",
      });
    case "smsto":
      return new SmsToAdapter(val(env, "SMSTO_API_KEY"));
    case "africastalking":
      return new AfricasTalkingAdapter(val(env, "AFRICASTALKING_USERNAME") || "sandbox", val(env, "AFRICASTALKING_API_KEY"), africasTalkingSandbox(env));
    case "kudisms":
      return new KudiSmsAdapter(val(env, "KUDISMS_API_KEY"), val(env, "KUDISMS_ROUTE").toLowerCase() === "sms" ? "sms" : "corporate");
    case "termii":
      return new TermiiAdapter(val(env, "TERMII_API_KEY"), val(env, "TERMII_BASE_URL") || "https://api.ng.termii.com", val(env, "TERMII_ROUTE") || "dnd");
  }
}

/** Providers that take a delivery-report URL with each message (the others are set once in their dashboard). */
export const PER_MESSAGE_CALLBACK: ReadonlySet<SmsProviderName> = new Set(["bulksmsnigeria", "smsto"]);
