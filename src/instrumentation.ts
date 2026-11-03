import type { Instrumentation } from "next";
import { scrub } from "@/lib/scrub";

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
