import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Db } from "@/lib/db";
import { TIME_ZONE } from "@/lib/dates";
import { describeValues, type ProfileValues } from "./profile-changes";
import { CONSENT_TEXT } from "./rules";

/**
 * A member's copy of the personal data MOAUM holds about them (PRD F5, NDPA
 * 2023): profile and KYC, login, consent, requests, evidence on file, messages
 * sent, and sign-in history. Loans and statements are added with Milestone 1b.
 */
export async function collectPersonalData(db: Db, userId: string) {
  const member = await db.member.findUnique({ where: { userId }, include: { remittanceSource: true } });
  if (!member) return null;
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const [requests, links, notifications, signIns] = await Promise.all([
    db.profileChangeRequest.findMany({ where: { memberId: member.id }, orderBy: { requestedAt: "asc" } }),
    db.evidenceLink.findMany({ where: { entityType: "Member", entityId: member.id }, include: { evidence: true } }),
    db.notification.findMany({
      where: { recipient: { in: [member.phone, user.email, ...(member.email ? [member.email] : [])] } },
      orderBy: { createdAt: "asc" },
      select: { channel: true, template: true, status: true, createdAt: true, sentAt: true },
    }),
    db.auditLog.findMany({
      where: { userId, action: { in: ["auth.login.success", "auth.login.failure", "auth.logout"] } },
      orderBy: { occurredAt: "desc" },
      take: 200,
      select: { action: true, occurredAt: true, ipAddress: true },
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    controller: "MOAUM Consultancy Services (MOAUM Credit Super Store), via Dommus Negotii",
    member: {
      id: member.id,
      status: member.status,
      fullName: member.fullName,
      phone: member.phone,
      email: member.email,
      address: member.address,
      moaumIdNumber: member.moaumIdNumber,
      idCardScanOnFile: Boolean(member.idScanEvidenceId),
      nextOfKin: { name: member.nextOfKinName, phone: member.nextOfKinPhone },
      remittanceSource: member.remittanceSource?.name ?? "None — pays directly",
      registeredAt: member.createdAt.toISOString(),
      reviewedAt: member.reviewedAt?.toISOString() ?? null,
      declineReason: member.declineReason,
    },
    login: {
      name: user.name,
      email: user.email.endsWith("@members.dommus.invalid") ? null : user.email,
      phone: user.phoneNumber,
      phoneVerified: user.phoneNumberVerified,
      createdAt: user.createdAt.toISOString(),
    },
    consent: {
      acceptedAt: member.consentAt?.toISOString() ?? null,
      version: member.consentVersion,
      notice: CONSENT_TEXT,
    },
    profileChangeRequests: await Promise.all(
      requests.map(async (r) => ({
        requestedAt: r.requestedAt.toISOString(),
        status: r.status,
        changes: (await describeValues(db, r.changes as ProfileValues)).map((c) => ({ field: c.label, value: c.text })),
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decisionNote: r.decisionNote,
      })),
    ),
    documentsOnFile: links.map((l) => ({
      filename: l.evidence.filename,
      type: l.evidence.mimeType,
      sha256: l.evidence.sha256,
      uploadedAt: l.evidence.uploadedAt.toISOString(),
      purpose: l.submissionKey.split(":")[0],
    })),
    messagesSent: notifications.map((n) => ({
      channel: n.channel,
      kind: n.template,
      status: n.status,
      at: (n.sentAt ?? n.createdAt).toISOString(),
    })),
    signInHistory: signIns.map((s) => ({ event: s.action.replace("auth.", ""), at: s.occurredAt.toISOString(), ipAddress: s.ipAddress })),
    loans: [] as unknown[],
    statements: [] as unknown[],
    notes: [
      "Loans and statements appear here once the loan features are live.",
      "Message texts are not kept (they can hold one-time codes), only that a message was sent.",
      "To correct anything, request a change in the portal or contact MOAUM.",
    ],
  };
}

export type PersonalData = NonNullable<Awaited<ReturnType<typeof collectPersonalData>>>;

/** The standard PDF fonts only cover Latin-1: drop accents (e.g. Ọ̀ → O) rather than print "?". The JSON keeps the exact text. */
function latin(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[—–]/g, "-")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-NG", { timeZone: TIME_ZONE, dateStyle: "medium", timeStyle: "short" }) : "-";

/** The same data as a readable A4 PDF. */
export async function personalDataPdf(data: PersonalData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Copy of my personal data");
  pdf.setCreator("Dommus Negotii");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = 50;
  const width = 595.28 - margin * 2;
  let page: PDFPage = pdf.addPage([595.28, 841.89]);
  let y = 841.89 - margin;

  const newPageIfNeeded = (height: number) => {
    if (y - height < margin) {
      page = pdf.addPage([595.28, 841.89]);
      y = 841.89 - margin;
    }
  };
  const wrap = (text: string, f: PDFFont, size: number): string[] => {
    const lines: string[] = [];
    for (const paragraph of latin(text).split("\n")) {
      let line = "";
      for (const word of paragraph.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(next, size) > width && line) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      lines.push(line);
    }
    return lines;
  };
  const write = (text: string, opts: { size?: number; f?: PDFFont; gap?: number; color?: number } = {}) => {
    const size = opts.size ?? 10;
    for (const line of wrap(text, opts.f ?? font, size)) {
      newPageIfNeeded(size + 4);
      page.drawText(line, { x: margin, y: y - size, size, font: opts.f ?? font, color: rgb(opts.color ?? 0, opts.color ?? 0, opts.color ?? 0) });
      y -= size + 4;
    }
    y -= opts.gap ?? 0;
  };
  const heading = (text: string) => {
    y -= 8;
    write(text, { size: 13, f: bold, gap: 2 });
  };
  const row = (label: string, value: string | null | boolean) =>
    write(`${label}: ${value === null ? "-" : typeof value === "boolean" ? (value ? "Yes" : "No") : value}`);

  write("Copy of my personal data", { size: 18, f: bold, gap: 4 });
  write(`Generated ${when(data.generatedAt)} (Lagos time) under the Nigeria Data Protection Act 2023.`, { color: 0.35 });
  write(`Data controller: ${data.controller}`, { color: 0.35, gap: 6 });

  heading("Membership and KYC details");
  const m = data.member;
  row("Status", m.status);
  row("Full name", m.fullName);
  row("Phone", m.phone);
  row("Email", m.email);
  row("Address", m.address);
  row("MOAUM ID number", m.moaumIdNumber);
  row("ID card scan on file", m.idCardScanOnFile);
  row("Next of kin", `${m.nextOfKin.name}, ${m.nextOfKin.phone}`);
  row("Remittance source", m.remittanceSource);
  row("Registered", when(m.registeredAt));
  row("Reviewed", when(m.reviewedAt));
  if (m.declineReason) row("Decline reason", m.declineReason);

  heading("Login");
  row("Name", data.login.name);
  row("Email", data.login.email);
  row("Phone", data.login.phone);
  row("Phone verified", data.login.phoneVerified);
  row("Created", when(data.login.createdAt));

  heading("Consent");
  row("Accepted", when(data.consent.acceptedAt));
  row("Notice version", data.consent.version);
  write(data.consent.notice, { color: 0.35 });

  heading(`Profile change requests (${data.profileChangeRequests.length})`);
  if (data.profileChangeRequests.length === 0) write("None.");
  for (const r of data.profileChangeRequests) {
    write(`${when(r.requestedAt)} - ${r.status}${r.decisionNote ? ` (${r.decisionNote})` : ""}`, { f: bold });
    for (const c of r.changes) write(`  ${c.field}: ${c.value}`);
  }

  heading(`Documents on file (${data.documentsOnFile.length})`);
  if (data.documentsOnFile.length === 0) write("None.");
  for (const d of data.documentsOnFile) write(`${d.filename} (${d.type}), uploaded ${when(d.uploadedAt)}, for ${d.purpose}`);

  heading(`Messages sent to you (${data.messagesSent.length})`);
  if (data.messagesSent.length === 0) write("None.");
  for (const n of data.messagesSent) write(`${when(n.at)} - ${n.channel} ${n.kind} (${n.status})`);

  heading(`Sign-in history (latest ${data.signInHistory.length})`);
  if (data.signInHistory.length === 0) write("None.");
  for (const s of data.signInHistory) write(`${when(s.at)} - ${s.event}${s.ipAddress ? ` from ${s.ipAddress}` : ""}`);

  heading("Loans and statements");
  write("None yet.");

  heading("Notes");
  for (const n of data.notes) write(`- ${n}`);
  return pdf.save();
}
