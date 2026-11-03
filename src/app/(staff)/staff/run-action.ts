import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { EvidenceError } from "@/evidence/service";
import { MAX_IMPORT_BYTES, TableError } from "@/modules/credit/imports/table";
import { MemberError } from "@/modules/credit/members/invitations";
import { ForbiddenError } from "@/shell/rbac/permissions";
import { ModuleError } from "@/shell/registry/registry";
import { SettingsError } from "@/shell/settings/settings";
import { UserAdminError } from "@/shell/users/users";

/** Messages from these errors are written for the user and safe to show. */
export function messageOf(error: unknown): string {
  if (
    error instanceof MemberError ||
    error instanceof UserAdminError ||
    error instanceof ForbiddenError ||
    error instanceof TableError ||
    error instanceof SettingsError ||
    error instanceof ModuleError ||
    error instanceof EvidenceError
  ) {
    return error.message;
  }
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

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Runs a staff action for a client component that shows the result itself. */
export async function runForResult<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** The uploaded list from an import form, as bytes. */
export async function uploadedFile(form: FormData): Promise<{ filename: string; bytes: Uint8Array }> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw new TableError("Choose a CSV or XLSX file.");
  if (file.size > MAX_IMPORT_BYTES) throw new TableError("The file is larger than 2 MB.");
  return { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
