// Decrypts a nightly backup (docs/RESTORE.md).
// Usage: node scripts/decrypt-backup.mjs <backup.dump.age> <output.dump> [private key file]
// The key file defaults to backup-private-key.txt; lines starting with # are ignored.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Decrypter } from "age-encryption";

const [input, output, keyFile = "backup-private-key.txt"] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: node scripts/decrypt-backup.mjs <backup.dump.age> <output.dump> [private key file]");
  process.exit(2);
}
if (existsSync(output)) {
  console.error(`${output} already exists; choose another name.`);
  process.exit(2);
}

const identity = readFileSync(keyFile, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .find((l) => l.startsWith("AGE-SECRET-KEY-"));
if (!identity) {
  console.error(`No AGE-SECRET-KEY line found in ${keyFile}.`);
  process.exit(2);
}

const encrypted = readFileSync(input);
const sumFile = `${input}.sha256`;
if (existsSync(sumFile)) {
  const expected = readFileSync(sumFile, "utf8").split(/\s+/)[0];
  const actual = createHash("sha256").update(encrypted).digest("hex");
  if (expected !== actual) {
    console.error(`Checksum mismatch: the file is damaged or not the one that was backed up.\n expected ${expected}\n actual   ${actual}`);
    process.exit(1);
  }
  console.log("Checksum OK.");
}

const decrypter = new Decrypter();
decrypter.addIdentity(identity);
const dump = await decrypter.decrypt(new Uint8Array(encrypted));
if (new TextDecoder().decode(dump.slice(0, 5)) !== "PGDMP") {
  console.error("Decrypted, but this is not a pg_dump custom-format file.");
  process.exit(1);
}
writeFileSync(output, dump);
console.log(`Wrote ${output} (${dump.length} bytes). Restore it with pg_restore as described in docs/RESTORE.md.`);
