/**
 * Notification triggers, reminders and announcements (PRD F15) against the
 * test database. Skipped when TEST_DATABASE_URL is not set.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient, Role } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { beginUpload, finishUpload } from "@/evidence/service";
import { LocalEvidenceStore } from "@/evidence/store";
import { AnnouncementError, listAnnouncements, previewAnnouncement, sendAnnouncement, smsUnits } from "@/modules/credit/announcements";
import { saveMemberApplication } from "@/modules/credit/loans/applications";
import { toDbDate } from "@/modules/credit/loans/common";
import { approveLoan, recommendLoan, verifyLoan } from "@/modules/credit/loans/review";
import { placeholderEmail } from "@/modules/credit/members/rules";
import { ngn, schedulePosted } from "@/modules/credit/notices";
import { queueReminders } from "@/modules/credit/reminders";
import { localDate } from "@/lib/dates";
import { raiseException } from "@/shell/exceptions/exceptions";
import { channelFor, deliverQueued, queueForUser } from "@/shell/notifications/messages";
import type { NotificationProvider } from "@/shell/notifications/providers";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(200_000);

describe("message channel (F15)", () => {
  const base = { email: "ada@example.com", phoneNumber: "+2348030000001", preferredChannel: null, isStaff: false };
  it("defaults to SMS for members and email for staff, and follows a usable preference", () => {
    expect(channelFor(base)).toEqual({ channel: "SMS", recipient: "+2348030000001" });
    expect(channelFor({ ...base, isStaff: true })).toEqual({ channel: "EMAIL", recipient: "ada@example.com" });
    expect(channelFor({ ...base, preferredChannel: "EMAIL" })).toEqual({ channel: "EMAIL", recipient: "ada@example.com" });
    // A member with only a placeholder address can't be emailed, whatever they chose.
    expect(channelFor({ ...base, email: "2348030000001@members.dommus.invalid", preferredChannel: "EMAIL" })).toEqual({ channel: "SMS", recipient: "+2348030000001" });
    expect(channelFor({ ...base, phoneNumber: null, email: "x@members.dommus.invalid" })).toBeNull();
  });
  it("counts SMS units: 160 plain characters, 70 once a symbol such as the naira sign appears", () => {
    expect(smsUnits("a".repeat(160))).toBe(1);
    expect(smsUnits("a".repeat(161))).toBe(2);
    expect(smsUnits(`₦${"a".repeat(69)}`)).toBe(1);
    expect(smsUnits(`₦${"a".repeat(70)}`)).toBe(2);
    expect(ngn(6_125_000n)).toBe("NGN 61,250.00");
  });
});

describeDb("notification triggers (F15)", () => {
  let db: PrismaClient;
  let dir: string;
  let store: LocalEvidenceStore;
  const run = randomUUID().slice(0, 8);
  const who = (p: string) => ({ id: `${p}-${randomUUID()}`, ipAddress: "127.0.0.1" });
  const phone = () => `+23480${String(randomInt(0, 1e8)).padStart(8, "0")}`;
  const sink = (ok = true): NotificationProvider & { sent: Array<{ to: string; text: string }> } => {
    const sent: Array<{ to: string; text: string }> = [];
    return { name: "test", channel: "SMS", sent, send: async (m) => (sent.push({ to: m.to, text: m.text }), { ok, response: "x" }) } as NotificationProvider & { sent: Array<{ to: string; text: string }> };
  };
  const queued = (prefix: string) => db.notification.findMany({ where: { idempotencyKey: { startsWith: prefix } }, orderBy: { idempotencyKey: "asc" } });

  async function staffUser(role: Role) {
    const id = randomBytes(16).toString("hex");
    await db.user.create({ data: { id, name: `Test ${role}`, email: `f15-${role.toLowerCase()}-${run}-${randomInt(1e6)}@example.invalid.test` } });
    await db.userModuleRole.create({ data: { userId: id, moduleCode: "CREDIT", role, assignedById: "test" } });
    return { id, ipAddress: "127.0.0.1" };
  }
  async function member(name: string, over: { sourceId?: string | null; status?: "ACTIVE" | "PENDING"; email?: string } = {}) {
    const userId = randomBytes(16).toString("hex");
    const p = phone();
    await db.user.create({ data: { id: userId, name, email: over.email ?? placeholderEmail(p), phoneNumber: p, phoneNumberVerified: true } });
    const m = await db.member.create({
      data: { userId, fullName: name, phone: p, address: "12 Old Otukpo Road, Makurdi", moaumIdNumber: `MA-${randomInt(1e7, 9e7)}`, idScanEvidenceId: randomUUID(), nextOfKinName: "Kin", nextOfKinPhone: "+2347010000000", status: over.status ?? "ACTIVE", remittanceSourceId: over.sourceId ?? null },
    });
    return { member: m, user: { id: userId, ipAddress: "127.0.0.1" }, phone: p };
  }

  beforeAll(async () => {
    db = createClient(url as string);
    for (let attempt = 1; ; attempt++) {
      try {
        await db.$queryRaw`SELECT 1`;
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
    dir = await mkdtemp(path.join(tmpdir(), "f15-"));
    store = new LocalEvidenceStore(dir, "test-secret");
    jest.spyOn(console, "info").mockImplementation(() => {});
  });
  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("tells the member and the next staff role at each loan step, once each, and never the person who acted", async () => {
    const officer = await staffUser("LOAN_OFFICER");
    const management = await staffUser("MANAGEMENT");
    const cashier = await staffUser("CASHIER");
    const { user, phone: memberPhone } = await member("Ngozi Test");
    const a = { id: user.id, ipAddress: null };
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...randomBytes(64)]);
    const begun = await beginUpload(db, store, a, { filename: "form.pdf", size: bytes.length });
    await store.putFile(`staging/${begun.uploadId}`, bytes);
    const form = (await finishUpload(db, store, a, begun.uploadId)).evidenceId;
    const { loanId } = await saveMemberApplication(
      db,
      user,
      { amount: "200,000", tenure: 6, purpose: "Shop stock for the season", guarantorIsMember: false, guarantorName: "Terver Iorliam", guarantorPhone: `0${phone().slice(4)}`, guarantorAddress: "12 High Level, Makurdi", guarantorRelationship: "Colleague", guarantorFormEvidenceId: form },
      true,
    );

    const submitted = await queued(`loan.submitted:${loanId}:`);
    const toMember = submitted.find((n) => n.recipient === memberPhone);
    expect(toMember).toMatchObject({ channel: "SMS", status: "QUEUED", template: "loan.submitted" });
    expect(toMember?.retryText).toMatch(/your loan application CSS-.* was received/);
    expect(submitted.some((n) => n.idempotencyKey.includes(`:${officer.id}:EMAIL`) && n.template === "staff.loan.submitted")).toBe(true);

    await verifyLoan(db, officer, loanId, "Checked");
    await recommendLoan(db, officer, loanId, "Within limits");
    const recommended = await queued(`loan.recommended:${loanId}:`);
    expect(recommended.some((n) => n.idempotencyKey.includes(`:${management.id}:EMAIL`))).toBe(true);
    // Internal steps are not texted to the member.
    expect(recommended.some((n) => n.recipient === memberPhone)).toBe(false);

    await approveLoan(db, management, loanId, { amount: "200,000", tenure: "6", comment: "" });
    const approved = await queued(`loan.approved:${loanId}:`);
    expect(approved.find((n) => n.recipient === memberPhone)?.retryText).toMatch(/is approved: NGN 200,000.00 over 6 months/);
    expect(approved.some((n) => n.idempotencyKey.includes(`:${cashier.id}:EMAIL`))).toBe(true);
    expect(approved.some((n) => n.idempotencyKey.includes(`:${management.id}:`))).toBe(false);

    // Delivered once; a second pass has nothing to send.
    const out = sink();
    const first = await deliverQueued(db, { provider: out, keyPrefix: `loan.submitted:${loanId}:` });
    expect(first.sent).toBe(submitted.length);
    expect(out.sent.some((m) => m.to === memberPhone)).toBe(true);
    expect((await deliverQueued(db, { provider: out, keyPrefix: `loan.submitted:${loanId}:` })).tried).toBe(0);
    expect((await queued(`loan.submitted:${loanId}:`)).every((n) => n.status === "SENT" && n.retryText === null)).toBe(true);
  });

  it("sends nothing for work that was rolled back", async () => {
    const { user } = await member("Rolled Back");
    const key = `test.rollback:${run}`;
    await expect(
      db.$transaction(async (tx) => {
        await queueForUser(tx, user.id, { key, template: "test", subject: "s", text: "This must never be sent." });
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    expect(await queued(key)).toHaveLength(0);
  });

  it("tells each member what a posted schedule applied for them", async () => {
    const a = await member("Row One");
    const b = await member("Row Two");
    const rows = [
      { id: randomUUID(), memberId: a.member.id, amount: 6_125_000n, toCredit: false, loanAccountNo: "CSS-2099-00001" },
      { id: randomUUID(), memberId: b.member.id, amount: 1_000_000n, toCredit: true, loanAccountNo: null },
    ];
    await schedulePosted(db, { id: randomUUID(), reference: "SCH-TEST", month: "2099-10" }, rows);
    const one = await queued(`schedule.posted:${rows[0]?.id}`);
    const two = await queued(`schedule.posted:${rows[1]?.id}`);
    expect(one[0]?.retryText).toBe("MOAUM Credit Super Store: NGN 61,250.00 received for 2099-10 and applied to loan CSS-2099-00001 (ref SCH-TEST).");
    expect(two[0]?.retryText).toMatch(/NGN 10,000.00 received for 2099-10 and added to your Overpayment Credit/);
    expect(smsUnits(one[0]?.retryText ?? "")).toBe(1);
  });

  it("reminds direct payers before the due date and anyone in arrears after it, once per cycle", async () => {
    const direct = await member("Direct Payer");
    const loan = await db.loan.create({
      data: { loanAccountNo: `CSS-N${randomInt(1e7, 9e7)}`, memberId: direct.member.id, status: "ACTIVE", purpose: "Test", amountRequested: 10_000_000n, tenureRequested: 10, amountApproved: 10_000_000n, tenureApproved: 10, rateBps: 750, d0: toDbDate(localDate("2031-03-10")), createdById: "test" },
    });
    const scope = { loanIds: [loan.id] };
    // Ten days before the first due date (10 April): too early.
    expect(await queueReminders(db, localDate("2031-03-31"), scope)).toMatchObject({ dueSoon: 0, arrears: 0 });
    // Four days before: reminded once, however often the job runs.
    expect(await queueReminders(db, localDate("2031-04-06"), scope)).toMatchObject({ dueSoon: 1, arrears: 0 });
    await queueReminders(db, localDate("2031-04-07"), scope);
    const due = await queued(`reminder.due:${loan.id}:`);
    expect(due).toHaveLength(1);
    expect(due[0]?.retryText).toMatch(/NGN 17,500.00 is due on 2031-04-10 for loan CSS-N/);
    // Two days late: not yet. Four days late: an arrears reminder for that cycle.
    expect((await queueReminders(db, localDate("2031-04-12"), scope)).arrears).toBe(0);
    expect((await queueReminders(db, localDate("2031-04-14"), scope)).arrears).toBe(1);
    await queueReminders(db, localDate("2031-04-20"), scope);
    expect(await queued(`reminder.arrears:${loan.id}:`)).toHaveLength(1);
    // Still unpaid a cycle later: reminded again for the new due date.
    await queueReminders(db, localDate("2031-05-14"), scope);
    const arrears = await queued(`reminder.arrears:${loan.id}:`);
    expect(arrears.map((n) => n.idempotencyKey.split(":")[2])).toEqual(["2031-04-10", "2031-05-10"]);
  });

  it("emails the Finance Manager and the GMD when a new exception is raised, once", async () => {
    const fm = await staffUser("FINANCE_MANAGER");
    const input = { moduleCode: "CREDIT", type: "SHORTFALL", dedupeKey: `test-f15:${run}`, title: `Test shortfall ${run}` };
    const { exception } = await raiseException(db, input);
    await raiseException(db, input);
    const rows = await queued(`exception.raised:${exception.id}:${fm.id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "EMAIL", template: "staff.exception.raised" });
  });

  it("sends an announcement only after the confirmation step, and only to ACTIVE members of the audience", async () => {
    const source = await db.remittanceSource.create({ data: { code: `ANN-${randomInt(1e5, 9e5)}`, name: "Announcement test payroll", createdById: "test" } });
    const one = await member("Active One", { sourceId: source.id });
    const two = await member("Active Two", { sourceId: source.id, email: `f15-two-${run}@example.invalid.test` });
    const pending = await member("Pending Three", { sourceId: source.id, status: "PENDING" });
    const secretary = who("secretary");
    const input = { audience: source.id, viaSms: true, viaEmail: true, subject: "Annual general meeting", body: "The annual general meeting holds on 12 December at 10am in the main hall." };

    await expect(previewAnnouncement(db, { ...input, viaSms: false, viaEmail: false })).rejects.toThrow(AnnouncementError);
    const preview = await previewAnnouncement(db, input);
    expect(preview).toMatchObject({ recipientCount: 2, smsCount: 2, smsUnitsEach: 1, smsUnits: 2, emailCount: 1, withoutEmail: 1 });

    // No token, or a token for different text: nothing is sent.
    await expect(sendAnnouncement(db, secretary, input, "")).rejects.toThrow(/Check the recipients again/);
    await expect(sendAnnouncement(db, secretary, { ...input, body: `${input.body} Bring your ID card.` }, preview.token)).rejects.toThrow(/changed since you checked/);
    expect(await db.announcement.count({ where: { audience: source.id } })).toBe(0);

    const sent = await sendAnnouncement(db, secretary, input, preview.token);
    const rows = await queued(`announcement:${sent.id}:`);
    expect(rows.map((r) => r.recipient).sort()).toEqual([one.phone, two.phone, `f15-two-${run}@example.invalid.test`].sort());
    expect(rows.some((r) => r.recipient === pending.phone)).toBe(false);

    const out = sink();
    await deliverQueued(db, { provider: out, keyPrefix: `announcement:${sent.id}:` });
    const listed = (await listAnnouncements(db, 5)).find((a) => a.id === sent.id);
    expect(listed).toMatchObject({ sent: 3, waiting: 0, failed: 0, recipientCount: 2, smsUnits: 2 });
  });
});
