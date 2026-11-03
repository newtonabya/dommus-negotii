"use server";

import { getDb } from "@/lib/db";
import { createInvitation, resendInvitation, revokeInvitation } from "@/modules/credit/members/invitations";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn } from "../../run-action";

const PAGE = "/staff/members/invitations";

export async function sendInvitationAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("invitation.send");
    const { invitation, sent } = await createInvitation(getDb(), actor, {
      fullName: field(form, "fullName"),
      phone: field(form, "phone"),
      email: field(form, "email"),
      remittanceSourceId: field(form, "remittanceSourceId"),
    });
    return sent
      ? `Invitation sent to ${invitation.fullName} by SMS${invitation.email ? " and email" : ""}.`
      : `Invitation saved, but the SMS provider didn't accept the message. Try "Resend" shortly.`;
  });
}

export async function resendInvitationAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("invitation.send");
    const { invitation, sent } = await resendInvitation(getDb(), actor, field(form, "id"));
    return sent ? `A new link was sent to ${invitation.fullName}; the old one no longer works.` : "The SMS provider didn't accept the message. Try again shortly.";
  });
}

export async function revokeInvitationAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("invitation.send");
    await revokeInvitation(getDb(), actor, field(form, "id"));
    return "Invitation revoked. Its link no longer works.";
  });
}
