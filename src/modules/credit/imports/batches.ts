import type { ImportKind, Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";

export interface PreviewRow<T> {
  rowNo: number;
  /** The row as it will be written, once valid. */
  data: T;
  /** The raw cells, kept for the error log. */
  raw: Record<string, string>;
  errors: string[];
}

/** Saves a dry run: the batch and one log row per spreadsheet row (PRD: per-row error log). */
export async function saveBatch<T>(
  db: Db,
  input: {
    kind: ImportKind;
    filename: string;
    evidenceId: string | null;
    uploadedById: string;
    rows: PreviewRow<T>[];
    /** Form fields and other batch-level data, e.g. a schedule header. */
    header?: Prisma.InputJsonValue;
    /** Problems with the batch as a whole, counted as an error row. */
    batchErrorCount?: number;
  },
) {
  const batch = await db.importBatch.create({
    data: {
      kind: input.kind,
      filename: input.filename,
      evidenceId: input.evidenceId,
      rowCount: input.rows.length,
      errorRowCount: input.rows.filter((r) => r.errors.length > 0).length + (input.batchErrorCount ? 1 : 0),
      uploadedById: input.uploadedById,
      header: input.header,
    },
  });
  await db.importRowLog.createMany({
    data: input.rows.map((r) => ({
      batchId: batch.id,
      rowNo: r.rowNo,
      data: { raw: r.raw, parsed: r.errors.length ? null : r.data } as Prisma.InputJsonObject,
      errors: r.errors,
    })),
  });
  return batch;
}

/** Loads a dry run for its uploader; refuses batches already used. */
export async function loadPreviewedBatch(db: Db, batchId: string, kind: ImportKind, uploadedById: string) {
  const batch = await db.importBatch.findUnique({
    where: { id: batchId },
    include: { rows: { orderBy: { rowNo: "asc" } } },
  });
  if (!batch || batch.kind !== kind || batch.uploadedById !== uploadedById) return null;
  if (batch.status !== "PREVIEWED") return null;
  return batch;
}

/** Marks rows that share a value with an earlier row in the same file. */
export function flagDuplicates<T>(rows: PreviewRow<T>[], keyOf: (row: PreviewRow<T>) => string | null, label: string): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const first = seen.get(key);
    if (first !== undefined) row.errors.push(`Same ${label} as row ${first}.`);
    else seen.set(key, row.rowNo);
  }
}

/** Recent batches of one kind, newest first, with who uploaded them. */
export async function listImportBatches(db: Db, kind: ImportKind, take = 20) {
  const batches = await db.importBatch.findMany({ where: { kind }, orderBy: { uploadedAt: "desc" }, take });
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(batches.map((b) => b.uploadedById))] } },
    select: { id: true, name: true },
  });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return batches.map((b) => ({ ...b, uploadedByName: names.get(b.uploadedById) ?? "Unknown" }));
}
