"use server";

import { getDb } from "@/lib/db";
import { activateMember, declineMember, setPayrollStaffNo } from "@/modules/credit/members/review";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn } from "../run-action";

const PAGE = "/staff/members";

export async function activateMemberAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("member.activate");
    await activateMember(getDb(), actor, field(form, "memberId"));
    return "Member activated. They've been sent an SMS.";
  });
}

export async function declineMemberAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("member.activate");
    await declineMember(getDb(), actor, field(form, "memberId"), field(form, "reason"));
    return "Registration declined. The applicant has been sent the reason by SMS.";
  });
}

export async function setPayrollStaffNoAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("member.activate");
    await setPayrollStaffNo(getDb(), actor, field(form, "memberId"), field(form, "staffNo"));
    return "Payroll staff number saved. Payroll files will find this member by it.";
  });
}
