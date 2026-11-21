/**
 * Checks the SMS set-up from this computer: shows the configured provider and
 * its balance, and sends ONE test SMS only when you give a number. Touches no
 * database. Keys are never printed.
 *
 * 1. Put the settings in .env.sms.local in the project folder (git-ignored; only you edit it),
 *    the same names as .env.example, e.g.:
 *      SMS_PROVIDER=bulksmsnigeria
 *      SMS_SENDER_ID=MOAUMCSL
 *      BULKSMSNIGERIA_API_TOKEN=your token
 *    (An older .env.termii.local is still read when .env.sms.local doesn't exist.)
 *
 * 2. Settings and balance (free, sends nothing):
 *      npx --yes tsx@4.23.15 scripts/sms-test.mts
 *
 * 3. Send one test SMS (costs one SMS unit):
 *      npx --yes tsx@4.23.15 scripts/sms-test.mts 08031234567 "Hello from MOAUM"
 *
 * The settings file decides the environment. If it says NODE_ENV=production
 * (no APP_STAGE), sending also needs --live, so a production key is never used by accident.
 */
import { existsSync } from "node:fs";
import { config } from "dotenv";

const FILE = existsSync(".env.sms.local") ? ".env.sms.local" : existsSync(".env.termii.local") ? ".env.termii.local" : null;
if (!FILE) {
  console.log("No .env.sms.local yet. Create it in the project folder with SMS_PROVIDER, SMS_SENDER_ID and the provider's key (see .env.example).");
  process.exit(1);
}
config({ path: FILE, quiet: true, override: true });

const { readSmsConfig } = await import("@/shell/notifications/sms/config");
const { getSmsBalance, sendSms } = await import("@/shell/notifications/sms");
const { smsTemplates } = await import("@/shell/notifications/sms/templates");

const { config: sms, problems } = readSmsConfig();
console.log(`Settings from ${FILE}:`);
console.log(`  environment ${sms.environment}, SMS ${sms.enabled ? "on" : "off"}, provider ${sms.provider}${sms.fallback ? `, fallback ${sms.fallback}` : ""}, sender ID ${sms.senderId || "(none)"}`);
if (sms.environment === "staging") console.log(`  staging test numbers: ${sms.testRecipients.join(", ") || "(none: every number is skipped)"}`);
if (problems.length) {
  console.log(`✗ Not usable yet:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

try {
  const balance = await getSmsBalance();
  console.log(balance ? `✓ Balance: ${balance.currency} ${balance.amount.toFixed(2)}${balance.amount <= 0 ? "  (empty: fund the wallet before sending)" : ""}` : "  Balance: not available for this provider/driver.");
} catch (error) {
  console.log(`✗ Balance check failed: ${error instanceof Error ? error.message : String(error)} (check the key).`);
}

const args = process.argv.slice(2).filter((a) => a !== "--live");
const [to, ...words] = args;
if (!to) {
  console.log('\nNothing was sent. To send one test SMS: npx --yes tsx@4.23.15 scripts/sms-test.mts 08031234567 "Hello"');
  process.exit(0);
}
if (sms.environment === "production" && !process.argv.includes("--live")) {
  console.log("These are production settings: add --live to send for real.");
  process.exit(1);
}
const result = await sendSms({ to, message: words.join(" ") || smsTemplates.test(), reference: `sms-test:${Date.now()}` });
console.log(`\n${result.ok && result.status !== "skipped_staging" ? "✓" : "✗"} ${result.status} via ${result.provider} after ${result.attempts} attempt(s)`);
console.log(JSON.stringify({ ...result, raw: result.raw }, null, 2));
