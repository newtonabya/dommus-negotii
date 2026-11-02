import { createHash } from "node:crypto";

/** SHA-256 of file bytes as lowercase hex (PRD F3). */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

type Canonical = string | number | boolean | bigint | null | Canonical[] | { [key: string]: Canonical };

/** Stable serialisation: object keys sorted, bigints as strings. */
export function canonicalJson(value: Canonical): string {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? JSON.stringify(value.toString()) : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as Canonical)}`).join(",")}}`;
}

/** Hash of an import row's normalised fields, used for duplicate detection (PRD F9). */
export function rowHash(row: { [key: string]: Canonical }): string {
  return sha256Hex(canonicalJson(row));
}
