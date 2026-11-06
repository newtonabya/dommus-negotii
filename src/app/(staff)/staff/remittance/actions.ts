"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { getEvidenceStore } from "@/evidence/store";
import { MAX_IMPORT_BYTES, TableError } from "@/modules/credit/imports/table";
import { commitSchedule, previewSchedule } from "@/modules/credit/remittance/schedules";
import { uploadSourceAdvice } from "@/modules/credit/remittance/source-advice";
import { authorizeAction } from "@/shell/auth/session";
import { field, messageOf, runAndReturn } from "../run-action";

const PAGE = "/staff/remittance";

async function fileOf(form: FormData, name: string, label: string) {
  const file = form.get(name);
  if (!(file instanceof File) || file.size === 0) throw new TableError(`Choose the ${label}.`);
  if (file.size > MAX_IMPORT_BYTES) throw new TableError(`The ${label} is larger than 2 MB.`);
  return { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Finance Manager: Source Advice with the source's original document. */
export async function uploadAdviceAction(form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("sourceAdvice.upload");
    const advice = await uploadSourceAdvice(
      getDb(),
      getEvidenceStore(),
      actor,
      {
        remittanceSource: field(form, "source"),
        monthCovered: field(form, "month"),
        adviceReference: field(form, "reference"),
        controlTotal: field(form, "controlTotal"),
        rowCount: field(form, "rowCount"),
      },
      await fileOf(form, "rows", "advice rows file"),
      await fileOf(form, "document", "original document from the source"),
    );
    return `Source Advice ${advice.adviceReference} saved (${advice.rowCount} members). The Treasurer can now upload the schedule that matches it.`;
  });
}

/** Treasurer: dry run; opens the preview. */
export async function previewScheduleAction(form: FormData) {
  let target: string;
  try {
    const actor = await authorizeAction("schedule.upload");
    const { batchId } = await previewSchedule(
      getDb(),
      getEvidenceStore(),
      actor,
      {
        scheduleReference: field(form, "reference"),
        remittanceSource: field(form, "source"),
        monthCovered: field(form, "month"),
        scheduleType: field(form, "type"),
        adviceReference: field(form, "adviceReference"),
        submittedBy: field(form, "submittedBy"),
        controlTotal: field(form, "controlTotal"),
        rowCount: field(form, "rowCount"),
        paymentDate: field(form, "paymentDate"),
      },
      await fileOf(form, "file", "schedule file"),
    );
    target = `${PAGE}/batches/${batchId}`;
  } catch (error) {
    target = `${PAGE}?error=${encodeURIComponent(messageOf(error))}`;
  }
  revalidatePath(PAGE);
  redirect(target as never);
}

/** Treasurer: posts the previewed schedule. */
export async function commitScheduleAction(batchId: string) {
  let target: string;
  try {
    const actor = await authorizeAction("schedule.commit");
    const result = await commitSchedule(getDb(), actor, batchId);
    const credit = result.credited ? ` ${result.credited} went to Overpayment Credit.` : "";
    target = `${PAGE}/schedules/${result.scheduleId}?ok=${encodeURIComponent(`Posted ${result.rows} rows.${credit}`)}`;
  } catch (error) {
    target = `${PAGE}/batches/${batchId}?error=${encodeURIComponent(messageOf(error))}`;
  }
  revalidatePath(PAGE);
  redirect(target as never);
}
