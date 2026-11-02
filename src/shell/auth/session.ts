import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/shell/audit/audit";
import { assertPermission, ForbiddenError, hasPermission, type Action } from "@/shell/rbac/permissions";
import { isStaffRole, type RoleAssignment } from "@/shell/rbac/roles";
import { auth } from "./auth";
import { clientIp, idleLimitMinutes, isIdle } from "./security";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  phoneNumber: string | null;
  twoFactorEnabled: boolean;
  assignments: RoleAssignment[];
  isStaff: boolean;
  sessionId: string;
  ipAddress: string | null;
}

export type SessionProblem = "signed-out" | "idle" | "deactivated";

/**
 * Reads the session without refreshing it, so `updatedAt` still shows the last
 * real activity, then applies deactivation and the idle limits (PRD F1).
 * Activity is refreshed only by <SessionActivity /> on user input.
 */
export async function loadCurrentUser(): Promise<{ user: CurrentUser } | { problem: SessionProblem }> {
  const requestHeaders = await headers();
  const result = await auth.api.getSession({ headers: requestHeaders, query: { disableRefresh: true } });
  if (!result) return { problem: "signed-out" };

  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: result.user.id },
    include: { roles: { where: { revokedAt: null }, select: { moduleCode: true, role: true } } },
  });
  if (!user) return { problem: "signed-out" };

  const assignments = user.roles as RoleAssignment[];
  const isStaff = assignments.some((a) => isStaffRole(a.role));
  const ip = clientIp(requestHeaders);

  if (user.deactivatedAt) {
    await db.session.deleteMany({ where: { userId: user.id } });
    return { problem: "deactivated" };
  }
  if (isIdle(result.session.updatedAt, new Date(), idleLimitMinutes(isStaff))) {
    await db.session.deleteMany({ where: { id: result.session.id } });
    await writeAudit(db, { action: "auth.session.idle_timeout", entityType: "User", entityId: user.id, userId: user.id, ipAddress: ip });
    return { problem: "idle" };
  }

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phoneNumber: user.phoneNumber,
      twoFactorEnabled: user.twoFactorEnabled === true,
      assignments,
      isStaff,
      sessionId: result.session.id,
      ipAddress: ip,
    },
  };
}

/** For pages: any signed-in user, or a redirect to sign-in. */
export async function requireUser(): Promise<CurrentUser> {
  const result = await loadCurrentUser();
  if ("problem" in result) redirect(`/sign-in?reason=${result.problem}`);
  return result.user;
}

/**
 * For staff pages: a signed-in staff user who has completed two-factor
 * enrolment (PRD F1: no staff page without 2FA).
 */
export async function requireStaff(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!user.isStaff) redirect("/forbidden");
  if (!user.twoFactorEnabled) redirect("/two-factor/setup");
  return user;
}

/** For staff pages that need one action. */
export async function requireStaffPermission(action: Action): Promise<CurrentUser> {
  const user = await requireStaff();
  if (!hasPermission(user.assignments, action)) redirect("/forbidden");
  return user;
}

/**
 * For server actions: the same checks, but failures throw so the action
 * returns 403 instead of redirecting. Every refusal is audited.
 */
export async function authorizeAction(action: Action): Promise<CurrentUser> {
  const result = await loadCurrentUser();
  if ("problem" in result) throw new ForbiddenError(`Not signed in (${result.problem})`);
  const user = result.user;
  try {
    if (user.isStaff && !user.twoFactorEnabled) throw new ForbiddenError("Two-factor login is required");
    assertPermission(user.assignments, action);
    return user;
  } catch (error) {
    await writeAudit(getDb(), {
      action: "auth.forbidden",
      entityType: "Action",
      entityId: action,
      userId: user.id,
      ipAddress: user.ipAddress,
    });
    throw error;
  }
}
