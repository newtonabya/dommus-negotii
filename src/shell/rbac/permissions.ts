import type { ModuleCode, Role, RoleAssignment } from "./roles";

interface Permission {
  module: ModuleCode;
  roles: readonly Role[];
}

const p = (module: ModuleCode, ...roles: Role[]): Permission => ({ module, roles });

/**
 * The permissions matrix (PRD §3). Every server action names one of these
 * actions and is checked at the API layer, never only in the UI.
 * Member actions on their own records also need an ownership check.
 */
export const PERMISSIONS = {
  // Portal shell
  "users.manage": p("SHELL", "ADMIN"),
  "modules.manage": p("SHELL", "ADMIN"),
  "settings.change": p("SHELL", "ADMIN"),
  "settings.financial.propose": p("SHELL", "ADMIN"),
  "settings.financial.approve": p("SHELL", "MANAGEMENT"),
  "audit.read": p("SHELL", "AUDITOR"),
  "announcement.send": p("SHELL", "GMD", "SECRETARY"),
  "dashboard.gmd.read": p("SHELL", "GMD", "AUDITOR"),

  // Members and invitations (F5)
  "invitation.send": p("CREDIT", "ADMIN", "GMD", "SECRETARY"),
  "invitation.read": p("CREDIT", "ADMIN", "GMD", "SECRETARY", "AUDITOR"),
  "member.directory.read": p("CREDIT", "SECRETARY", "LOAN_OFFICER", "GMD", "AUDITOR"),
  "member.kyc.read": p("CREDIT", "LOAN_OFFICER", "MANAGEMENT", "AUDITOR"),
  "member.import.upload": p("CREDIT", "ADMIN"),
  "member.activate": p("CREDIT", "LOAN_OFFICER"),
  "member.profileChange.approve": p("CREDIT", "LOAN_OFFICER"),

  // Member self-service (own records only)
  "self.loan.apply": p("CREDIT", "MEMBER"),
  "self.profileChange.request": p("CREDIT", "MEMBER"),
  "self.refund.request": p("CREDIT", "MEMBER"),
  "self.read": p("CREDIT", "MEMBER"),

  // Loan workflow (F7)
  "loan.application.captureAssisted": p("CREDIT", "LOAN_OFFICER"),
  "loan.verify": p("CREDIT", "LOAN_OFFICER"),
  "loan.recommend": p("CREDIT", "LOAN_OFFICER"),
  "loan.decline": p("CREDIT", "LOAN_OFFICER"),
  "loan.approve": p("CREDIT", "MANAGEMENT"),
  "loan.reject": p("CREDIT", "MANAGEMENT"),
  "loan.cancelApproved": p("CREDIT", "MANAGEMENT"),
  "voucher.disbursement.prepare": p("CREDIT", "CASHIER"),
  "voucher.disbursement.verify": p("CREDIT", "FINANCE_MANAGER"),
  "payoffQuote.issue": p("CREDIT", "MEMBER", "LOAN_OFFICER", "TREASURER", "FINANCE_MANAGER", "MANAGEMENT"),

  // Imports (F8, F10)
  "legacyImport.upload": p("CREDIT", "ADMIN"),
  "legacyImport.commit": p("CREDIT", "FINANCE_MANAGER"),
  "bankOpening.upload": p("CREDIT", "ADMIN"),
  "bankOpening.commit": p("CREDIT", "FINANCE_MANAGER"),

  // Track A (F9)
  "sourceAdvice.upload": p("CREDIT", "FINANCE_MANAGER"),
  "schedule.upload": p("CREDIT", "TREASURER"),
  "schedule.commit": p("CREDIT", "TREASURER"),
  "correction.prepare": p("CREDIT", "TREASURER"),
  "correction.verify": p("CREDIT", "FINANCE_MANAGER"),
  "reclassification.prepare": p("CREDIT", "TREASURER"),
  "reclassification.verify": p("CREDIT", "FINANCE_MANAGER"),

  // Track B (F10)
  "bankStatement.upload": p("CREDIT", "FINANCE_MANAGER"),
  "bankCredit.tagMember": p("CREDIT", "FINANCE_MANAGER"),
  "lodgement.verify": p("CREDIT", "FINANCE_MANAGER"),
  "lodgement.record": p("CREDIT", "CASHIER"),
  "bankLineEntry.record": p("CREDIT", "CASHIER"),
  "bankLineEntry.verify": p("CREDIT", "FINANCE_MANAGER"),

  // Reconciliation (F11)
  "reconciliation.run": p("CREDIT", "FINANCE_MANAGER"),
  "exception.review": p("CREDIT", "FINANCE_MANAGER"),
  "exception.close": p("CREDIT", "GMD"),
  "month.close": p("CREDIT", "FINANCE_MANAGER"),

  // Refunds (F12)
  "refund.captureRequest": p("CREDIT", "LOAN_OFFICER"),
  "refund.approve": p("CREDIT", "MANAGEMENT"),
  "voucher.refund.prepare": p("CREDIT", "CASHIER"),
  "voucher.refund.verify": p("CREDIT", "FINANCE_MANAGER"),

  // Reading (F13, F14)
  "credit.read": p(
    "CREDIT",
    "TREASURER",
    "FINANCE_MANAGER",
    "CASHIER",
    "LOAN_OFFICER",
    "MANAGEMENT",
    "GMD",
    "AUDITOR",
  ),
  "reports.read": p("CREDIT", "TREASURER", "FINANCE_MANAGER", "MANAGEMENT", "GMD", "AUDITOR"),
  "ledger.export": p("SHELL", "AUDITOR"),
} as const satisfies Record<string, Permission>;

export type Action = keyof typeof PERMISSIONS;

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** True if any assignment grants the action. SHELL assignments count for every module. */
export function hasPermission(assignments: readonly RoleAssignment[], action: Action): boolean {
  const permission: Permission = PERMISSIONS[action];
  return assignments.some(
    (a) =>
      permission.roles.includes(a.role) &&
      (a.moduleCode === permission.module || a.moduleCode === "SHELL"),
  );
}

export function assertPermission(assignments: readonly RoleAssignment[], action: Action): void {
  if (!hasPermission(assignments, action)) {
    throw new ForbiddenError(`Not permitted: ${action}`);
  }
}

/**
 * No self-dealing (PRD §3): a staff user linked to a member record cannot act
 * on that member's own records.
 */
export function assertNotSelfDealing(actorMemberId: string | null, subjectMemberId: string): void {
  if (actorMemberId !== null && actorMemberId === subjectMemberId) {
    throw new ForbiddenError("Staff cannot act on their own member record");
  }
}
