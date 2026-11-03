"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { previewBulkInvitations, sendBulkInvitations } from "@/modules/credit/members/bulk-invitations";
import { createInvitation, resendInvitation, revokeInvitation } from "@/modules/credit/members/invitations";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn, runForResult, uploadedFile } from "../../run-action";

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

/** Bulk invitations, step 1: dry run of the uploaded list. */
export async function previewBulkInvitationsAction(form: FormData) {
  return runForResult(async () => {
    const actor = await authorizeAction("invitation.send");
    const { filename, bytes } = await uploadedFile(form);
    return previewBulkInvitations(getDb(), actor, filename, bytes);
  });
}

/** Bulk invitations, step 2: sends the rows that passed. */
export async function sendBulkInvitationsAction(batchId: string) {
  return runForResult(async () => {
    const actor = await authorizeAction("invitation.send");
    const { sent, failed } = await sendBulkInvitations(getDb(), actor, batchId);
    revalidatePath(PAGE);
    const plural = sent === 1 ? "invitation" : "invitations";
    if (failed.length === 0) return `${sent} ${plural} sent.`;
    const rows = failed.map((f) => `row ${f.rowNo}: ${f.error}`).join("; ");
    return `${sent} ${plural} sent. ${failed.length} not sent — ${rows}`;
  });
}
