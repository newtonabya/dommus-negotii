"use server";

import { getDb } from "@/lib/db";
import { authorizeAction } from "@/shell/auth/session";
import { setModuleStatus } from "@/shell/registry/registry";
import { field, runAndReturn } from "../../run-action";

const PAGE = "/staff/admin/modules";

export async function setModuleStatusAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("modules.manage");
    const status = field(form, "status");
    await setModuleStatus(getDb(), actor, field(form, "code"), status, field(form, "reason"));
    return `Status changed to ${status.toLowerCase()}.`;
  });
}
