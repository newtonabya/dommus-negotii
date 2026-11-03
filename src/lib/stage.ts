/**
 * APP_STAGE=staging marks the staging deployment: SMS and email are written to
 * the server log instead of sent, and every page shows a staging banner.
 * Production never sets it.
 */
export function isStaging(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APP_STAGE === "staging";
}
