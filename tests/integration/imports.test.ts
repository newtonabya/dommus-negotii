/**
 * Bulk invitations, Admin member import and activation of imported members
 * against the test database (PRD F5). Skipped when TEST_DATABASE_URL is not set.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { beginUpload, finishUpload } from "@/evidence/service";
import { LocalEvidenceStore } from "@/evidence/store";
import { previewBulkInvitations, sendBulkInvitations } from "@/modules/credit/members/bulk-invitations";
import { createInvitation, newInvitationToken } from "@/modules/credit/members/invitations";
import { commitMemberImport, previewMemberImport } from "@/modules/credit/members/member-import";
import {
  activateImportedMember,
  registerMember,
  registrantActorId,
  usableInvitation,
  type RegistrationDeps,
} from "@/modules/credit/members/registration";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

/** A fresh, valid Nigerian mobile number per call, in the local 0803… form. */
const phone = () => `080${String(randomInt(0, 1e8)).padStart(8, "0")}`;
const e164 = (local: string) => `+234${local.slice(1)}`;
const moaumId = () => `MA-${randomInt(1e6, 9e6)}`;
const csv = (lines: string[]) => new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
const actor = (prefix: string) => ({ id: `${prefix}-${randomUUID()}`, ipAddress: "127.0.0.1" });

const MEMBER_HEADER =
  "full_name,phone,email,address,moaum_id_number,next_of_kin_name,next_of_kin_phone,remittance_source_code,payroll_staff_no";
const memberLine = (p: string, id: string, source = "NONE", staffNo = "") =>
  `Ada Obi,${p},,"12 Allen Avenue, Ikeja",${id},Chidi Obi,07010000000,${source},${staffNo}`;

describeDb("bulk invitations and member import", () => {
  let db: PrismaClient;
  let dir: string;
  let store: LocalEvidenceStore;
  let sourceCode: string;

  const deps: RegistrationDeps = {
    verifyCode: async (_phone, code) => code === "123456",
    hashPassword: async (p) => `test-hash:${sha256Hex(p)}`,
    isPasswordCompromised: async () => false,
    newId: () => randomBytes(16).toString("hex"),
  };

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
    dir = await mkdtemp(path.join(tmpdir(), "imports-"));
    store = new LocalEvidenceStore(dir, "test-secret");
    sourceCode = `T${randomInt(1e6, 9e6)}`;
    await db.remittanceSource.create({ data: { code: sourceCode, name: "Test payroll", createdById: "test" } });
    jest.spyOn(console, "info").mockImplementation(() => {}); // console SMS/email provider output
  });

  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("checks every invitation row, sends only the valid ones, once", async () => {
    const secretary = actor("sec");
    const [good, alsoGood, dup, invited] = [phone(), phone(), phone(), phone()];
    await createInvitation(db, secretary, { fullName: "Already Invited", phone: invited, email: "", remittanceSourceId: "" });

    const preview = await previewBulkInvitations(
      db,
      secretary,
      "list.csv",
      csv([
        "Full Name,Phone,Email,Remittance Source Code",
        `Ada Obi,${good},,${sourceCode.toLowerCase()}`,
        `Bayo Ade,${alsoGood.slice(1)},bayo@example.com,NONE`, // leading zero dropped by Excel
        `Chi Eze,${dup},,`,
        `Chi Eze Again,${dup},,`,
        `Dan Uche,12345,,`,
        `Efe Oke,${invited},,`,
        `Femi Ola,${phone()},,NOPE`,
      ]),
    );
    const errorsByRow = Object.fromEntries(preview.rows.map((r) => [r.rowNo, r.errors.join(" ")]));
    expect(preview.validCount).toBe(3);
    expect(errorsByRow[2]).toBe("");
    expect(errorsByRow[3]).toBe("");
    expect(errorsByRow[4]).toBe("");
    expect(errorsByRow[5]).toMatch(/phone number/i);
    expect(errorsByRow[6]).not.toBe("");
    expect(errorsByRow[7]).toMatch(/open invitation/);
    expect(errorsByRow[8]).toMatch(/Unknown remittance source/);

    // Only the uploader can send their list.
    await expect(sendBulkInvitations(db, actor("other"), preview.batchId)).rejects.toThrow(/already sent or has expired/);

    const result = await sendBulkInvitations(db, secretary, preview.batchId);
    expect(result).toEqual({ sent: 3, failed: [] });
    const created = await db.invitation.findMany({ where: { phone: { in: [e164(good), e164(alsoGood), e164(dup)] } } });
    expect(created).toHaveLength(3);
    expect(created.every((i) => i.type === "REGISTRATION" && i.sentById === secretary.id)).toBe(true);
    expect(created.find((i) => i.phone === e164(good))?.remittanceSourceId).not.toBeNull();

    const batch = await db.importBatch.findUniqueOrThrow({ where: { id: preview.batchId }, include: { rows: true } });
    expect(batch).toMatchObject({ status: "COMMITTED", rowCount: 7, errorRowCount: 4, committedById: secretary.id });
    expect(batch.rows.filter((r) => r.entityId)).toHaveLength(3);
    await expect(sendBulkInvitations(db, secretary, preview.batchId)).rejects.toThrow(/already sent/);
  });

  it("imports nothing when any row has an error, and stores the file as evidence", async () => {
    const admin = actor("admin");
    const p = phone();
    const id = moaumId();
    const preview = await previewMemberImport(
      db,
      store,
      admin,
      "members.csv",
      csv([MEMBER_HEADER, memberLine(p, id), memberLine(phone(), id), memberLine("0803", moaumId())]),
    );
    expect(preview.validCount).toBe(1);
    expect(preview.rows[1]?.errors.join(" ")).toMatch(/MOAUM ID number/);
    expect(preview.rows[2]?.errors.join(" ")).toMatch(/^phone:/);

    const batch = await db.importBatch.findUniqueOrThrow({ where: { id: preview.batchId } });
    expect(batch.evidenceId).not.toBeNull();
    await expect(commitMemberImport(db, admin, preview.batchId)).rejects.toThrow(/Nothing was imported: 2 rows have errors/);
    expect((await db.importBatch.findUniqueOrThrow({ where: { id: preview.batchId } })).status).toBe("REJECTED");
    expect(await db.member.findUnique({ where: { phone: e164(p) } })).toBeNull();
    expect(await db.user.findUnique({ where: { phoneNumber: e164(p) } })).toBeNull();
  });

  it("imports ACTIVE members with an activation link, then lets each set up their login once", async () => {
    const admin = actor("admin");
    const [p1, p2] = [phone(), phone()];
    const staffNo = `S${randomInt(1e6, 9e6)}`;
    // A payroll member needs their staff number; it must be unique on the source.
    const missing = await previewMemberImport(db, store, admin, "members.csv", csv([MEMBER_HEADER, memberLine(phone(), moaumId(), sourceCode)]));
    expect(missing.rows[0]?.errors.join(" ")).toMatch(/payroll_staff_no: enter/);
    const preview = await previewMemberImport(
      db,
      store,
      admin,
      "members.csv",
      csv([MEMBER_HEADER, memberLine(p1, moaumId(), sourceCode, ` ${staffNo.toLowerCase()} `), memberLine(p2, moaumId())]),
    );
    expect(preview.validCount).toBe(2);
    await expect(commitMemberImport(db, actor("other"), preview.batchId)).rejects.toThrow(/already committed or has expired/);
    await expect(commitMemberImport(db, admin, preview.batchId)).resolves.toEqual({ imported: 2, smsFailed: 0 });
    await expect(commitMemberImport(db, admin, preview.batchId)).rejects.toThrow(/already committed/);

    const member = await db.member.findUniqueOrThrow({ where: { phone: e164(p1) } });
    expect(member).toMatchObject({ status: "ACTIVE", consentAt: null, idScanEvidenceId: null, reviewedById: admin.id });
    expect(member.remittanceSourceId).not.toBeNull();
    expect(member.payrollStaffNo).toBe(staffNo);
    expect(member.memberNo).toMatch(/^MCS-\d{5,}$/);
    const clash = await previewMemberImport(db, store, admin, "members.csv", csv([MEMBER_HEADER, memberLine(phone(), moaumId(), sourceCode, staffNo)]));
    expect(clash.rows[0]?.errors.join(" ")).toMatch(/already belongs to/);
    const user = await db.user.findUniqueOrThrow({ where: { id: member.userId }, include: { accounts: true } });
    expect(user).toMatchObject({ phoneNumber: e164(p1), phoneNumberVerified: false, accounts: [] });
    expect(await db.userModuleRole.findFirst({ where: { userId: member.userId, role: "MEMBER", revokedAt: null } })).not.toBeNull();
    const batch = await db.importBatch.findUniqueOrThrow({ where: { id: preview.batchId } });
    const link = await db.evidenceLink.findFirstOrThrow({ where: { entityType: "Member", entityId: member.id } });
    expect(link).toMatchObject({ evidenceId: batch.evidenceId, submissionKey: `MEMBER_IMPORT:${batch.id}` });

    // Importing the same people again is refused row by row.
    const again = await previewMemberImport(db, store, admin, "members.csv", csv([MEMBER_HEADER, memberLine(p1, moaumId())]));
    expect(again.rows[0]?.errors.join(" ")).toMatch(/already a member/);

    // Activation: the SMS link is re-keyed so the test knows its token.
    const invitation = await db.invitation.findUniqueOrThrow({ where: { id: member.invitationId as string } });
    expect(invitation.type).toBe("ACTIVATION");
    const { token, tokenHash } = newInvitationToken();
    await db.invitation.update({ where: { id: invitation.id }, data: { tokenHash } });

    const scanActor = { id: registrantActorId(invitation.id), ipAddress: null };
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(64)]);
    const begun = await beginUpload(db, store, scanActor, { filename: "id-card.jpg", size: jpg.length });
    await store.putFile(`staging/${begun.uploadId}`, jpg);
    const scanId = (await finishUpload(db, store, scanActor, begun.uploadId)).evidenceId;

    const input = { password: "Kesh-7Quv-Rimo-24Tz", confirmPassword: "Kesh-7Quv-Rimo-24Tz", consent: true as const, idScanEvidenceId: scanId };
    await expect(
      registerMember(db, token, { ...input, fullName: "x", email: "", address: "x", moaumIdNumber: "x", nextOfKinName: "x", nextOfKinPhone: "x", remittanceSourceId: "NONE", code: "123456" }, deps, null),
    ).rejects.toThrow(/setting up an existing membership/);
    await expect(activateImportedMember(db, token, { ...input, code: "000000" }, deps, null)).rejects.toThrow(/code didn't work/);
    expect(await db.account.count({ where: { userId: member.userId } })).toBe(0);

    await activateImportedMember(db, token, { ...input, code: "123456" }, deps, "127.0.0.1");
    const activated = await db.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(activated.consentAt).not.toBeNull();
    expect(activated.idScanEvidenceId).toBe(scanId);
    const after = await db.user.findUniqueOrThrow({ where: { id: member.userId }, include: { accounts: true } });
    expect(after.phoneNumberVerified).toBe(true);
    expect(after.accounts.map((a) => a.providerId)).toEqual(["credential"]);
    await expect(usableInvitation(db, token)).rejects.toThrow(/already been used/);
  });
});
