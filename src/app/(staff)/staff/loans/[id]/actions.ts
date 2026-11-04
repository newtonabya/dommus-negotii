"use server";

import { getDb } from "@/lib/db";
import { prepareDisbursementVoucher, returnDisbursementVoucher, verifyDisbursementVoucher, type VoucherInput } from "@/modules/credit/loans/disbursement";
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
