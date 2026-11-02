/** Portal roles (PRD §3). */
export const ROLES = [
  "MEMBER",
  "TREASURER",
  "FINANCE_MANAGER",
  "CASHIER",
  "LOAN_OFFICER",
  "MANAGEMENT",
  "AUDITOR",
  "ADMIN",
  "GMD",
  "SECRETARY",
] as const;

export type Role = (typeof ROLES)[number];

/** Every role except MEMBER is a staff role and needs two-factor login (PRD F1). */
export const STAFF_ROLES: readonly Role[] = ROLES.filter((r) => r !== "MEMBER");

export function isStaffRole(role: Role): boolean {
  return role !== "MEMBER";
}

/** Module codes. SHELL assignments apply across every module. */
export const MODULE_CODES = ["SHELL", "CREDIT"] as const;
export type ModuleCode = (typeof MODULE_CODES)[number];

export interface RoleAssignment {
  moduleCode: ModuleCode;
  role: Role;
}

/** Roles that hold portal-wide (SHELL) authority; the rest are Credit module roles. */
const SHELL_ROLES: readonly Role[] = ["ADMIN", "GMD", "AUDITOR", "SECRETARY", "MANAGEMENT"];

/** The module a role is assigned on. Management is portal-wide so it can approve financial settings. */
export function moduleForRole(role: Role): ModuleCode {
  return SHELL_ROLES.includes(role) ? "SHELL" : "CREDIT";
}

const BLOCKED_PAIRS: ReadonlyArray<readonly [Role, Role]> = [
  ["CASHIER", "FINANCE_MANAGER"],
  ["TREASURER", "FINANCE_MANAGER"],
  ["MANAGEMENT", "CASHIER"],
  ["MANAGEMENT", "LOAN_OFFICER"],
  ["SECRETARY", "LOAN_OFFICER"],
];

/** Roles that may not be combined with any other staff role. */
const EXCLUSIVE_ROLES: readonly Role[] = ["GMD", "ADMIN"];

/**
 * Returns the reasons a set of roles is not allowed (PRD §3 blocked
 * combinations). MEMBER is not a staff role and never conflicts; the
 * self-dealing rule covers staff who are also members.
 */
export function roleCombinationViolations(roles: Iterable<Role>): string[] {
  const staff = [...new Set(roles)].filter(isStaffRole);
  const violations: string[] = [];
  for (const [a, b] of BLOCKED_PAIRS) {
    if (staff.includes(a) && staff.includes(b)) violations.push(`${a} + ${b} is a blocked combination`);
  }
  for (const role of EXCLUSIVE_ROLES) {
    if (staff.includes(role) && staff.length > 1) {
      violations.push(`${role} cannot be combined with any other role`);
    }
  }
  return violations;
}
