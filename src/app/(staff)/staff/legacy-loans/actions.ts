"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { getEvidenceStore } from "@/evidence/store";
import { commitLegacyImport, previewLegacyImport } from "@/modules/credit/loans/legacy-import";
import { authorizeAction } from "@/shell/auth/session";
import { field, messageOf, uploadedFile } from "../run-action";

const PAGE = "/staff/legacy-loans";

/** Admin: dry run of MOAUM's loan records; opens the result. */
export async function previewLegacyAction(form: FormData) {
  let target: string;
  try {
    const actor = await authorizeAction("legacyImport.upload");
    const { batchId } = await previewLegacyImport(
      getDb(),
      getEvidenceStore(),
      actor,
      { goLiveDate: field(form, "goLive"), controlTotal: field(form, "controlTotal"), rowCount: field(form, "rowCount") },
      await uploadedFile(form),
    );
    target = `${PAGE}/${batchId}`;
  } catch (error) {
    target = `${PAGE}?error=${encodeURIComponent(messageOf(error))}`;
  }
  revalidatePath(PAGE);
  redirect(target as never);
}

/** Finance Manager: commits the checked file. */
export async function commitLegacyAction(batchId: string) {
  let target: string;
  try {
    const actor = await authorizeAction("legacyImport.commit");
    const result = await commitLegacyImport(getDb(), actor, batchId);
    target = `${PAGE}/${batchId}?ok=${encodeURIComponent(`${result.loans} legacy loan(s) brought in. Each has a new loan number and its opening balance.`)}`;
  } catch (error) {
    target = `${PAGE}/${batchId}?error=${encodeURIComponent(messageOf(error))}`;
  }
  revalidatePath(PAGE);
  redirect(target as never);
}
