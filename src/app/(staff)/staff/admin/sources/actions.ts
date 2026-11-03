"use server";

import { getDb } from "@/lib/db";
import { createSource, setSourceActive } from "@/modules/credit/members/sources";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn } from "../../run-action";

const PAGE = "/staff/admin/sources";

export async function createSourceAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("sources.manage");
    const source = await createSource(getDb(), actor, { code: field(form, "code"), name: field(form, "name") });
    return `${source.name} added.`;
  });
}

export async function toggleSourceAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("sources.manage");
    const active = field(form, "active") === "true";
    const source = await setSourceActive(getDb(), actor, field(form, "id"), active);
    return `${source.name} ${active ? "switched on" : "switched off"}.`;
  });
}
