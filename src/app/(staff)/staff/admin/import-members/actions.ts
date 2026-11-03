"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { getEvidenceStore } from "@/evidence/store";
import { commitMemberImport, previewMemberImport } from "@/modules/credit/members/member-import";
import { authorizeAction } from "@/shell/auth/session";
import { runForResult, uploadedFile } from "../../run-action";

const PAGE = "/staff/admin/import-members";

/** Member import, step 1: dry run. The file is kept as evidence. */
export async function previewMemberImportAction(form: FormData) {
  return runForResult(async () => {
    const actor = await authorizeAction("member.import.upload");
    const { filename, bytes } = await uploadedFile(form);
    const preview = await previewMemberImport(getDb(), getEvidenceStore(), actor, filename, bytes);
    revalidatePath(PAGE);
    return preview;
  });
}

/** Member import, step 2: all or nothing, then activation links by SMS. */
export async function commitMemberImportAction(batchId: string) {
  return runForResult(async () => {
    const actor = await authorizeAction("member.import.upload");
    try {
      const { imported, smsFailed } = await commitMemberImport(getDb(), actor, batchId);
      const plural = imported === 1 ? "member" : "members";
      return smsFailed === 0
        ? `${imported} ${plural} imported. Each was sent an SMS link to set up their login.`
        : `${imported} ${plural} imported. ${smsFailed} activation SMS${smsFailed === 1 ? " was" : "es were"} not accepted by the provider; resend them from Invitations.`;
    } finally {
      revalidatePath(PAGE);
    }
  });
}
