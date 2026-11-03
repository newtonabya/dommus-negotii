"use server";

import { getDb } from "@/lib/db";
import { beginUpload, finishUpload } from "@/evidence/service";
import { getEvidenceStore } from "@/evidence/store";
import { MemberError } from "@/modules/credit/members/invitations";
import { sendPhoneChangeCode } from "@/modules/credit/members/phone-change";
import { requestProfileChange, withdrawProfileChange } from "@/modules/credit/members/profile-changes";
import { normalizeNigerianPhone } from "@/shell/auth/phone";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn, runForResult } from "@/app/(staff)/staff/run-action";

const PAGE = "/member/profile";
const MAX_UPLOADS_PER_DAY = 10;
const UPLOAD_TYPES = new Set(["jpg", "jpeg", "png", "pdf"]);

/** Member document upload, step 1 (ID scan or supporting document). */
export async function beginMemberUploadAction(input: { filename: string; size: number }) {
  return runForResult(async () => {
    const actor = await authorizeAction("self.profileChange.request");
    const ext = input.filename.toLowerCase().split(".").pop() ?? "";
    if (!UPLOAD_TYPES.has(ext)) throw new MemberError("Upload a JPG, PNG or PDF.");
    const db = getDb();
    const today = await db.evidenceUpload.count({ where: { uploadedById: actor.id, createdAt: { gt: new Date(Date.now() - 86_400_000) } } });
    if (today >= MAX_UPLOADS_PER_DAY) throw new MemberError("Too many uploads today. Try again tomorrow.");
    return beginUpload(db, getEvidenceStore(), actor, input);
  });
}

/** Member document upload, step 2. */
export async function finishMemberUploadAction(uploadId: string) {
  return runForResult(async () => {
    const actor = await authorizeAction("self.profileChange.request");
    return finishUpload(getDb(), getEvidenceStore(), actor, uploadId);
  });
}

/** Texts a code to the new phone number. */
export async function sendPhoneCodeAction(phone: string) {
  return runForResult(async () => {
    const actor = await authorizeAction("self.profileChange.request");
    const normalized = normalizeNigerianPhone(phone);
    if (!normalized) throw new MemberError("Enter a Nigerian mobile number, e.g. 0803 123 4567.");
    await sendPhoneChangeCode(getDb(), actor, normalized);
    return null;
  });
}

export async function requestChangeAction(input: { values: Record<string, string>; note: string; evidenceId: string; phoneCode: string }) {
  return runForResult(async () => {
    const actor = await authorizeAction("self.profileChange.request");
    await requestProfileChange(getDb(), actor, input);
    return null;
  });
}

export async function withdrawChangeAction(form: FormData) {
  await runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("self.profileChange.request");
    await withdrawProfileChange(getDb(), actor, field(form, "id"));
    return "Request withdrawn.";
  });
}
