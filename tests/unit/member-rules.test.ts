import { newInvitationToken } from "@/modules/credit/members/invitations";
import {
  invitationSchema,
  invitationState,
  isUsable,
  placeholderEmail,
  registrationSchema,
  type RegistrationInput,
} from "@/modules/credit/members/rules";
import { sha256Hex } from "@/lib/hash";

const day = 24 * 60 * 60 * 1000;
const now = new Date(Date.UTC(2026, 10, 3, 10));

describe("invitation state (PRD F5)", () => {
  const base = { expiresAt: new Date(now.getTime() + day), openedAt: null, registeredAt: null, revokedAt: null };

  it("moves from pending to opened to registered", () => {
    expect(invitationState(base, now)).toBe("pending");
    expect(invitationState({ ...base, openedAt: now }, now)).toBe("opened");
    expect(invitationState({ ...base, openedAt: now, registeredAt: now }, now)).toBe("registered");
  });

  it("expires after its date and can be revoked", () => {
    expect(invitationState({ ...base, expiresAt: now }, now)).toBe("expired");
    expect(invitationState({ ...base, revokedAt: now }, now)).toBe("revoked");
  });

  it("is usable only while pending or opened", () => {
    expect(isUsable("pending")).toBe(true);
    expect(isUsable("opened")).toBe(true);
    for (const s of ["registered", "expired", "revoked"] as const) expect(isUsable(s)).toBe(false);
  });

  it("stores only a hash of a long random token", () => {
    const { token, tokenHash } = newInvitationToken();
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
    expect(tokenHash).toBe(sha256Hex(token));
    expect(newInvitationToken().token).not.toBe(token);
  });
});

describe("invitation form", () => {
  it("normalises the phone and treats empty optionals as missing", () => {
    expect(invitationSchema.parse({ fullName: " Ada Obi ", phone: "0803 123 4567", email: "", remittanceSourceId: "" })).toEqual({
      fullName: "Ada Obi",
      phone: "+2348031234567",
      email: null,
      remittanceSourceId: null,
    });
  });

  it("rejects a bad phone or email", () => {
    expect(invitationSchema.safeParse({ fullName: "Ada Obi", phone: "12345", email: "", remittanceSourceId: "" }).success).toBe(false);
    expect(invitationSchema.safeParse({ fullName: "Ada Obi", phone: "08031234567", email: "nope", remittanceSourceId: "" }).success).toBe(false);
  });
});

describe("registration form", () => {
  const valid: RegistrationInput = {
    fullName: "Ada Obi",
    email: "",
    address: "12 Allen Avenue, Ikeja, Lagos",
    moaumIdNumber: " ma-00123 ",
    idScanEvidenceId: "0b5f3c1e-2a4d-4e6f-8a9b-1c2d3e4f5a6b",
    nextOfKinName: "Chidi Obi",
    nextOfKinPhone: "0701 000 0000",
    remittanceSourceId: "NONE",
    password: "Kesh-7Quv-Rimo",
    confirmPassword: "Kesh-7Quv-Rimo",
    consent: true,
  };

  it("accepts a complete form and normalises it", () => {
    const parsed = registrationSchema.parse(valid);
    expect(parsed.moaumIdNumber).toBe("MA-00123");
    expect(parsed.nextOfKinPhone).toBe("+2347010000000");
    expect(parsed.remittanceSourceId).toBeNull();
    expect(parsed.email).toBeNull();
  });

  it("requires consent, matching passwords and the ID scan", () => {
    const issues = (input: Partial<RegistrationInput>) => {
      const r = registrationSchema.safeParse({ ...valid, ...input });
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(issues({ consent: false as unknown as true })).toContain("You must accept the data protection notice to register.");
    expect(issues({ confirmPassword: "different-password" })).toContain("The two passwords don't match.");
    expect(issues({ idScanEvidenceId: "" })).toContain("Upload a scan or photo of your MOAUM ID card.");
    expect(issues({ password: "short", confirmPassword: "short" })).toContain("Use at least 10 characters.");
  });

  it("gives members without email a placeholder login address", () => {
    expect(placeholderEmail("+2348031234567")).toBe("2348031234567@members.dommus.invalid");
  });
});
