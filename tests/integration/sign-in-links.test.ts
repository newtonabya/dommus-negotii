/**
 * Sign-in links a Loan Officer hands to a member who can't get an SMS code.
 * Skipped when TEST_DATABASE_URL is not set.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { MemberError } from "@/modules/credit/members/invitations";
import { CONSENT_VERSION } from "@/modules/credit/members/rules";
import { issueSignInLink, redeemSignInLink, SIGN_IN_LINK_TTL_MS, signInLinkDetails, type SignInLinkDeps } from "@/modules/credit/members/sign-in-links";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(90_000);

const phone = () => `+23481${String(randomInt(0, 1e8)).padStart(8, "0")}`;

describeDb("member sign-in links", () => {
  let db: PrismaClient;
  const officer = { id: `lo-${randomUUID()}`, ipAddress: "127.0.0.1" };
  const deps: SignInLinkDeps = {
    hashPassword: async (p) => `test-hash:${sha256Hex(p)}`,
    isPasswordCompromised: async () => false,
    newId: () => randomBytes(16).toString("hex"),
  };
  const good = { password: "a-long-password-1", confirmPassword: "a-long-password-1" };

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
  });
  afterAll(async () => db?.$disconnect());

  /** A member with a login; `password` gives them an existing credential account. */
  async function makeMember(opts: { status?: "ACTIVE" | "PENDING" | "EXITED"; password?: boolean; consent?: boolean; invitation?: boolean } = {}) {
    const userId = `u-${randomUUID()}`;
    const ph = phone();
    await db.user.create({ data: { id: userId, name: "Ada Test Member", email: `${userId}@members.dommus.invalid`, phoneNumber: ph, phoneNumberVerified: false } });
    if (opts.password) {
      await db.account.create({ data: { id: randomUUID(), userId, providerId: "credential", accountId: userId, password: "old-hash" } });
      await db.session.create({ data: { id: randomUUID(), userId, token: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) } });
    }
    let invitationId: string | undefined;
    if (opts.invitation) {
      const inv = await db.invitation.create({
        data: { type: "ACTIVATION", fullName: "Ada Test Member", phone: ph, tokenHash: sha256Hex(randomUUID()), sentById: officer.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) },
      });
      invitationId = inv.id;
    }
    const memberNo = `T-${randomUUID()}`;
    const member = await db.member.create({
      data: {
        memberNo,
        moaumIdNumber: memberNo,
        userId,
        fullName: "Ada Test Member",
        phone: ph,
        address: "",
        nextOfKinName: "",
        nextOfKinPhone: "",
        status: opts.status ?? "ACTIVE",
        consentAt: opts.consent ? new Date() : null,
        consentVersion: opts.consent ? CONSENT_VERSION : null,
        invitationId,
      },
    });
    return { member, userId };
  }

  it("lets a never-activated member set a password once, with the notice, and closes their activation link", async () => {
    const { member, userId } = await makeMember({ invitation: true });
    const link = await issueSignInLink(db, officer, member.id);
    expect(link.firstTime).toBe(true);
    expect(link.path).toBe(`/access/${link.token}`);
    expect((await signInLinkDetails(db, link.token)).needsConsent).toBe(true);

    await expect(redeemSignInLink(db, link.token, good, deps, null)).rejects.toThrow("data protection notice");
    const result = await redeemSignInLink(db, link.token, { ...good, consent: true }, deps, "10.0.0.1");
    expect(result.firstTime).toBe(true);

    const account = await db.account.findFirst({ where: { userId, providerId: "credential" } });
    expect(account?.password).toBe(`test-hash:${sha256Hex(good.password)}`);
    expect((await db.user.findUnique({ where: { id: userId } }))?.phoneNumberVerified).toBe(true);
    const after = await db.member.findUnique({ where: { id: member.id } });
    expect(after?.consentVersion).toBe(CONSENT_VERSION);
    expect((await db.invitation.findUnique({ where: { id: member.invitationId as string } }))?.registeredAt).not.toBeNull();

    // Single use.
    await expect(redeemSignInLink(db, link.token, { ...good, consent: true }, deps, null)).rejects.toThrow(MemberError);
    const audit = await db.auditLog.findMany({ where: { entityId: member.id, action: { startsWith: "member.signin_link." } }, orderBy: { occurredAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["member.signin_link.issued", "member.signin_link.used"]);
    expect(audit[0]?.userId).toBe(officer.id);
  });

  it("replaces a forgotten password and signs the member out everywhere", async () => {
    const { member, userId } = await makeMember({ password: true, consent: true });
    const link = await issueSignInLink(db, officer, member.id);
    expect(link.firstTime).toBe(false);
    expect((await signInLinkDetails(db, link.token)).needsConsent).toBe(false);
    expect((await redeemSignInLink(db, link.token, good, deps, null)).firstTime).toBe(false);
    expect((await db.account.findFirst({ where: { userId } }))?.password).toBe(`test-hash:${sha256Hex(good.password)}`);
    expect(await db.session.count({ where: { userId } })).toBe(0);
  });

  it("cancels the earlier link when a new one is made", async () => {
    const { member } = await makeMember({ consent: true });
    const first = await issueSignInLink(db, officer, member.id);
    const second = await issueSignInLink(db, officer, member.id);
    await expect(signInLinkDetails(db, first.token)).rejects.toThrow("expired or was already used");
    await expect(signInLinkDetails(db, second.token)).resolves.toMatchObject({ fullName: "Ada Test Member" });
  });

  it("expires after 30 minutes", async () => {
    const { member } = await makeMember({ consent: true });
    const issuedAt = new Date();
    const link = await issueSignInLink(db, officer, member.id, issuedAt);
    const later = new Date(issuedAt.getTime() + SIGN_IN_LINK_TTL_MS + 1_000);
    await expect(signInLinkDetails(db, link.token, later)).rejects.toThrow("expired");
    await expect(redeemSignInLink(db, link.token, good, deps, null, later)).rejects.toThrow("expired");
  });

  it("refuses the officer's own membership, closed memberships, and bad passwords", async () => {
    const own = await makeMember();
    await expect(issueSignInLink(db, { id: own.userId, ipAddress: null }, own.member.id)).rejects.toThrow("your own membership");
    const exited = await makeMember({ status: "EXITED" });
    await expect(issueSignInLink(db, officer, exited.member.id)).rejects.toThrow("exited");

    const { member } = await makeMember({ consent: true });
    const link = await issueSignInLink(db, officer, member.id);
    await expect(redeemSignInLink(db, link.token, { password: "short", confirmPassword: "short" }, deps, null)).rejects.toThrow("at least 10");
    await expect(redeemSignInLink(db, link.token, { ...good, confirmPassword: "something-else" }, deps, null)).rejects.toThrow("don't match");
    await expect(
      redeemSignInLink(db, link.token, good, { ...deps, isPasswordCompromised: async () => true }, null),
    ).rejects.toThrow("data breach");
    // A refused attempt doesn't use the link up.
    await expect(redeemSignInLink(db, link.token, good, deps, null)).resolves.toEqual({ firstTime: true });
  });

  it("stores only a hash of the token", async () => {
    const { member } = await makeMember({ consent: true });
    const link = await issueSignInLink(db, officer, member.id);
    const rows = await db.verification.findMany({ where: { value: { contains: member.id } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identifier).toBe(`member-signin:${sha256Hex(link.token)}`);
    expect(JSON.stringify(rows[0])).not.toContain(link.token);
  });
});
