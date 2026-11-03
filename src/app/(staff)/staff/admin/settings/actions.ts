"use server";

import { getDb } from "@/lib/db";
import { authorizeAction } from "@/shell/auth/session";
import type { SettingKey } from "@/shell/settings/definitions";
import { approveChange, changeSetting, proposeChange, rejectChange, withdrawChange } from "@/shell/settings/settings";
import { field, runAndReturn } from "../../run-action";

const PAGE = "/staff/admin/settings";

/** Operational settings: take effect at once. */
export async function changeSettingAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("settings.change");
    await changeSetting(getDb(), actor, field(form, "key") as SettingKey, field(form, "value"));
    return "Setting saved. It applies from now.";
  });
}

/** Financial settings, step 1: Admin proposes. */
export async function proposeChangeAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("settings.financial.propose");
    await proposeChange(getDb(), actor, {
      key: field(form, "key") as SettingKey,
      value: field(form, "value"),
      effectiveFrom: field(form, "effectiveFrom"),
      reason: field(form, "reason"),
    });
    return "Proposal sent to Management. Nothing changes until it is approved.";
  });
}

/** Financial settings, step 2: Management approves. */
export async function approveChangeAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("settings.financial.approve");
    const { label, value, effectiveFrom } = await approveChange(getDb(), actor, field(form, "id"), field(form, "note"));
    return `Approved: ${label} becomes ${value} from ${effectiveFrom}.`;
  });
}

export async function rejectChangeAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("settings.financial.approve");
    await rejectChange(getDb(), actor, field(form, "id"), field(form, "note"));
    return "Proposal rejected. The Admin can see your reason.";
  });
}

export async function withdrawChangeAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("settings.financial.propose");
    await withdrawChange(getDb(), actor, field(form, "id"));
    return "Proposal withdrawn.";
  });
}
