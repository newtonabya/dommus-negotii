// Gives the app_runtime role a fresh random password and writes the app's
// pooled DATABASE_URL into an env file. Never prints the password.
//
// Usage: node scripts/set-runtime-password.mjs [envFile=.env.local] [VAR=DATABASE_URL] [OWNER_VAR=DIRECT_URL]
// OWNER_VAR must hold the owner role's direct (non-pooled) Neon connection string.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";

const [envFile = ".env.local", targetVar = "DATABASE_URL", ownerVar = "DIRECT_URL"] = process.argv.slice(2);
config({ path: envFile, quiet: true });

const ownerUrl = process.env[ownerVar];
if (!ownerUrl) throw new Error(`${ownerVar} is not set in ${envFile}`);

// Alphanumeric only, so it needs no URL encoding. ~190 bits.
const password = randomBytes(48).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 32);

const client = new pg.Client({ connectionString: ownerUrl });
await client.connect();
await client.query(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${password}'`);
await client.end();

// Neon's pooled host is the endpoint id with "-pooler" appended.
const url = new URL(ownerUrl);
const [endpoint, ...rest] = url.hostname.split(".");
url.hostname = [endpoint.endsWith("-pooler") ? endpoint : `${endpoint}-pooler`, ...rest].join(".");
url.username = "app_runtime";
url.password = password;

const line = `${targetVar}="${url.toString()}"`;
let text = readFileSync(envFile, "utf8");
const pattern = new RegExp(`^${targetVar}=.*$`, "m");
text = pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n# app_runtime role, pooled connection: the app.\n${line}\n`;
writeFileSync(envFile, text);
console.log(`app_runtime can log in; ${targetVar} written to ${envFile} (host ${url.hostname})`);
