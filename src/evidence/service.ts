import { randomUUID } from "node:crypto";
import type { EvidenceFile, EvidenceKind, EvidenceLink } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { writeAudit } from "@/shell/audit/audit";
import { raiseException } from "@/shell/exceptions/exceptions";
import { checkEvidenceFile, EVIDENCE_TYPES, MAX_EVIDENCE_BYTES, typeFromName } from "./file-types";
import { fileKey, stagingKey, type EvidenceStore, type PresignedPut } from "./store";

/** Who is acting, for checks and the audit trail. */
export interface EvidenceActor {
  id: string;
  ipAddress: string | null;
}

export class EvidenceError extends Error {
  readonly status: number = 400;
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

/** The stored bytes no longer match the checksum taken at upload (PRD F3). */
export class EvidenceTamperedError extends EvidenceError {
  override readonly status = 409;
  constructor(readonly evidenceId: string) {
    super("This evidence file failed its integrity check and has been flagged. It can't be opened.");
    this.name = "EvidenceTamperedError";
  }
}

/** A primary file reused for another submission needs a reason (PRD F3). */
export class DuplicateEvidenceError extends EvidenceError {
  constructor(readonly otherSubmissions: string[]) {
    super("This file is already the primary evidence of another record. Give a reason to use it again.");
    this.name = "DuplicateEvidenceError";
  }
}

function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  return base.slice(0, 200) || "file";
}

// ───────────────────────────── Upload ─────────────────────────────

export interface BeginUploadResult extends PresignedPut {
  uploadId: string;
}

/** Step 1: records the upload and returns a 5-minute URL the browser PUTs the file to. */
export async function beginUpload(
  db: Db,
  store: EvidenceStore,
  actor: EvidenceActor,
  input: { filename: string; size: number },
): Promise<BeginUploadResult> {
  const filename = cleanFilename(input.filename);
  const type = typeFromName(filename);
  if (!type) throw new EvidenceError("Only PDF, JPG, PNG, XLSX and CSV files are accepted.");
  if (!Number.isInteger(input.size) || input.size <= 0) throw new EvidenceError("The file is empty.");
  if (input.size > MAX_EVIDENCE_BYTES) throw new EvidenceError("The file is larger than 10 MB.");

  const uploadId = randomUUID();
  const key = stagingKey(uploadId);
  const mime = EVIDENCE_TYPES[type].mime;
  await db.evidenceUpload.create({
    data: { id: uploadId, stagingKey: key, declaredName: filename, declaredType: mime, declaredSize: input.size, uploadedById: actor.id },
  });
  return { uploadId, ...(await store.presignPut(key, mime)) };
}

export interface FinishUploadResult {
  evidenceId: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  /** True when an identical file was already stored and is reused. */
  reused: boolean;
}

/**
 * Step 2: checks the uploaded bytes (size, real type), hashes them server-side
 * and files them by checksum. An identical file already stored is reused.
 */
export async function finishUpload(
  db: Db,
  store: EvidenceStore,
  actor: EvidenceActor,
  uploadId: string,
): Promise<FinishUploadResult> {
  const upload = await db.evidenceUpload.findUnique({ where: { id: uploadId } });
  if (!upload || upload.uploadedById !== actor.id) throw new EvidenceError("Upload not found.");
  if (upload.finishedAt) throw new EvidenceError("This upload was already processed.");

  const bytes = await store.get(upload.stagingKey);
  if (!bytes) throw new EvidenceError("The file didn't arrive. Try uploading it again.");

  const check = checkEvidenceFile(upload.declaredName, bytes);
  if (!check.ok) {
    await db.evidenceUpload.update({
      where: { id: uploadId },
      data: { finishedAt: new Date(), rejectedReason: check.reason },
    });
    await store.deleteStaging(upload.stagingKey);
    await writeAudit(db, {
      action: "evidence.upload.rejected",
      entityType: "EvidenceUpload",
      entityId: uploadId,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      after: { filename: upload.declaredName, reason: check.reason },
    });
    throw new EvidenceError(check.reason);
  }

  const sha256 = sha256Hex(bytes);
  const mime = EVIDENCE_TYPES[check.type].mime;
  let file = await db.evidenceFile.findUnique({ where: { sha256 } });
  const reused = file !== null;
  if (!file) {
    const key = fileKey(sha256);
    if (!(await store.exists(key))) await store.putFile(key, bytes, mime);
    // skipDuplicates: if someone stored the same file at the same moment, theirs is the record.
    await db.evidenceFile.createMany({
      data: [
        {
          filename: upload.declaredName,
          mimeType: mime,
          sizeBytes: bytes.length,
          sha256,
          storageKey: key,
          uploadedById: actor.id,
        },
      ],
      skipDuplicates: true,
    });
    file = await db.evidenceFile.findUniqueOrThrow({ where: { sha256 } });
  }

  await db.evidenceUpload.update({ where: { id: uploadId }, data: { finishedAt: new Date(), evidenceId: file.id } });
  await store.deleteStaging(upload.stagingKey);
  await writeAudit(db, {
    action: "evidence.upload",
    entityType: "EvidenceFile",
    entityId: file.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    after: { filename: upload.declaredName, sha256, sizeBytes: bytes.length, reused },
  });
  return { evidenceId: file.id, filename: file.filename, sha256, sizeBytes: file.sizeBytes, reused };
}

// ───────────────────────────── Linking ─────────────────────────────

export interface LinkInput {
  evidenceId: string;
  entityType: string;
  entityId: string;
  kind: EvidenceKind;
  /** The submission the record belongs to, e.g. "REMITTANCE_SCHEDULE:<id>". */
  submissionKey: string;
  /** Required when the file is already primary evidence of another submission. */
  duplicateReason?: string;
}

export interface LinkResult {
  link: EvidenceLink;
  duplicateExceptionId: string | null;
}

/**
 * Attaches evidence to a record. A file that becomes primary evidence of a
 * second, different submission needs a reason and opens a DUPLICATE_EVIDENCE
 * exception (PRD F3, AT-n). Reuse within one submission and supporting links
 * are never flagged.
 */
export async function linkEvidence(db: Db, actor: EvidenceActor, input: LinkInput): Promise<LinkResult> {
  const file = await db.evidenceFile.findUnique({ where: { id: input.evidenceId } });
  if (!file) throw new EvidenceError("Evidence not found.");

  const existing = await db.evidenceLink.findUnique({
    where: {
      evidenceId_entityType_entityId: {
        evidenceId: input.evidenceId,
        entityType: input.entityType,
        entityId: input.entityId,
      },
    },
  });
  if (existing) return { link: existing, duplicateExceptionId: null };

  let duplicateExceptionId: string | null = null;
  const reason = input.duplicateReason?.trim() ?? "";
  if (input.kind === "PRIMARY") {
    const others = await db.evidenceLink.findMany({
      where: { evidenceId: input.evidenceId, kind: "PRIMARY", NOT: { submissionKey: input.submissionKey } },
      select: { submissionKey: true },
      distinct: ["submissionKey"],
    });
    if (others.length > 0) {
      const otherSubmissions = others.map((o) => o.submissionKey);
      if (reason.length < 5) throw new DuplicateEvidenceError(otherSubmissions);
      const { exception } = await raiseException(db, {
        moduleCode: "SHELL",
        type: "DUPLICATE_EVIDENCE",
        dedupeKey: `DUPLICATE_EVIDENCE:${input.evidenceId}:${input.submissionKey}`,
        title: `"${file.filename}" is primary evidence for more than one submission`,
        details: {
          evidenceId: file.id,
          sha256: file.sha256,
          filename: file.filename,
          submissions: [...otherSubmissions, input.submissionKey],
          reason,
        },
        raisedById: actor.id,
        ipAddress: actor.ipAddress,
      });
      duplicateExceptionId = exception.id;
    }
  }

  const link = await db.evidenceLink.create({
    data: {
      evidenceId: input.evidenceId,
      entityType: input.entityType,
      entityId: input.entityId,
      kind: input.kind,
      submissionKey: input.submissionKey,
      duplicateReason: duplicateExceptionId ? reason : null,
      linkedById: actor.id,
    },
  });
  await writeAudit(db, {
    action: "evidence.link",
    entityType: input.entityType,
    entityId: input.entityId,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    evidenceRef: input.evidenceId,
    after: { kind: input.kind, submissionKey: input.submissionKey, duplicateExceptionId },
  });
  return { link, duplicateExceptionId };
}

// ───────────────────────────── Opening ─────────────────────────────

/**
 * Re-verifies the stored bytes against the upload checksum, then returns a
 * 5-minute download URL. A mismatch or missing file is flagged as an
 * EVIDENCE_TAMPERED exception and access is refused (PRD F3).
 */
export async function openEvidence(
  db: Db,
  store: EvidenceStore,
  actor: EvidenceActor,
  evidenceId: string,
): Promise<{ url: string; file: EvidenceFile }> {
  const file = await db.evidenceFile.findUnique({ where: { id: evidenceId } });
  if (!file) throw new EvidenceError("Evidence not found.");

  const bytes = await store.get(file.storageKey);
  const actual = bytes ? sha256Hex(bytes) : null;
  if (actual !== file.sha256) {
    await raiseException(db, {
      moduleCode: "SHELL",
      type: "EVIDENCE_TAMPERED",
      dedupeKey: `EVIDENCE_TAMPERED:${file.id}`,
      title: `Evidence "${file.filename}" failed its integrity check`,
      details: { evidenceId: file.id, expectedSha256: file.sha256, actualSha256: actual, missing: bytes === null },
      raisedById: actor.id,
      ipAddress: actor.ipAddress,
    });
    await writeAudit(db, {
      action: "evidence.tamper_detected",
      entityType: "EvidenceFile",
      entityId: file.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      after: { expectedSha256: file.sha256, actualSha256: actual },
    });
    throw new EvidenceTamperedError(file.id);
  }

  await writeAudit(db, {
    action: "evidence.open",
    entityType: "EvidenceFile",
    entityId: file.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
  });
  return { url: await store.presignGet(file.storageKey, file.filename, file.mimeType), file };
}

// ───────────────────────────── Listing ─────────────────────────────

export async function listEvidence(db: Db, take = 100) {
  const files = await db.evidenceFile.findMany({
    orderBy: { uploadedAt: "desc" },
    take,
    include: { links: { select: { kind: true, entityType: true, submissionKey: true } } },
  });
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(files.map((f) => f.uploadedById))] } },
    select: { id: true, name: true },
  });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return files.map((f) => ({ ...f, uploadedByName: names.get(f.uploadedById) ?? "Unknown user" }));
}
