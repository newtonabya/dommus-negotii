/**
 * Member profile change requests and the NDPA data copy against the test
 * database (PRD F5 DoD). Skipped when TEST_DATABASE_URL is not set.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { createClient } from "@/lib/db";
import { beginUpload, finishUpload } from "@/evidence/service";
import { LocalEvidenceStore } from "@/evidence/store";
import { collectPersonalData, personalDataPdf } from "@/modules/credit/members/data-copy";
import { sendPhoneChangeCode } from "@/modules/credit/members/phone-change";
import {
  approveProfileChange,
  rejectProfileChange,
  requestProfileChange,
  withdrawProfileChange,
} from "@/modules/credit/members/profile-changes";
import { placeholderEmail } from "@/modules/credit/members/rules";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;
jest.setTimeout(120_000);

const phone = () => `+23480${String(randomInt(0, 1e8)).padStart(8, "0")}`;
const local = (e164: string) => `0${e164.slice(4)}`;

describeDb("member profile changes and data copy", () => {
  let db: PrismaClient;
  let dir: string;
  let store: LocalEvidenceStore;
  const officer = { id: `lo-${randomUUID()}`, ipAddress: "127.0.0.1" };
  const smsTexts: string[] = [];

  /** An ACTIVE member with a login, created directly. */
  async function newMember() {
    const userId = randomBytes(16).toString("hex");
    const p = phone();
    await db.user.create({ data: { id: userId, name: "Ngozi Eze", email: placeholderEmail(p), phoneNumber: p, phoneNumberVerified: true } });
    const member = await db.member.create({
      data: {
        userId,
        fullName: "Ngozi Eze",
        phone: p,
        address: "3 Marina Road, Lagos Island",
        moaumIdNumber: `MA-${randomInt(1e6, 9e6)}`,
        nextOfKinName: "Obi Eze",
        nextOfKinPhone: "+2347010000000",
        status: "ACTIVE",
      },
    });
    return { actor: { id: userId, ipAddress: "127.0.0.1" }, member };
  }

  async function upload(userId: string, name = "affidavit.pdf") {
    const actor = { id: userId, ipAddress: null };
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, ...randomBytes(64)]); // %PDF-
    const begun = await beginUpload(db, store, actor, { filename: name, size: bytes.length });
    await store.putFile(`staging/${begun.uploadId}`, bytes);
    return (await finishUpload(db, store, actor, begun.uploadId)).evidenceId;
  }

  const values = (m: { fullName: string; phone: string; address: string; moaumIdNumber: string }, over: Record<string, string> = {}) => ({
    fullName: m.fullName,
    phone: local(m.phone),
    email: "",
    address: m.address,
    moaumIdNumber: m.moaumIdNumber,
    nextOfKinName: "Obi Eze",
    nextOfKinPhone: "07010000000",
    remittanceSourceId: "",
    ...over,
  });

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
    dir = await mkdtemp(path.join(tmpdir(), "profile-"));
    store = new LocalEvidenceStore(dir, "test-secret");
    jest.spyOn(console, "info").mockImplementation((text: unknown) => {
      smsTexts.push(String(text));
    });
  });

  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it("records only changed fields, one open request at a time, until approved", async () => {
    const { actor, member } = await newMember();
    await expect(requestProfileChange(db, actor, { values: values(member) })).rejects.toThrow(/Nothing has changed/);

    const request = await requestProfileChange(db, actor, { values: values(member, { address: "14 Allen Avenue, Ikeja, Lagos" }) });
    expect(request.changes).toEqual({ address: "14 Allen Avenue, Ikeja, Lagos" });
    expect(request.before).toEqual({ address: "3 Marina Road, Lagos Island" });
    expect((await db.member.findUniqueOrThrow({ where: { id: member.id } })).address).toBe("3 Marina Road, Lagos Island");

    await expect(requestProfileChange(db, actor, { values: values(member, { address: "Somewhere else entirely" }) })).rejects.toThrow(
      /already have a request/,
    );
    await withdrawProfileChange(db, actor, request.id);
    await expect(approveProfileChange(db, officer, request.id)).rejects.toThrow(/already withdrawn/);
  });

  it("needs a supporting document for a new name, and updates member and login on approval", async () => {
    const { actor, member } = await newMember();
    await expect(requestProfileChange(db, actor, { values: values(member, { fullName: "Ngozi Adaeze Eze" }) })).rejects.toThrow(
      /supporting document/,
    );
    const evidenceId = await upload(actor.id);
    const request = await requestProfileChange(db, actor, { values: values(member, { fullName: "Ngozi Adaeze Eze" }), evidenceId });

    await expect(approveProfileChange(db, actor, request.id)).rejects.toThrow(/your own membership/);
    await approveProfileChange(db, officer, request.id, "Affidavit checked");
    expect((await db.member.findUniqueOrThrow({ where: { id: member.id } })).fullName).toBe("Ngozi Adaeze Eze");
    expect((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).name).toBe("Ngozi Adaeze Eze");
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "member.profile_change.approved", entityId: member.id } });
    expect(audit.before).toEqual({ fullName: "Ngozi Eze" });
    expect(audit.evidenceRef).toBe(evidenceId);
  });

  it("confirms a new phone by SMS code before the request, and moves the login with it", async () => {
    const { actor, member } = await newMember();
    const newPhone = phone();
    await expect(requestProfileChange(db, actor, { values: values(member, { phone: local(newPhone) }) })).rejects.toThrow(/code we texted/);

    await sendPhoneChangeCode(db, actor, newPhone);
    const code = /code to confirm this number is (\d{6})/.exec(smsTexts.join("\n"))?.[1];
    expect(code).toBeDefined();
    await expect(
      requestProfileChange(db, actor, { values: values(member, { phone: local(newPhone) }), phoneCode: "000000" === code ? "111111" : "000000" }),
    ).rejects.toThrow(/code we texted/);
    const request = await requestProfileChange(db, actor, { values: values(member, { phone: local(newPhone) }), phoneCode: code });
    expect(request.phoneVerifiedAt).not.toBeNull();

    await expect(rejectProfileChange(db, officer, request.id, "no")).rejects.toThrow(/Say why/);
    await approveProfileChange(db, officer, request.id);
    const user = await db.user.findUniqueOrThrow({ where: { id: actor.id } });
    expect(user).toMatchObject({ phoneNumber: newPhone, phoneNumberVerified: true, email: placeholderEmail(newPhone) });
    expect((await db.member.findUniqueOrThrow({ where: { id: member.id } })).phone).toBe(newPhone);
  });

  it("gives the member a copy of their data as JSON and PDF", async () => {
    const { actor, member } = await newMember();
    const request = await requestProfileChange(db, actor, { values: values(member, { nextOfKinName: "Chidi Eze" }) });
    await rejectProfileChange(db, officer, request.id, "Please call the office first");

    const data = await collectPersonalData(db, actor.id);
    expect(data?.member).toMatchObject({ fullName: "Ngozi Eze", moaumIdNumber: member.moaumIdNumber, status: "ACTIVE" });
    expect(data?.login.email).toBeNull(); // placeholder login emails are not personal data
    expect(data?.profileChangeRequests).toEqual([
      expect.objectContaining({ status: "REJECTED", decisionNote: "Please call the office first", changes: [{ field: "Next of kin", value: "Chidi Eze" }] }),
    ]);
    const pdf = await personalDataPdf(data!);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
  });
});
