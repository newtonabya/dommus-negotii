"use server";

import { getDb } from "@/lib/db";
import QRCode from "qrcode";
import { activateMember, declineMember, setPayrollStaffNo } from "@/modules/credit/members/review";
import { issueSignInLink } from "@/modules/credit/members/sign-in-links";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn, runForResult, type ActionResult } from "../run-action";

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

/** A one-time sign-in link for a member, shown to the Loan Officer as text and a QR code. */
export async function issueSignInLinkAction(
  memberId: string,
): Promise<ActionResult<{ url: string; qr: string; expiresAt: string; firstTime: boolean }>> {
  return runForResult(async () => {
    const actor = await authorizeAction("member.signInLink.issue");
    const link = await issueSignInLink(getDb(), actor, memberId);
    const base = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const url = `${base}${link.path}`;
    return { url, qr: await QRCode.toDataURL(url, { margin: 1, width: 240 }), expiresAt: link.expiresAt.toISOString(), firstTime: link.firstTime };
  });
}
