"use server";

import { getDb } from "@/lib/db";
import { prepareDisbursementVoucher, returnDisbursementVoucher, verifyDisbursementVoucher, type VoucherInput } from "@/modules/credit/loans/disbursement";
import { requestGuaranteeForOfficer } from "@/modules/credit/loans/guarantee";
import { approveLoan, cancelApprovedLoan, declineLoan, recommendLoan, rejectLoan, verifyLoan } from "@/modules/credit/loans/review";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn, runForResult } from "../../run-action";

const page = (form: FormData) => `/staff/loans/${field(form, "id")}`;

export async function verifyLoanAction(form: FormData) {
  await runAndReturn(page(form), async () => {
    await verifyLoan(getDb(), await authorizeAction("loan.verify"), field(form, "id"), field(form, "comment"));
    return "Verified: KYC and guarantor checked.";
  });
}

/**
 * Loan Officer: sends the guarantor (member or not) a new link, by SMS or, while
 * SMS is off, by email. With neither, the link comes back to be handed over.
 */
export async function resendGuaranteeAction(loanId: string) {
  return runForResult(async () => {
    const actor = await authorizeAction("loan.verify");
    const result = await requestGuaranteeForOfficer(getDb(), loanId, actor.id);
    if (result.sent === null) {
      return { message: "Text messages are switched off and the guarantor has no email on record, so give them this link yourself:", link: result.link };
    }
    return { message: result.sent === "SMS" ? "The request was sent to the guarantor by SMS." : "Text messages are switched off, so the request went to the guarantor's email.", link: null };
  });
}

export async function recommendLoanAction(form: FormData) {
  await runAndReturn(page(form), async () => {
    await recommendLoan(getDb(), await authorizeAction("loan.recommend"), field(form, "id"), field(form, "comment"));
    return "Recommended to Management.";
  });
}

export async function declineLoanAction(form: FormData) {
  await runAndReturn(page(form), async () => {
    await declineLoan(getDb(), await authorizeAction("loan.decline"), field(form, "id"), field(form, "comment"));
    return "Application declined.";
  });
}

export async function approveLoanAction(form: FormData) {
  await runAndReturn(page(form), async () => {
    await approveLoan(getDb(), await authorizeAction("loan.approve"), field(form, "id"), {
      amount: field(form, "amount"),
      tenure: field(form, "tenure"),
      comment: field(form, "comment"),
    });
    return "Loan approved. The Cashier can now pay it out.";
  });
}

export async function rejectLoanAction(form: FormData) {
  await runAndReturn(page(form), async () => {
    await rejectLoan(getDb(), await authorizeAction("loan.reject"), field(form, "id"), field(form, "comment"));
    return "Loan rejected.";
  });
}

export async function cancelApprovedLoanAction(form: FormData) {
  await runAndReturn(page(form), async () => {
    await cancelApprovedLoan(getDb(), await authorizeAction("loan.cancelApproved"), field(form, "id"), field(form, "comment"));
    return "Approved loan cancelled.";
  });
}

/** Cashier: from the voucher form (client), which uploads the transfer evidence first. */
export async function prepareVoucherAction(loanId: string, input: VoucherInput) {
  return runForResult(async () => {
    const voucher = await prepareDisbursementVoucher(getDb(), await authorizeAction("voucher.disbursement.prepare"), loanId, input);
    return voucher.id;
  });
}

export async function verifyVoucherAction(form: FormData) {
  await runAndReturn(page(form), async () => {
    await verifyDisbursementVoucher(getDb(), await authorizeAction("voucher.disbursement.verify"), field(form, "voucherId"));
    return "Voucher verified. The loan is active and the disbursement is in the ledger.";
  });
}

export async function returnVoucherAction(form: FormData) {
  await runAndReturn(page(form), async () => {
    await returnDisbursementVoucher(getDb(), await authorizeAction("voucher.disbursement.verify"), field(form, "voucherId"), field(form, "reason"));
    return "Voucher returned to the Cashier.";
  });
}
