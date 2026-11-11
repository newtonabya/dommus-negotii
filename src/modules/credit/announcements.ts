import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { writeAudit } from "@/shell/audit/audit";
import { queueOnChannel } from "@/shell/notifications/messages";

/**
 * Announcements (PRD F15): the GMD or the Secretary sends an SMS and/or email
 * to every ACTIVE member, or to the ACTIVE members of one remittance source.
 * Sending takes two steps: a preview that counts recipients and SMS units,
 * then a send that must carry the preview's token, so nothing goes out
 * unconfirmed or to a different audience than the one shown.
 */
export class AnnouncementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnnouncementError";
  }
}

export interface AnnouncementInput {
  /** "ALL" or a remittance source id. */
  audience: string;
  viaSms: boolean;
  viaEmail: boolean;
  subject: string;
  body: string;
}

const PREFIX = "MOAUM Credit Super Store: ";
const MAX_BODY = 600;

// The characters one SMS unit can carry 160 of (GSM 03.38 basic set); anything else makes it 70.
const GSM = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà");

/** How many SMS units one message of this text costs. */
export function smsUnits(text: string): number {
  const plain = [...text].every((c) => GSM.has(c));
  const length = [...text].length;
  const [single, multi] = plain ? [160, 153] : [70, 67];
  return length <= single ? 1 : Math.ceil(length / multi);
}

function clean(input: AnnouncementInput) {
  const body = input.body.trim();
  const subject = input.subject.trim().slice(0, 120);
  if (!input.viaSms && !input.viaEmail) throw new AnnouncementError("Choose SMS, email or both.");
  if (body.length < 10) throw new AnnouncementError("Write the announcement (at least 10 characters).");
  if (body.length > MAX_BODY) throw new AnnouncementError(`Keep the announcement under ${MAX_BODY} characters.`);
  if (input.viaEmail && subject.length < 3) throw new AnnouncementError("Give the email a subject.");
  return { audience: input.audience, viaSms: input.viaSms, viaEmail: input.viaEmail, subject, body };
}

async function plan(db: Db, raw: AnnouncementInput) {
  const input = clean(raw);
  let audienceLabel = "All active members";
  if (input.audience !== "ALL") {
    const source = await db.remittanceSource.findUnique({ where: { id: input.audience } }).catch(() => null);
    if (!source) throw new AnnouncementError("Choose who receives it.");
    audienceLabel = `Active members on ${source.name} (${source.code})`;
  }
  // ACTIVE members only, never pending, declined or exited ones.
  const members = await db.member.findMany({
    where: { status: "ACTIVE", ...(input.audience === "ALL" ? {} : { remittanceSourceId: input.audience }) },
    select: { userId: true, user: { select: { email: true, phoneNumber: true, deactivatedAt: true } } },
  });
  const active = members.filter((m) => !m.user.deactivatedAt);
  const sms = input.viaSms ? active.filter((m) => m.user.phoneNumber).map((m) => m.userId) : [];
  const email = input.viaEmail ? active.filter((m) => !m.user.email.endsWith(".invalid")).map((m) => m.userId) : [];
  const unitsEach = smsUnits(PREFIX + input.body);
  const counts = {
    recipientCount: new Set([...sms, ...email]).size,
    smsCount: sms.length,
    smsUnitsEach: unitsEach,
    smsUnits: sms.length * unitsEach,
    emailCount: email.length,
    withoutEmail: input.viaEmail ? active.length - email.length : 0,
  };
  const token = createHash("sha256")
    .update(JSON.stringify([input, counts]))
    .digest("hex");
  return { input, audienceLabel, sms, email, counts, token };
}

/** Step 1: who would receive it and what it costs. Sends nothing. */
export async function previewAnnouncement(db: Db, input: AnnouncementInput) {
  const p = await plan(db, input);
  if (p.counts.recipientCount === 0) throw new AnnouncementError("Nobody would receive this: no active member has the chosen contact details.");
  return { audienceLabel: p.audienceLabel, ...p.counts, token: p.token };
}

/** Step 2: sends what the preview showed. Refused if anything changed since the preview. */
export async function sendAnnouncement(db: PrismaClient, actor: { id: string; ipAddress: string | null }, input: AnnouncementInput, confirmToken: string) {
  const p = await plan(db, input);
  if (!confirmToken || confirmToken !== p.token) {
    throw new AnnouncementError("The recipients or the text changed since you checked. Check the recipients again, then confirm.");
  }
  if (p.counts.recipientCount === 0) throw new AnnouncementError("Nobody would receive this.");
  return db.$transaction(
    async (tx) => {
      const announcement = await tx.announcement.create({
        data: {
          sentById: actor.id,
          audience: p.input.audience,
          audienceLabel: p.audienceLabel,
          viaSms: p.input.viaSms,
          viaEmail: p.input.viaEmail,
          subject: p.input.viaEmail ? p.input.subject : null,
          body: p.input.body,
          recipientCount: p.counts.recipientCount,
          smsCount: p.counts.smsCount,
          smsUnits: p.counts.smsUnits,
          emailCount: p.counts.emailCount,
        },
      });
      const key = `announcement:${announcement.id}`;
      const subject = p.input.subject || "MOAUM Credit Super Store";
      await queueOnChannel(tx, p.sms, "SMS", { key, template: "announcement", subject, text: PREFIX + p.input.body });
      await queueOnChannel(tx, p.email, "EMAIL", { key, template: "announcement", subject, text: `${p.input.body}\n\nMOAUM Credit Super Store` });
      await writeAudit(tx, {
        action: "announcement.send",
        entityType: "Announcement",
        entityId: announcement.id,
        userId: actor.id,
        ipAddress: actor.ipAddress,
        after: { audience: p.audienceLabel, sms: p.counts.smsCount, smsUnits: p.counts.smsUnits, emails: p.counts.emailCount },
      });
      return announcement;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

/** Recent announcements with how many messages were sent, are waiting, or failed. */
export async function listAnnouncements(db: Db, take = 15) {
  const items = await db.announcement.findMany({ orderBy: { createdAt: "desc" }, take });
  const out = [];
  // One at a time: a page of these must not take a connection each.
  for (const a of items) {
    const groups = await db.notification.groupBy({ by: ["status"], where: { idempotencyKey: { startsWith: `announcement:${a.id}:` } }, _count: true });
    const count = (status: string) => groups.find((g) => g.status === status)?._count ?? 0;
    out.push({ ...a, sent: count("SENT") + count("DELIVERED"), waiting: count("QUEUED"), failed: count("FAILED") });
  }
  return out;
}
