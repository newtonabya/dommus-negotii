"use server";

import { getDb } from "@/lib/db";
import { approveProfileChange, rejectProfileChange } from "@/modules/credit/members/profile-changes";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn } from "../../run-action";

const PAGE = "/staff/members/profile-changes";

export async function approveProfileChangeAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("member.profileChange.approve");
    await approveProfileChange(getDb(), actor, field(form, "id"), field(form, "note"));
    return "Change approved. The member's details are updated.";
  });
}

export async function rejectProfileChangeAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("member.profileChange.approve");
    await rejectProfileChange(getDb(), actor, field(form, "id"), field(form, "note"));
    return "Change rejected. The member can see your reason.";
  });
}
