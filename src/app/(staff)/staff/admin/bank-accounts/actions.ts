"use server";

import { getDb } from "@/lib/db";
import { createBankAccount, setBankAccountActive } from "@/modules/credit/banking/bank-accounts";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn } from "../../run-action";

const PAGE = "/staff/admin/bank-accounts";

export async function createBankAccountAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("bankAccounts.manage");
    const account = await createBankAccount(getDb(), actor, {
      bankName: field(form, "bankName"),
      branch: field(form, "branch"),
      accountName: field(form, "accountName"),
      accountNumber: field(form, "accountNumber"),
    });
    return `${account.bankName} ${account.accountNumber} added.`;
  });
}

export async function toggleBankAccountAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("bankAccounts.manage");
    const active = field(form, "active") === "true";
    await setBankAccountActive(getDb(), actor, field(form, "id"), active);
    return active ? "Account switched on." : "Account switched off.";
  });
}
