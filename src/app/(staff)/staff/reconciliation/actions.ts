"use server";

import { getDb } from "@/lib/db";
import { getEvidenceStore } from "@/evidence/store";
import { closeMonth } from "@/modules/credit/reconciliation/close";
import { runReconciliation } from "@/modules/credit/reconciliation/reconciliation";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn } from "../run-action";

const PAGE = "/staff/reconciliation";

export async function runReconciliationAction(form: FormData) {
  const month = field(form, "month");
  return runAndReturn(`${PAGE}?month=${month}`, async () => {
    const actor = await authorizeAction("reconciliation.run");
    const { results } = await runReconciliation(getDb(), actor, month);
    return `Reconciliation for ${month} done: ${results.exceptions.found} exception(s) found, ${results.exceptions.raised} new, ${results.exceptions.resolved} now ready to close.`;
  });
}

export async function closeMonthAction(month: string) {
  return runAndReturn(`${PAGE}?month=${month}`, async () => {
    const actor = await authorizeAction("month.close");
    await closeMonth(getDb(), getEvidenceStore(), actor, month);
    return `${month} is closed. Its reports are saved; anything posted later with a date inside it shows as a prior-period adjustment.`;
  });
}
