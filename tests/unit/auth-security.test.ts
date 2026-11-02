import {
  clientIp,
  describeDevice,
  deviceFingerprint,
  idleLimitMinutes,
  isIdle,
  lockoutState,
  normalizeEmail,
  normalizeNigerianPhone,
} from "@/shell/auth/security";
import { hasPermission } from "@/shell/rbac/permissions";
import { moduleForRole, STAFF_ROLES } from "@/shell/rbac/roles";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 2, 9, minute));

describe("lockout (PRD F1: 5 failures → 15 minutes)", () => {
  const now = at(30);

  it("stays open below 5 recent failures", () => {
    expect(lockoutState([at(20), at(21), at(22), at(23)], null, now).locked).toBe(false);
  });

  it("locks after 5 failures, until 15 minutes after the last one", () => {
    const state = lockoutState([at(20), at(21), at(22), at(23), at(24)], null, now);
    expect(state).toEqual({ locked: true, until: at(39) });
  });

  it("ignores failures older than 15 minutes", () => {
    expect(lockoutState([at(10), at(11), at(12), at(13), at(14)], null, now).locked).toBe(false);
  });

  it("resets after a successful password check", () => {
    const failures = [at(20), at(21), at(22), at(23), at(24)];
    expect(lockoutState(failures, at(25), now).locked).toBe(false);
    expect(lockoutState(failures, at(22), now).locked).toBe(false);
  });
});

describe("idle timeouts", () => {
  it("uses 30 minutes for staff and 60 for members", () => {
    expect(idleLimitMinutes(true)).toBe(30);
    expect(idleLimitMinutes(false)).toBe(60);
  });

  it("is idle only past the limit", () => {
    expect(isIdle(at(0), at(30), 30)).toBe(false);
    expect(isIdle(at(0), new Date(at(30).getTime() + 1), 30)).toBe(true);
  });
});

describe("request details", () => {
  it("takes the first x-forwarded-for address", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "102.89.1.2, 10.0.0.1" }))).toBe("102.89.1.2");
    expect(clientIp(new Headers({ "x-real-ip": "41.58.3.4" }))).toBe("41.58.3.4");
    expect(clientIp(new Headers())).toBeNull();
    expect(clientIp(null)).toBeNull();
  });

  it("fingerprints devices without storing the user agent", () => {
    const fp = deviceFingerprint("Mozilla/5.0 Chrome/140");
    expect(fp).toHaveLength(32);
    expect(fp).toBe(deviceFingerprint("  mozilla/5.0 chrome/140 "));
    expect(fp).not.toContain("Chrome");
  });

  it("describes common devices", () => {
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/140 Safari/537")).toBe("Chrome on Windows");
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14) Chrome/140 Mobile Safari")).toBe("Chrome on Android");
    expect(describeDevice(null)).toBe("a browser on an unknown device");
  });
});

describe("identifiers", () => {
  it("normalises emails", () => {
    expect(normalizeEmail("  Ada@MOAUM.ng ")).toBe("ada@moaum.ng");
  });

  it("normalises Nigerian mobile numbers to E.164", () => {
    expect(normalizeNigerianPhone("0803 123 4567")).toBe("+2348031234567");
    expect(normalizeNigerianPhone("2348031234567")).toBe("+2348031234567");
    expect(normalizeNigerianPhone("+234 (0)803-123-4567")).toBeNull();
    expect(normalizeNigerianPhone("+234 803 123 4567")).toBe("+2348031234567");
    expect(normalizeNigerianPhone("0701 000 0000")).toBe("+2347010000000");
  });

  it("rejects non-mobile or malformed numbers", () => {
    for (const bad of ["01 234 5678", "0603 123 4567", "080312345", "+44 7700 900123", "abc"]) {
      expect(normalizeNigerianPhone(bad)).toBeNull();
    }
  });
});

describe("role modules", () => {
  it("puts portal-wide roles on SHELL and Credit roles on CREDIT", () => {
    expect(moduleForRole("ADMIN")).toBe("SHELL");
    expect(moduleForRole("SECRETARY")).toBe("SHELL");
    expect(moduleForRole("TREASURER")).toBe("CREDIT");
    expect(moduleForRole("LOAN_OFFICER")).toBe("CREDIT");
  });

  it("gives every staff role, at its default module, the permissions the PRD expects", () => {
    const grant = (role: (typeof STAFF_ROLES)[number], action: Parameters<typeof hasPermission>[1]) =>
      hasPermission([{ role, moduleCode: moduleForRole(role) }], action);
    expect(grant("MANAGEMENT", "settings.financial.approve")).toBe(true);
    expect(grant("MANAGEMENT", "loan.approve")).toBe(true);
    expect(grant("SECRETARY", "invitation.send")).toBe(true);
    expect(grant("GMD", "exception.close")).toBe(true);
    expect(grant("ADMIN", "users.manage")).toBe(true);
    expect(grant("CASHIER", "users.manage")).toBe(false);
    expect(grant("TREASURER", "schedule.commit")).toBe(true);
  });
});
