"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { authorizeAction } from "@/shell/auth/session";
import { ForbiddenError } from "@/shell/rbac/permissions";
import {
  assignRole,
  createStaffUser,
  deactivateUser,
  reactivateUser,
  revokeRole,
  sendPasswordLink,
  UserAdminError,
} from "@/shell/users/users";

const PAGE = "/staff/admin/users";

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function messageOf(error: unknown): string {
  if (error instanceof UserAdminError || error instanceof ForbiddenError) return error.message;
  if (error instanceof ZodError) return "Check the form: a name and a valid email are required.";
  console.error(error);
  return "Something went wrong. Nothing was changed.";
}

/** Runs one Admin user operation, then returns to the page with a notice. */
async function run(work: () => Promise<string>): Promise<never> {
  let notice: string;
  let tone: "ok" | "error";
  try {
    notice = await work();
    tone = "ok";
  } catch (error) {
    notice = messageOf(error);
    tone = "error";
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?${tone}=${encodeURIComponent(notice)}`);
}

export async function createStaffAction(form: FormData) {
  await run(async () => {
    const actor = await authorizeAction("users.manage");
    const user = await createStaffUser(actor, { name: field(form, "name"), email: field(form, "email") });
    return `${user.name} was created and emailed a link to set their password.`;
  });
}

export async function assignRoleAction(form: FormData) {
  await run(async () => {
    const actor = await authorizeAction("users.manage");
    await assignRole(actor, field(form, "userId"), field(form, "role"));
    return `Role ${field(form, "role")} assigned.`;
  });
}

export async function revokeRoleAction(form: FormData) {
  await run(async () => {
    const actor = await authorizeAction("users.manage");
    await revokeRole(actor, field(form, "userId"), field(form, "role"));
    return `Role ${field(form, "role")} removed.`;
  });
}

export async function deactivateAction(form: FormData) {
  await run(async () => {
    const actor = await authorizeAction("users.manage");
    await deactivateUser(actor, field(form, "userId"), field(form, "reason"));
    return "User deactivated and signed out everywhere.";
  });
}

export async function reactivateAction(form: FormData) {
  await run(async () => {
    const actor = await authorizeAction("users.manage");
    await reactivateUser(actor, field(form, "userId"));
    return "User reactivated.";
  });
}

export async function resendLinkAction(form: FormData) {
  await run(async () => {
    await authorizeAction("users.manage");
    await sendPasswordLink(field(form, "email"));
    return "A new password link was sent.";
  });
}
