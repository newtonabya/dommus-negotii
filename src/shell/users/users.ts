import { generateRandomString } from "better-auth/crypto";
import { z } from "zod";
import type { Role as DbRole } from "@/generated/prisma/client";
import { getDb, TX_OPTIONS, type Db } from "@/lib/db";
import { writeAudit } from "@/shell/audit/audit";
import { auth } from "@/shell/auth/auth";
import type { CurrentUser } from "@/shell/auth/session";
import { normalizeEmail } from "@/shell/auth/security";
import { moduleForRole, ROLES, roleCombinationViolations, type Role } from "@/shell/rbac/roles";

export class UserAdminError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "UserAdminError";
  }
}

/** Staff roles an Admin may assign here. MEMBER comes only through member onboarding. */
export const ASSIGNABLE_ROLES = ROLES.filter((r) => r !== "MEMBER");

export const createStaffSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().transform(normalizeEmail),
});

export const roleSchema = z.enum(ASSIGNABLE_ROLES as unknown as [Role, ...Role[]]);

/**
 * Creates a staff login with no password and emails a "set your password" link
 * (valid 1 hour), so the Admin never knows anyone's password.
 */
export async function createStaffUser(actor: CurrentUser, input: z.input<typeof createStaffSchema>) {
  const { name, email } = createStaffSchema.parse(input);
  const db = getDb();
  if (await db.user.findUnique({ where: { email } })) throw new UserAdminError("A user with this email already exists.");

  // No password account yet: Better Auth creates it when they use the reset link.
  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { id: generateRandomString(32, "a-z", "A-Z", "0-9"), name, email, emailVerified: false },
    });
    await writeAudit(tx, {
      action: "user.create",
      entityType: "User",
      entityId: created.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      after: { name, email },
    });
    return created;
  }, TX_OPTIONS);
  await sendPasswordLink(email);
  return user;
}

export async function sendPasswordLink(email: string): Promise<void> {
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  await auth.api.requestPasswordReset({ body: { email, redirectTo: `${base}/reset-password` } });
}

async function activeRoles(db: Db, userId: string): Promise<Role[]> {
  const rows = await db.userModuleRole.findMany({ where: { userId, revokedAt: null }, select: { role: true } });
  return rows.map((r) => r.role as Role);
}

/** Assigns a role, refusing blocked combinations (PRD §3). Re-assigning a revoked role restores it. */
export async function assignRole(actor: CurrentUser, userId: string, roleInput: string) {
  const role = roleSchema.parse(roleInput);
  const db = getDb();
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new UserAdminError("User not found.");
  if (user.deactivatedAt) throw new UserAdminError("Reactivate the user before assigning roles.");

  const current = await activeRoles(db, userId);
  if (current.includes(role)) throw new UserAdminError(`${role} is already assigned.`);
  const violations = roleCombinationViolations([...current, role]);
  if (violations.length > 0) throw new UserAdminError(violations.join("; "));

  const moduleCode = moduleForRole(role);
  const row = await db.userModuleRole.upsert({
    where: { userId_moduleCode_role: { userId, moduleCode, role: role as DbRole } },
    create: { userId, moduleCode, role: role as DbRole, assignedById: actor.id },
    update: { revokedAt: null, assignedById: actor.id, assignedAt: new Date() },
  });
  await writeAudit(db, {
    action: "user.role.assign",
    entityType: "User",
    entityId: userId,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    before: { roles: current },
    after: { roles: [...current, role], moduleCode },
  });
  return row;
}

export async function revokeRole(actor: CurrentUser, userId: string, roleInput: string) {
  const role = roleSchema.parse(roleInput);
  const db = getDb();
  if (userId === actor.id && role === "ADMIN") throw new UserAdminError("You cannot remove your own Admin role.");
  const current = await activeRoles(db, userId);
  if (!current.includes(role)) throw new UserAdminError(`${role} is not assigned.`);
  await db.userModuleRole.update({
    where: { userId_moduleCode_role: { userId, moduleCode: moduleForRole(role), role: role as DbRole } },
    data: { revokedAt: new Date() },
  });
  await writeAudit(db, {
    action: "user.role.revoke",
    entityType: "User",
    entityId: userId,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    before: { roles: current },
    after: { roles: current.filter((r) => r !== role) },
  });
}

/** Deactivates a user and ends all their sessions at once (PRD F1). */
export async function deactivateUser(actor: CurrentUser, userId: string, reason: string) {
  if (userId === actor.id) throw new UserAdminError("You cannot deactivate yourself.");
  if (reason.trim().length < 3) throw new UserAdminError("Give a reason.");
  const db = getDb();
  const now = new Date();
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { deactivatedAt: now } }),
    db.session.deleteMany({ where: { userId } }),
  ], TX_OPTIONS);
  await writeAudit(db, {
    action: "user.deactivate",
    entityType: "User",
    entityId: userId,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    after: { deactivatedAt: now, reason: reason.trim() },
  });
}

export async function reactivateUser(actor: CurrentUser, userId: string) {
  const db = getDb();
  await db.user.update({ where: { id: userId }, data: { deactivatedAt: null } });
  await writeAudit(db, { action: "user.reactivate", entityType: "User", entityId: userId, userId: actor.id, ipAddress: actor.ipAddress });
}

/** True once any active Admin exists; first-run /setup is then closed for good. */
export async function adminExists(): Promise<boolean> {
  return (await getDb().userModuleRole.count({ where: { role: "ADMIN", revokedAt: null } })) > 0;
}

export async function listUsers() {
  return getDb().user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      phoneNumber: true,
      twoFactorEnabled: true,
      deactivatedAt: true,
      createdAt: true,
      roles: { where: { revokedAt: null }, select: { role: true, moduleCode: true } },
    },
  });
}
