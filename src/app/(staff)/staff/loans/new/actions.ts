"use server";

import { getDb } from "@/lib/db";
import { captureAssistedApplication } from "@/modules/credit/loans/applications";
import { LoanError } from "@/modules/credit/loans/common";
import { authorizeAction } from "@/shell/auth/session";
import type { ApplicationValues } from "@/components/loans/application-form";
import { runForResult } from "../../run-action";

/** Loan Officer: an application the member signed on paper (PRD F7). */
export async function captureApplicationAction(values: ApplicationValues & { memberMoaumId: string; applicationFormEvidenceId: string }) {
  return runForResult(async () => {
    const actor = await authorizeAction("loan.application.captureAssisted");
    const db = getDb();
    const member = await db.member.findUnique({ where: { moaumIdNumber: values.memberMoaumId.trim().toUpperCase() } });
    if (!member) throw new LoanError("No member has that MOAUM ID number.");
    const { loanId, loanAccountNo } = await captureAssistedApplication(db, actor, member.id, values);
    return { message: `Application ${loanAccountNo} captured and submitted.`, href: `/staff/loans/${loanId}` };
  });
}
