"use server";

import { getDb } from "@/lib/db";
import { beginUpload, finishUpload } from "@/evidence/service";
import { getEvidenceStore } from "@/evidence/store";
import type { ApplicationValues } from "@/components/loans/application-form";
import { cancelMemberApplication, saveMemberApplication } from "@/modules/credit/loans/applications";
import { LoanError } from "@/modules/credit/loans/common";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn, runForResult } from "@/app/(staff)/staff/run-action";

const MAX_UPLOADS_PER_DAY = 10;

/** Member uploads (the signed guarantor form), step 1. */
export async function beginLoanUploadAction(input: { filename: string; size: number }) {
  return runForResult(async () => {
    const actor = await authorizeAction("self.loan.apply");
    const ext = input.filename.toLowerCase().split(".").pop() ?? "";
    if (!["jpg", "jpeg", "png", "pdf"].includes(ext)) throw new LoanError("Upload a JPG, PNG or PDF.");
    const db = getDb();
    const today = await db.evidenceUpload.count({ where: { uploadedById: actor.id, createdAt: { gt: new Date(Date.now() - 86_400_000) } } });
    if (today >= MAX_UPLOADS_PER_DAY) throw new LoanError("Too many uploads today. Try again tomorrow.");
    return beginUpload(db, getEvidenceStore(), actor, input);
  });
}

export async function finishLoanUploadAction(uploadId: string) {
  return runForResult(async () => finishUpload(getDb(), getEvidenceStore(), await authorizeAction("self.loan.apply"), uploadId));
}

/** Save a draft or submit (PRD F7). `draftId` ("" for a new one) is bound by the page. */
export async function saveApplicationAction(draftId: string, values: ApplicationValues, submit: boolean) {
  return runForResult(async () => {
    const actor = await authorizeAction("self.loan.apply");
    const { loanId, loanAccountNo } = await saveMemberApplication(getDb(), actor, values, submit, draftId || undefined);
    return submit
      ? { message: `Application ${loanAccountNo} submitted. A Loan Officer will review it.`, href: `/member/loans/${loanId}` }
      : { message: "Draft saved. You can finish it later.", href: `/member/loans/apply?draft=${loanId}` };
  });
}

export async function cancelApplicationAction(form: FormData) {
  await runAndReturn(`/member/loans/${field(form, "id")}`, async () => {
    await cancelMemberApplication(getDb(), await authorizeAction("self.loan.apply"), field(form, "id"), field(form, "comment"));
    return "Application cancelled.";
  });
}
