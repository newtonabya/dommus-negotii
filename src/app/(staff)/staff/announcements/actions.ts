"use server";

import { getDb } from "@/lib/db";
import { previewAnnouncement, sendAnnouncement, type AnnouncementInput } from "@/modules/credit/announcements";
import { authorizeAction } from "@/shell/auth/session";
import { runForResult } from "../run-action";

/** Step 1: counts recipients and SMS units. Sends nothing. */
export async function previewAnnouncementAction(input: AnnouncementInput) {
  return runForResult(async () => {
    await authorizeAction("announcement.send");
    return previewAnnouncement(getDb(), input);
  });
}

/** Step 2: sends what the preview showed (PRD F15: never without the confirmation step). */
export async function sendAnnouncementAction(input: AnnouncementInput, token: string) {
  return runForResult(async () => {
    const actor = await authorizeAction("announcement.send");
    const sent = await sendAnnouncement(getDb(), actor, input, token);
    return `Announcement sent to ${sent.recipientCount} member(s). Delivery shows below as it completes.`;
  });
}
