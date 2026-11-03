import { checkEvidenceFile, detectType, MAX_EVIDENCE_BYTES, typeFromName } from "@/evidence/file-types";
import { fileKey, LocalEvidenceStore, stagingKey } from "@/evidence/store";
import { hasPermission } from "@/shell/rbac/permissions";
import { moduleForRole, type Role } from "@/shell/rbac/roles";

const bytes = (...parts: Array<string | number[]>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));

export const samples = {
  pdf: bytes("%PDF-1.7\n%âãÏÓ\n1 0 obj\n"),
  png: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "IHDR"),
  jpg: bytes([0xff, 0xd8, 0xff, 0xe0], "JFIF"),
  xlsx: bytes([0x50, 0x4b, 0x03, 0x04], "....[Content_Types].xml....xl/workbook.xml"),
  csv: bytes("member_moaum_id,amount\nMA-001,17500.00\nMA-002,₦12,500\n"),
};

describe("evidence file types (PRD F3)", () => {
  it.each(Object.entries(samples))("detects %s from its content", (type, content) => {
    expect(detectType(content)).toBe(type);
  });

  it("maps names to types, including .jpeg", () => {
    expect(typeFromName("Slip.JPEG")).toBe("jpg");
    expect(typeFromName("schedule.xlsx")).toBe("xlsx");
    expect(typeFromName("virus.exe")).toBeNull();
    expect(typeFromName("noextension")).toBeNull();
  });

  it("rejects a file whose content doesn't match its name", () => {
    const result = checkEvidenceFile("slip.pdf", samples.png);
    expect(result.ok).toBe(false);
  });

  it("rejects ZIPs that aren't spreadsheets, and binary files named .csv", () => {
    expect(detectType(bytes([0x50, 0x4b, 0x03, 0x04], "word/document.xml"))).toBeNull();
    expect(checkEvidenceFile("data.csv", bytes("a,b", [0, 1, 2])).ok).toBe(false);
  });

  it("enforces the 10 MB limit and refuses empty files", () => {
    expect(checkEvidenceFile("big.csv", new Uint8Array(MAX_EVIDENCE_BYTES + 1).fill(65)).ok).toBe(false);
    expect(checkEvidenceFile("ok.csv", new Uint8Array(MAX_EVIDENCE_BYTES).fill(65)).ok).toBe(true);
    expect(checkEvidenceFile("empty.pdf", new Uint8Array()).ok).toBe(false);
  });

  it("accepts CSV even when the sample cuts a multi-byte character", () => {
    const naira = new TextEncoder().encode("₦"); // 3 bytes
    const content = new Uint8Array(64 * 1024 + 2).fill(65);
    content.set(naira, 64 * 1024 - 1); // straddles the 64 KB sample edge
    expect(detectType(content)).toBe("csv");
  });
});

describe("storage keys", () => {
  it("files evidence by checksum", () => {
    const sha = "ab".repeat(32);
    expect(fileKey(sha)).toBe(`files/ab/${sha}`);
    expect(stagingKey("1f0e")).toBe("staging/1f0e");
  });
});

describe("local store signed URLs", () => {
  const store = new LocalEvidenceStore("unused-dir", "test-secret");
  const now = Date.UTC(2026, 10, 3, 9, 0);

  it("verifies its own signature within 5 minutes", () => {
    const url = store.sign({ op: "get", key: "files/ab/abc", ct: "application/pdf", fn: "slip.pdf" }, now);
    const params = new URL(url, "http://localhost").searchParams;
    expect(store.verify(params, now + 4 * 60_000)).toMatchObject({ op: "get", key: "files/ab/abc" });
    expect(store.verify(params, now + 6 * 60_000)).toBeNull();
  });

  it("rejects altered URLs and path tricks", () => {
    const url = store.sign({ op: "put", key: "staging/x1", ct: "text/csv", fn: "" }, now);
    const params = new URL(url, "http://localhost").searchParams;
    params.set("key", "staging/x2");
    expect(store.verify(params, now)).toBeNull();
    params.set("key", "../../etc/passwd");
    expect(store.verify(params, now)).toBeNull();
    const other = new LocalEvidenceStore("unused-dir", "another-secret");
    expect(other.verify(new URL(url, "http://localhost").searchParams, now)).toBeNull();
  });
});

describe("evidence permissions", () => {
  const can = (role: Role, action: "evidence.upload" | "evidence.read") =>
    hasPermission([{ role, moduleCode: moduleForRole(role) }], action);

  it("lets Credit staff upload and read evidence", () => {
    for (const role of ["TREASURER", "FINANCE_MANAGER", "CASHIER", "LOAN_OFFICER"] as const) {
      expect(can(role, "evidence.upload")).toBe(true);
      expect(can(role, "evidence.read")).toBe(true);
    }
  });

  it("gives the Auditor read-only access", () => {
    expect(can("AUDITOR", "evidence.read")).toBe(true);
    expect(can("AUDITOR", "evidence.upload")).toBe(false);
  });

  it("gives Admin and Secretary no access to evidence", () => {
    for (const role of ["ADMIN", "SECRETARY"] as const) {
      expect(can(role, "evidence.read")).toBe(false);
      expect(can(role, "evidence.upload")).toBe(false);
    }
  });
});
