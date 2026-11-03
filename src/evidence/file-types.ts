/**
 * Evidence file rules (PRD F3): PDF, JPG, PNG, XLSX, CSV, at most 10 MB.
 * The real type is decided from the file's first bytes, never from the name
 * or the browser's claim. Safe in the browser (no Node imports).
 */

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

export const EVIDENCE_TYPES = {
  pdf: { mime: "application/pdf", label: "PDF" },
  jpg: { mime: "image/jpeg", label: "JPG" },
  png: { mime: "image/png", label: "PNG" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel (XLSX)" },
  csv: { mime: "text/csv", label: "CSV" },
} as const;

export type EvidenceType = keyof typeof EVIDENCE_TYPES;

export const ACCEPT_ATTRIBUTE = ".pdf,.jpg,.jpeg,.png,.xlsx,.csv";

/** The type a file claims by its name, or null if not allowed. */
export function typeFromName(filename: string): EvidenceType | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "jpeg" || ext === "jpg") return "jpg";
  return ext in EVIDENCE_TYPES ? (ext as EvidenceType) : null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((b, i) => bytes[i] === b);
}

function looksLikeCsv(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, lastCompleteUtf8(sample)));
  } catch {
    return false;
  }
  return true;
}

/** Index after the last complete UTF-8 character, so a cut sample still decodes. */
function lastCompleteUtf8(bytes: Uint8Array): number {
  const end = bytes.length;
  for (let back = 1; back <= 3 && end - back >= 0; back++) {
    const b = bytes[end - back] as number;
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? end - back : end;
  }
  return end;
}

/**
 * Detects the real type from the file's content. XLSX is a ZIP whose entries
 * include [Content_Types].xml and xl/; CSV is valid UTF-8 text with no NULs.
 */
export function detectType(bytes: Uint8Array): EvidenceType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
    return head.includes("[Content_Types].xml") && head.includes("xl/") ? "xlsx" : null;
  }
  return looksLikeCsv(bytes) ? "csv" : null;
}

export type FileCheck =
  | { ok: true; type: EvidenceType }
  | { ok: false; reason: string };

/** Full check of an uploaded file against its declared name. */
export function checkEvidenceFile(filename: string, bytes: Uint8Array): FileCheck {
  if (bytes.length === 0) return { ok: false, reason: "The file is empty." };
  if (bytes.length > MAX_EVIDENCE_BYTES) return { ok: false, reason: "The file is larger than 10 MB." };
  const claimed = typeFromName(filename);
  if (!claimed) return { ok: false, reason: "Only PDF, JPG, PNG, XLSX and CSV files are accepted." };
  const actual = detectType(bytes);
  if (actual !== claimed) {
    return { ok: false, reason: `The file's content doesn't match its .${filename.split(".").pop()} name.` };
  }
  return { ok: true, type: actual };
}
