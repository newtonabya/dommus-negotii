/**
 * Checks a Termii account from this computer, before production uses it.
 * Nothing here touches staging or any database.
 *
 * 1. Create .env.termii.local in the project folder (git-ignored; only you edit it):
 *      TERMII_API_KEY=your key
 *      TERMII_SENDER_ID=your sender ID, e.g. MOAUM
 *      TERMII_BASE_URL=https://api.ng.termii.com   (the base URL your Termii dashboard shows)
 *      TERMII_ROUTE=dnd
 *
 * 2. Check the key and the sender ID (free, sends nothing):
 *      npx --yes tsx@4.23.15 scripts/termii-check.mts
 *
 * 3. Send ONE test SMS, only when you mean to (costs one SMS unit):
 *      npx --yes tsx@4.23.15 scripts/termii-check.mts --send 0803XXXXXXX
 *
 * The key is never printed.
 */
import { existsSync } from "node:fs";
import { config } from "dotenv";

const FILE = ".env.termii.local";
if (!existsSync(FILE)) {
  console.log(`No ${FILE} yet. Create it in the project folder with TERMII_API_KEY, TERMII_SENDER_ID, TERMII_BASE_URL and TERMII_ROUTE (see the top of this script).`);
  process.exit(1);
}
config({ path: FILE, quiet: true, override: true });

const { TermiiProvider } = await import("@/shell/notifications/providers");
const { normalizeNigerianPhone } = await import("@/shell/auth/phone");

const key = (process.env.TERMII_API_KEY ?? "").trim();
const senderId = (process.env.TERMII_SENDER_ID ?? "").trim();
const base = (process.env.TERMII_BASE_URL ?? "https://api.ng.termii.com").trim().replace(/\/$/, "");
const route = (process.env.TERMII_ROUTE ?? "dnd").trim();
const hide = (text: string) => (key ? text.split(key).join("[key]") : text);
const missing = [!key && "TERMII_API_KEY", !senderId && "TERMII_SENDER_ID"].filter(Boolean);
if (missing.length) {
  console.log(`${FILE} is missing ${missing.join(" and ")}.`);
  process.exit(1);
}
console.log(`Termii at ${base}, sender ID "${senderId}", route "${route}".`);

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(key)}`);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the text
  }
  return { status: res.status, body };
}

// 1. The key: Termii's balance check costs nothing.
const balance = await getJson("/api/get-balance");
if (balance.status !== 200) {
  console.log(`✗ The key was not accepted (HTTP ${balance.status}): ${hide(JSON.stringify(balance.body)).slice(0, 300)}`);
  console.log("  Check TERMII_API_KEY and TERMII_BASE_URL against your Termii dashboard.");
  process.exit(1);
}
const b = balance.body as { balance?: number | string; currency?: string };
console.log(`✓ The key works. Wallet balance: ${b.currency ?? "NGN"} ${Number(b.balance).toFixed(2)}.`);
if (Number(b.balance) <= 0) console.log("  The wallet is empty: fund it before any SMS can be sent.");

// 2. The sender ID: is it registered and approved?
const senders = await getJson("/api/sender-id");
if (senders.status === 200) {
  const list = ((senders.body as { data?: Array<{ sender_id?: string; status?: string }> }).data ?? []) as Array<{ sender_id?: string; status?: string }>;
  const mine = list.find((s) => (s.sender_id ?? "").toLowerCase() === senderId.toLowerCase());
  if (!mine) console.log(`✗ Sender ID "${senderId}" is not on this account. Registered: ${list.map((s) => `${s.sender_id} (${s.status})`).join(", ") || "none"}.`);
  else if (!/approved|active/i.test(mine.status ?? "")) console.log(`✗ Sender ID "${senderId}" is ${mine.status}: wait for Termii to approve it before sending.`);
  else console.log(`✓ Sender ID "${senderId}" is ${mine.status}.`);
} else {
  console.log(`? Couldn't list sender IDs (HTTP ${senders.status}); check it on the Termii dashboard.`);
}

// 3. One test SMS, only on request.
const at = process.argv.indexOf("--send");
if (at === -1) {
  console.log("\nNothing was sent. To send one test SMS: npx --yes tsx@4.23.15 scripts/termii-check.mts --send 0803XXXXXXX");
  process.exit(0);
}
const to = normalizeNigerianPhone(process.argv[at + 1] ?? "");
if (!to) {
  console.log("Give a Nigerian mobile number after --send, e.g. --send 08031234567.");
  process.exit(1);
}
const provider = new TermiiProvider(key, senderId, base, route);
const result = await provider.send({ channel: "SMS", to, text: "MOAUM Credit Super Store: test message from the portal set-up. No action needed." });
console.log(
  result.ok
    ? `✓ Termii accepted the SMS to ${to} (message id ${result.providerMessageId ?? "not given"}). Check that it arrives, and from "${senderId}".`
    : `✗ Termii refused the SMS: ${hide(JSON.stringify(result.response)).slice(0, 400)}`,
);
