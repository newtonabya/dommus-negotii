import type { Instrumentation } from "next";
import { scrub } from "@/lib/scrub";

/**
 * Runs once as each server instance starts. Production refuses to start when
 * the SMS settings can't work (a provider without its key, a bad sender ID, or
 * SMS_PROVIDER=log while SMS_ENABLED isn't false); elsewhere it only warns.
 * The message names the missing variable, never a value.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertSmsConfig } = await import("@/shell/notifications/sms/config");
  const config = assertSmsConfig();
  console.info(
    JSON.stringify({ type: "sms-config", environment: config.environment, enabled: config.enabled, provider: config.provider, fallback: config.fallback, senderId: config.senderId || null }),
  );
}

/**
 * Server errors go to the platform log as one scrubbed JSON line each, so they
 * can be searched (Vercel → Logs, filter "server-error") without exposing
 * personal data (PRD §5). An error tracker such as Sentry can hook in here.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const err = error as Error & { digest?: string };
  console.error(
    JSON.stringify({
      type: "server-error",
      digest: err.digest ?? null,
      message: scrub(err.message ?? String(error)),
      path: scrub(request.path),
      method: request.method,
      route: context.routePath,
      kind: context.routeType,
      at: new Date().toISOString(),
    }),
  );
};
