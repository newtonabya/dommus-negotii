import type { PrismaClient } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { kobo, ZERO, type Kobo } from "@/lib/money";
import { linkEvidence, storeEvidenceBytes } from "@/evidence/service";
import type { EvidenceStore } from "@/evidence/store";
import { writeAudit } from "@/shell/audit/audit";
import { assertColumns, readTable } from "../imports/table";
import { ADVICE_COLUMNS } from "../imports/templates";
import { activeSource, naira, parseCount, parseMonth, positiveAmount, REMITTANCE_TX, RemittanceError, type RemittanceActor } from "./common";

export interface AdviceHeaderInput {
  remittanceSource: string;
  monthCovered: string;
  adviceReference: string;
  controlTotal: string;
  rowCount: string;
}

export interface UploadedFile {
  filename: string;
  bytes: Uint8Array;
}

/**
 * Finance Manager uploads a Source Advice (PRD F9): what the payroll source
 * says it deducted per member for a month, with the source's own document as
 * evidence. All or nothing; every problem is listed.
 */
export async function uploadSourceAdvice(
  db: PrismaClient,
  store: EvidenceStore,
  actor: RemittanceActor,
  input: AdviceHeaderInput,
  rowsFile: UploadedFile,
  document: UploadedFile,
) {
  const source = await activeSource(db, input.remittanceSource);
  const monthCovered = parseMonth(input.monthCovered);
  const adviceReference = input.adviceReference.trim();
  if (adviceReference.length < 2 || adviceReference.length > 80) throw new RemittanceError("Advice reference: enter the reference on the source's document.");
  const total = positiveAmount(input.controlTotal);
  if ("error" in total) throw new RemittanceError(`Control total ${total.error}.`);
  const rowCount = parseCount(input.rowCount, "Row count");
  if (document.bytes.length === 0) throw new RemittanceError("Attach the original document received from the source.");

  const taken = await db.sourceAdvice.findUnique({
    where: { remittanceSourceId_adviceReference: { remittanceSourceId: source.id, adviceReference } },
  });
  if (taken) throw new RemittanceError(`Advice ${adviceReference} was already uploaded for ${source.code}.`);

  const table = await readTable(rowsFile.filename, rowsFile.bytes);
  assertColumns(table, ADVICE_COLUMNS.map((c) => c.name));
  const errors: string[] = [];
  const parsed: Array<{ moaumIdNumber: string; memberName: string; amount: Kobo }> = [];
  const seen = new Map<string, number>();
  for (const { rowNo, values } of table.rows) {
    const id = (values.member_moaum_id ?? "").trim();
    const name = (values.member_name ?? "").trim();
    const amount = positiveAmount(values.amount ?? "");
    if (!id) errors.push(`Row ${rowNo}: member_moaum_id is empty.`);
    if (!name) errors.push(`Row ${rowNo}: member_name is empty.`);
    if ("error" in amount) errors.push(`Row ${rowNo}: amount ${amount.error}.`);
    if (id) {
      const first = seen.get(id.toUpperCase());
      if (first !== undefined) errors.push(`Row ${rowNo}: member ${id} is already on row ${first}; one row per member.`);
      else seen.set(id.toUpperCase(), rowNo);
    }
    if (id && name && "value" in amount) parsed.push({ moaumIdNumber: id, memberName: name, amount: amount.value });
  }
  if (table.rows.length === 0) errors.push("The file has no rows.");
  const members = await db.member.findMany({
    where: { moaumIdNumber: { in: parsed.map((p) => p.moaumIdNumber), mode: "insensitive" } },
    select: { moaumIdNumber: true },
  });
  const known = new Set(members.map((m) => m.moaumIdNumber.toUpperCase()));
  for (const p of parsed) if (!known.has(p.moaumIdNumber.toUpperCase())) errors.push(`Member ${p.moaumIdNumber} (${p.memberName}) is not in the register.`);
  const sum = parsed.reduce((t, p) => kobo(t + p.amount), ZERO);
  if (errors.length === 0 && sum !== total.value) errors.push(`The rows total ${naira(sum)} but the control total is ${naira(total.value)}.`);
  if (errors.length === 0 && table.rows.length !== rowCount) errors.push(`The file has ${table.rows.length} rows but the row count is ${rowCount}.`);
  if (errors.length > 0) throw new RemittanceError("The advice was not saved. Fix these and upload again:", errors);

  const original = await storeEvidenceBytes(db, store, actor, document.filename, document.bytes);
  const sheet = await storeEvidenceBytes(db, store, actor, rowsFile.filename, rowsFile.bytes);
  return db.$transaction(async (tx) => {
    const advice = await tx.sourceAdvice.create({
      data: {
        remittanceSourceId: source.id,
        monthCovered,
        adviceReference,
        controlTotal: total.value,
        rowCount,
        evidenceId: original.evidenceId,
        uploadedById: actor.id,
        rows: { createMany: { data: parsed.map((p) => ({ moaumIdNumber: p.moaumIdNumber.toUpperCase(), memberName: p.memberName, amount: p.amount })) } },
      },
    });
    const submissionKey = `SOURCE_ADVICE:${advice.id}`;
    await linkEvidence(tx, actor, { evidenceId: original.evidenceId, entityType: "SourceAdvice", entityId: advice.id, kind: "PRIMARY", submissionKey });
    if (sheet.evidenceId !== original.evidenceId) {
      await linkEvidence(tx, actor, { evidenceId: sheet.evidenceId, entityType: "SourceAdvice", entityId: advice.id, kind: "SUPPORTING", submissionKey });
    }
    await writeAudit(tx, {
      action: "sourceAdvice.upload",
      entityType: "SourceAdvice",
      entityId: advice.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      evidenceRef: original.evidenceId,
      after: { source: source.code, monthCovered, adviceReference, controlTotal: total.value.toString(), rowCount, checksum: original.sha256 },
    });
    return advice;
  }, REMITTANCE_TX);
}

/** Recent advices, newest first, with whether a schedule has used them. */
export async function listAdvices(db: Db, take = 50) {
  return db.sourceAdvice.findMany({
    orderBy: { uploadedAt: "desc" },
    take,
    include: { remittanceSource: { select: { code: true, name: true } }, schedule: { select: { id: true, scheduleReference: true } } },
  });
}
