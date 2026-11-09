"use server";

import { getDb } from "@/lib/db";
import { storeEvidenceBytes } from "@/evidence/service";
import { getEvidenceStore } from "@/evidence/store";
import { MAX_IMPORT_BYTES } from "@/modules/credit/imports/table";
import { closeException, ExceptionError, reviewException } from "@/shell/exceptions/exceptions";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn } from "../run-action";

const PAGE = "/staff/exceptions";

async function evidenceOf(form: FormData, actor: { id: string; ipAddress: string | null }) {
  const file = form.get("evidence");
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > MAX_IMPORT_BYTES) throw new ExceptionError("The file is larger than 2 MB.");
  const stored = await storeEvidenceBytes(getDb(), getEvidenceStore(), actor, file.name, new Uint8Array(await file.arrayBuffer()));
  return stored.evidenceId;
}

export async function reviewExceptionAction(id: string, form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("exception.review");
    await reviewException(getDb(), actor, id, field(form, "note"), await evidenceOf(form, actor));
    return "Note added; the exception is under review.";
  });
}

export async function closeExceptionAction(id: string, form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("exception.close");
    await closeException(getDb(), actor, id, field(form, "reason"), await evidenceOf(form, actor));
    return "Exception closed. Nothing in the ledger or any balance changed.";
  });
}
