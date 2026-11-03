/**
 * Evidence repository against the test database and a temporary local store
 * (PRD F3, AT-n). Skipped when TEST_DATABASE_URL is not set.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import {
  beginUpload,
  DuplicateEvidenceError,
  EvidenceError,
  EvidenceTamperedError,
  finishUpload,
  linkEvidence,
  openEvidence,
} from "@/evidence/service";
import { LocalEvidenceStore } from "@/evidence/store";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(60_000);

describeDb("evidence repository", () => {
  let db: PrismaClient;
  let dir: string;
  let store: LocalEvidenceStore;
  const actor = { id: `test-user-${randomUUID()}`, ipAddress: "127.0.0.1" };

  beforeAll(async () => {
    db = createClient(url as string);
    for (let attempt = 1; ; attempt++) {
      try {
        await db.$queryRaw`SELECT 1`;
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
    dir = await mkdtemp(path.join(tmpdir(), "evidence-"));
    store = new LocalEvidenceStore(dir, "test-secret");
  });

  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  /** Simulates the browser: begin, PUT the bytes to staging, finish. */
  async function upload(filename: string, content: Uint8Array, who = actor) {
    const begun = await beginUpload(db, store, who, { filename, size: content.length });
    await store.putFile(`staging/${begun.uploadId}`, content);
    return { begun, finished: () => finishUpload(db, store, who, begun.uploadId) };
  }

  const uniqueCsv = () => new TextEncoder().encode(`run,${randomUUID()}\nrow,17500.00\n`);

  it("hashes server-side and files the upload by checksum", async () => {
    const content = uniqueCsv();
    const { finished } = await upload("schedule.csv", content);
    const result = await finished();
    expect(result.sha256).toBe(sha256Hex(content));
    expect(result.reused).toBe(false);
    const row = await db.evidenceFile.findUniqueOrThrow({ where: { id: result.evidenceId } });
    expect(row).toMatchObject({ sha256: sha256Hex(content), mimeType: "text/csv", sizeBytes: content.length, uploadedById: actor.id });
    expect(await store.exists(`staging/${(await upload("x.csv", uniqueCsv())).begun.uploadId}`)).toBe(true);
  });

  it("reuses an identical file instead of storing it twice", async () => {
    const content = uniqueCsv();
    const first = await (await upload("a.csv", content)).finished();
    const second = await (await upload("copy-of-a.csv", content)).finished();
    expect(second.reused).toBe(true);
    expect(second.evidenceId).toBe(first.evidenceId);
    expect(await db.evidenceFile.count({ where: { sha256: first.sha256 } })).toBe(1);
  });

  it("rejects a file whose content doesn't match its name and removes the staged copy", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const { begun, finished } = await upload("slip.pdf", png);
    await expect(finished()).rejects.toThrow(EvidenceError);
    const record = await db.evidenceUpload.findUniqueOrThrow({ where: { id: begun.uploadId } });
    expect(record.rejectedReason).toMatch(/doesn't match/);
    expect(await store.exists(`staging/${begun.uploadId}`)).toBe(false);
  });

  it("refuses to finish someone else's upload", async () => {
    const { begun } = await upload("mine.csv", uniqueCsv());
    await expect(finishUpload(db, store, { id: "someone-else", ipAddress: null }, begun.uploadId)).rejects.toThrow(
      "Upload not found.",
    );
  });

  it("flags a file reused as primary evidence for a second submission (AT-n)", async () => {
    const { evidenceId } = await (await upload("deposit-slip.pdf", new TextEncoder().encode(`%PDF-1.7 ${randomUUID()}`))).finished();
    const run = randomUUID();
    const subA = `REMITTANCE_SCHEDULE:${run}-A`;
    const subB = `REMITTANCE_SCHEDULE:${run}-B`;

    const a = await linkEvidence(db, actor, { evidenceId, entityType: "Lodgement", entityId: `${run}-1`, kind: "PRIMARY", submissionKey: subA });
    expect(a.duplicateExceptionId).toBeNull();

    // Same submission, another record: normal, not flagged.
    const sameSub = await linkEvidence(db, actor, { evidenceId, entityType: "Lodgement", entityId: `${run}-2`, kind: "PRIMARY", submissionKey: subA });
    expect(sameSub.duplicateExceptionId).toBeNull();

    // Supporting evidence elsewhere: never flagged.
    const supporting = await linkEvidence(db, actor, { evidenceId, entityType: "Exception", entityId: `${run}-x`, kind: "SUPPORTING", submissionKey: `EXCEPTION:${run}` });
    expect(supporting.duplicateExceptionId).toBeNull();

    // Primary for a different submission: needs a reason…
    const second = { evidenceId, entityType: "Lodgement", entityId: `${run}-3`, kind: "PRIMARY" as const, submissionKey: subB };
    await expect(linkEvidence(db, actor, second)).rejects.toThrow(DuplicateEvidenceError);

    // …and with one, it links and opens a DUPLICATE_EVIDENCE exception.
    const flagged = await linkEvidence(db, actor, { ...second, duplicateReason: "Same slip covers two schedules" });
    expect(flagged.duplicateExceptionId).not.toBeNull();
    const exception = await db.exceptionRecord.findUniqueOrThrow({ where: { id: flagged.duplicateExceptionId as string } });
    expect(exception).toMatchObject({ type: "DUPLICATE_EVIDENCE", status: "OPEN" });
    expect(flagged.link.duplicateReason).toBe("Same slip covers two schedules");
  });

  it("issues a 5-minute link for an intact file and flags a tampered one", async () => {
    const { evidenceId } = await (await upload("receipt.csv", uniqueCsv())).finished();
    const intact = await openEvidence(db, store, actor, evidenceId);
    expect(intact.url).toMatch(/op=get/);

    // Change the stored bytes behind the repository's back.
    const file = await db.evidenceFile.findUniqueOrThrow({ where: { id: evidenceId } });
    await writeFile(path.join(dir, ...file.storageKey.split("/")), "tampered,content\n");
    await expect(openEvidence(db, store, actor, evidenceId)).rejects.toThrow(EvidenceTamperedError);
    const exception = await db.exceptionRecord.findUnique({ where: { dedupeKey: `EVIDENCE_TAMPERED:${evidenceId}` } });
    expect(exception?.status).toBe("OPEN");
  });
});
