"use server";

import { getDb } from "@/lib/db";
import { getEvidenceStore } from "@/evidence/store";
import { MAX_IMPORT_BYTES } from "@/modules/credit/imports/table";
import {
  BankError,
  commitOpeningBalance,
  importStatement,
  rejectOpeningBalance,
  saveMapping,
  STATEMENT_FIELDS,
  uploadOpeningBalance,
  type DateFormat,
} from "@/modules/credit/banking/statements";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn } from "../run-action";

const PAGE = "/staff/bank";

async function fileOf(form: FormData, name: string, label: string) {
  const file = form.get(name);
  if (!(file instanceof File) || file.size === 0) throw new BankError(`Choose the ${label}.`);
  if (file.size > MAX_IMPORT_BYTES) throw new BankError(`The ${label} is larger than 2 MB.`);
  return { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

export async function uploadOpeningAction(form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("bankOpening.upload");
    await uploadOpeningBalance(
      getDb(),
      getEvidenceStore(),
      actor,
      { bankAccountId: field(form, "accountId"), asOf: field(form, "asOf"), amount: field(form, "amount") },
      await fileOf(form, "evidence", "statement showing the balance"),
    );
    return "Opening balance saved. The Finance Manager commits it.";
  });
}

export async function commitOpeningAction(id: string) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("bankOpening.commit");
    await commitOpeningBalance(getDb(), actor, id);
    return "Opening balance committed to the ledger.";
  });
}

export async function rejectOpeningAction(id: string, form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("bankOpening.commit");
    await rejectOpeningBalance(getDb(), actor, id, field(form, "reason"));
    return "Opening balance rejected. Admin can upload it again.";
  });
}

export async function saveMappingAction(accountId: string, form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("bankStatement.upload");
    await saveMapping(getDb(), actor, accountId, {
      fields: Object.fromEntries(STATEMENT_FIELDS.map((f) => [f, field(form, f)])),
      dateFormat: field(form, "dateFormat") as DateFormat,
    });
    return "Column mapping saved. It is used for every statement of this account.";
  });
}

export async function importStatementAction(accountId: string, form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("bankStatement.upload");
    const statement = await importStatement(
      getDb(),
      getEvidenceStore(),
      actor,
      {
        bankAccountId: accountId,
        periodFrom: field(form, "from"),
        periodTo: field(form, "to"),
        openingBalance: field(form, "opening"),
        closingBalance: field(form, "closing"),
      },
      await fileOf(form, "file", "statement file"),
    );
    return `Statement imported: ${statement.lineCount} new line(s)${statement.skippedCount ? `, ${statement.skippedCount} already imported and skipped` : ""}.`;
  });
}
