"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/shell/audit/audit";
import { requireUser } from "@/shell/auth/session";

/** A signed-in user chooses where their status messages go (PRD F15). Codes are not affected. */
export async function setPreferredChannelAction(page: "/staff/account" | "/member/profile", form: FormData): Promise<never> {
  const user = await requireUser();
  const value = form.get("channel");
  const channel = value === "SMS" || value === "EMAIL" ? value : null;
  const db = getDb();
  const current = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { email: true, phoneNumber: true, preferredChannel: true } });
  let notice = "Saved.";
  let tone: "ok" | "error" = "ok";
  if (channel === "SMS" && !current.phoneNumber) {
    notice = "There is no phone number on your login, so messages can't go by SMS.";
    tone = "error";
  } else if (channel === "EMAIL" && current.email.endsWith(".invalid")) {
    notice = "There is no email address on your record. Add one first, then choose email.";
    tone = "error";
  } else {
    await db.user.update({ where: { id: user.id }, data: { preferredChannel: channel } });
    await writeAudit(db, { action: "user.preferred_channel", entityType: "User", entityId: user.id, userId: user.id, ipAddress: null, before: { channel: current.preferredChannel }, after: { channel } });
  }
  revalidatePath(page);
  redirect(`${page}?${tone}=${encodeURIComponent(notice)}`);
}
