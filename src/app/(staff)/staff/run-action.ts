import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { MemberError } from "@/modules/credit/members/invitations";
import { ForbiddenError } from "@/shell/rbac/permissions";
import { UserAdminError } from "@/shell/users/users";

/** Messages from these errors are written for the user and safe to show. */
function messageOf(error: unknown): string {
  if (error instanceof MemberError || error instanceof UserAdminError || error instanceof ForbiddenError) return error.message;
  if (error instanceof ZodError) return error.issues[0]?.message ?? "Check the form.";
  console.error(error);
  return "Something went wrong. Nothing was changed.";
}

/** Runs a staff action, then returns to `page` with a success or error notice. */
export async function runAndReturn(page: string, work: () => Promise<string>): Promise<never> {
  let notice: string;
  let tone: "ok" | "error";
  try {
    notice = await work();
    tone = "ok";
  } catch (error) {
    notice = messageOf(error);
    tone = "error";
  }
  revalidatePath(page);
  redirect(`${page}?${tone}=${encodeURIComponent(notice)}`);
}

export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
