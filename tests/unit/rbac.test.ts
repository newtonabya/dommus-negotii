import {
  assertNotSelfDealing,
  assertPermission,
  ForbiddenError,
  hasPermission,
  PERMISSIONS,
  type Action,
} from "@/shell/rbac/permissions";
import { roleCombinationViolations, STAFF_ROLES, type Role, type RoleAssignment } from "@/shell/rbac/roles";

const as = (role: Role, moduleCode: RoleAssignment["moduleCode"] = "CREDIT"): RoleAssignment[] => [
  { moduleCode, role },
];

describe("permissions", () => {
  it("returns 403 when a Cashier calls a Finance-only action (PRD F1)", () => {
    expect(() => assertPermission(as("CASHIER"), "lodgement.verify")).toThrow(ForbiddenError);
    try {
      assertPermission(as("CASHIER"), "lodgement.verify");
    } catch (error) {
      expect((error as ForbiddenError).status).toBe(403);
    }
  });

  it("lets only Admin, GMD and Secretary send invitations (AT-q)", () => {
    const allowed = STAFF_ROLES.concat("MEMBER").filter((r) =>
      hasPermission(as(r, r === "GMD" || r === "ADMIN" ? "SHELL" : "CREDIT"), "invitation.send"),
    );
    expect(allowed.sort()).toEqual(["ADMIN", "GMD", "SECRETARY"]);
  });

  it("lets only the GMD close exceptions", () => {
    const allowed = STAFF_ROLES.filter((r) => hasPermission(as(r, "SHELL"), "exception.close"));
    expect(allowed).toEqual(["GMD"]);
  });

  it("gives the Auditor no write actions", () => {
    const readOnly = new Set<Action>([
      "audit.read",
      "dashboard.gmd.read",
      "invitation.read",
      "member.directory.read",
      "member.kyc.read",
      "credit.read",
      "reports.read",
      "ledger.export",
    ]);
    const auditorActions = (Object.keys(PERMISSIONS) as Action[]).filter((a) =>
      hasPermission(as("AUDITOR", "SHELL"), a),
    );
    expect(auditorActions.every((a) => readOnly.has(a))).toBe(true);
  });

  it("never lets one role both prepare and verify the same voucher", () => {
    const pairs: Array<[Action, Action]> = [
      ["voucher.disbursement.prepare", "voucher.disbursement.verify"],
      ["voucher.refund.prepare", "voucher.refund.verify"],
      ["bankLineEntry.record", "bankLineEntry.verify"],
      ["correction.prepare", "correction.verify"],
      ["legacyImport.upload", "legacyImport.commit"],
    ];
    for (const [make, check] of pairs) {
      const overlap = PERMISSIONS[make].roles.filter((r: Role) =>
        (PERMISSIONS[check].roles as readonly Role[]).includes(r),
      );
      expect(overlap).toEqual([]);
    }
  });

  it("does not let a CREDIT role act on SHELL actions", () => {
    expect(hasPermission(as("MANAGEMENT", "CREDIT"), "settings.financial.approve")).toBe(false);
    expect(hasPermission(as("MANAGEMENT", "SHELL"), "settings.financial.approve")).toBe(true);
  });
});

describe("blocked role combinations (PRD §3)", () => {
  it.each<[Role, Role]>([
    ["CASHIER", "FINANCE_MANAGER"],
    ["TREASURER", "FINANCE_MANAGER"],
    ["MANAGEMENT", "CASHIER"],
    ["MANAGEMENT", "LOAN_OFFICER"],
    ["SECRETARY", "LOAN_OFFICER"],
    ["GMD", "AUDITOR"],
    ["ADMIN", "SECRETARY"],
  ])("rejects %s + %s", (a, b) => {
    expect(roleCombinationViolations([a, b])).not.toEqual([]);
  });

  it("allows permitted combinations and members", () => {
    expect(roleCombinationViolations(["TREASURER", "CASHIER"])).toEqual([]);
    expect(roleCombinationViolations(["GMD", "MEMBER"])).toEqual([]);
    expect(roleCombinationViolations(["LOAN_OFFICER"])).toEqual([]);
  });
});

describe("self-dealing", () => {
  it("blocks staff acting on their own member record", () => {
    expect(() => assertNotSelfDealing("m-1", "m-1")).toThrow(ForbiddenError);
    expect(() => assertNotSelfDealing("m-1", "m-2")).not.toThrow();
    expect(() => assertNotSelfDealing(null, "m-2")).not.toThrow();
  });
});
