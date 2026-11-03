/**
 * Member invitations, registration and review against the test database
 * (PRD F5, AT-q). Skipped when TEST_DATABASE_URL is not set.
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
import {
  createInvitation,
  MemberError,
  newInvitationToken,
  resendInvitation,
  revokeInvitation,
} from "@/modules/credit/members/invitations";
import { registerMember, registrantActorId, usableInvitation, type RegistrationDeps } from "@/modules/credit/members/registration";
import { activateMember, declineMember } from "@/modules/credit/members/review";
import type { RegistrationInput } from "@/modules/credit/members/rules";
import { ForbiddenError } from "@/shell/rbac/permissions";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(90_000);

/** A fresh, valid Nigerian mobile number per call. */
const phone = () => `+23480${String(randomInt(0, 1e8)).padStart(8, "0")}`;

describeDb("member onboarding", () => {
  let db: PrismaClient;
  let dir: string;
  let store: LocalEvidenceStore;
  const secretary = { id: `sec-${randomUUID()}`, ipAddress: "127.0.0.1" };
  const officer = { id: `lo-${randomUUID()}`, ipAddress: "127.0.0.1" };

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
    dir = await mkdtemp(path.join(tmpdir(), "members-"));
    store = new LocalEvidenceStore(dir, "test-secret");
    jest.spyOn(console, "info").mockImplementation(() => {}); // console SMS/email provider output
  });

  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  /** Creates an invitation and returns a usable link token for it. */
  async function invite(phoneNumber = phone()) {
    const { invitation } = await createInvitation(db, secretary, {
      fullName: "Ada Obi",
      phone: phoneNumber,
      email: "",
      remittanceSourceId: "",
    });
    // The real token went out by SMS; give this test its own by re-keying the row.
    const { token, tokenHash } = newInvitationToken();
    await db.invitation.update({ where: { id: invitation.id }, data: { tokenHash } });
    return { invitation, token };
  }

  async function uploadScan(invitationId: string) {
    const actor = { id: registrantActorId(invitationId), ipAddress: null };
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(64)]);
    const begun = await beginUpload(db, store, actor, { filename: "id-card.jpg", size: jpg.length });
    await store.putFile(`staging/${begun.uploadId}`, jpg);
    return (await finishUpload(db, store, actor, begun.uploadId)).evidenceId;
  }

  function form(scanId: string, overrides: Partial<RegistrationInput> = {}): RegistrationInput & { code: string } {
    return {
      fullName: "Ada Obi",
      email: "",
      address: "12 Allen Avenue, Ikeja, Lagos",
      moaumIdNumber: `MA-${randomInt(1e6, 9e6)}`,
      idScanEvidenceId: scanId,
      nextOfKinName: "Chidi Obi",
      nextOfKinPhone: "0701 000 0000",
      remittanceSourceId: "NONE",
      password: "Kesh-7Quv-Rimo-24Tz",
      confirmPassword: "Kesh-7Quv-Rimo-24Tz",
      consent: true,
      code: "123456",
      ...overrides,
    };
  }

  it("refuses a second open invitation for the same phone", async () => {
    const { invitation } = await invite();
    await expect(
      createInvitation(db, secretary, { fullName: "Ada Obi", phone: invitation.phone, email: "", remittanceSourceId: "" }),
    ).rejects.toThrow(/open invitation/);
  });

  it("invalidates the old link on resend, and refuses revoked and expired links", async () => {
    const { invitation, token } = await invite();
    await expect(usableInvitation(db, token)).resolves.toMatchObject({ id: invitation.id });

    await resendInvitation(db, secretary, invitation.id);
    await expect(usableInvitation(db, token)).rejects.toThrow(/isn't valid/);

    const second = await invite();
    await revokeInvitation(db, secretary, second.invitation.id);
    await expect(usableInvitation(db, second.token)).rejects.toThrow(/cancelled/);

    const third = await invite();
    await db.invitation.update({ where: { id: third.invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(usableInvitation(db, third.token)).rejects.toThrow(/expired/);
  });

  it("allows at most 3 sends to one number per week", async () => {
    const { invitation } = await invite();
    await resendInvitation(db, secretary, invitation.id);
    await resendInvitation(db, secretary, invitation.id);
    await expect(resendInvitation(db, secretary, invitation.id)).rejects.toThrow(/3 invitations this week/);
  });

  it("registers a PENDING member with a verified phone, login and linked ID scan, once (AT-q)", async () => {
    const { invitation, token } = await invite();
    const scanId = await uploadScan(invitation.id);
    const member = await registerMember(db, token, form(scanId), deps, "127.0.0.1");

    expect(member).toMatchObject({ status: "PENDING", phone: invitation.phone, invitedById: secretary.id, idScanEvidenceId: scanId });
    const user = await db.user.findUniqueOrThrow({ where: { id: member.userId }, include: { accounts: true } });
    expect(user).toMatchObject({ phoneNumber: invitation.phone, phoneNumberVerified: true });
    expect(user.accounts.map((a) => a.providerId)).toEqual(["credential"]);
    const link = await db.evidenceLink.findFirstOrThrow({ where: { evidenceId: scanId, entityType: "Member" } });
    expect(link).toMatchObject({ kind: "PRIMARY", submissionKey: `MEMBER_REGISTRATION:${member.id}` });

    // The link works once.
    await expect(registerMember(db, token, form(scanId), deps, null)).rejects.toThrow(/already been used/);
  });

  it("creates nothing when the SMS code is wrong", async () => {
    const { invitation, token } = await invite();
    const scanId = await uploadScan(invitation.id);
    await expect(registerMember(db, token, form(scanId, {}), { ...deps, verifyCode: async () => false }, null)).rejects.toThrow(
      /code didn't work/,
    );
    expect(await db.member.findUnique({ where: { phone: invitation.phone } })).toBeNull();
    expect(await db.user.findUnique({ where: { phoneNumber: invitation.phone } })).toBeNull();
  });

  it("rejects a duplicate MOAUM ID number and a scan uploaded through another link", async () => {
    const first = await invite();
    const firstScan = await uploadScan(first.invitation.id);
    const moaumIdNumber = `MA-${randomInt(1e6, 9e6)}`;
    await registerMember(db, first.token, form(firstScan, { moaumIdNumber }), deps, null);

    const second = await invite();
    const secondScan = await uploadScan(second.invitation.id);
    await expect(registerMember(db, second.token, form(secondScan, { moaumIdNumber }), deps, null)).rejects.toThrow(
      /MOAUM ID card number is already registered/,
    );
    await expect(registerMember(db, second.token, form(firstScan), deps, null)).rejects.toThrow(/Upload a JPG, PNG or PDF/);
  });

  it("lets a Loan Officer activate or decline, but never their own registration", async () => {
    const a = await invite();
    const memberA = await registerMember(db, a.token, form(await uploadScan(a.invitation.id)), deps, null);
    await activateMember(db, officer, memberA.id);
    expect((await db.member.findUniqueOrThrow({ where: { id: memberA.id } })).status).toBe("ACTIVE");
    const role = await db.userModuleRole.findFirst({ where: { userId: memberA.userId, role: "MEMBER", revokedAt: null } });
    expect(role?.moduleCode).toBe("CREDIT");
    await expect(activateMember(db, officer, memberA.id)).rejects.toThrow(MemberError);

    const b = await invite();
    const memberB = await registerMember(db, b.token, form(await uploadScan(b.invitation.id)), deps, null);
    await expect(declineMember(db, officer, memberB.id, "no")).rejects.toThrow(/reason/);
    await declineMember(db, officer, memberB.id, "ID card number doesn't match the scan.");
    expect((await db.member.findUniqueOrThrow({ where: { id: memberB.id } })).status).toBe("DECLINED");

    const c = await invite();
    const memberC = await registerMember(db, c.token, form(await uploadScan(c.invitation.id)), deps, null);
    const selfReview = { id: memberC.userId, ipAddress: null };
    await expect(activateMember(db, selfReview, memberC.id)).rejects.toThrow(ForbiddenError);
  });
});
