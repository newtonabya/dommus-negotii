"use server";

import { getDb } from "@/lib/db";
import { getEvidenceStore } from "@/evidence/store";
import { MAX_IMPORT_BYTES } from "@/modules/credit/imports/table";
import { prepareReclassification, returnReclassification, verifyReclassification } from "@/modules/credit/refunds/reclassifications";
import {
  approveRefund,
  captureRefundRequest,
  prepareRefundVoucher,
  RefundError,
  rejectRefund,
  returnRefundVoucher,
  verifyRefundVoucher,
} from "@/modules/credit/refunds/refunds";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn } from "../run-action";

const PAGE = "/staff/refunds";

async function fileOf(form: FormData, name: string, label: string) {
  const file = form.get(name);
  if (!(file instanceof File) || file.size === 0) throw new RefundError(`Attach ${label}.`);
  if (file.size > MAX_IMPORT_BYTES) throw new RefundError(`The file is larger than 2 MB.`);
  return { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
const bankFields = (form: FormData) => ({
  amount: field(form, "amount"),
  beneficiaryName: field(form, "beneficiaryName"),
  beneficiaryBank: field(form, "beneficiaryBank"),
  beneficiaryAccountNo: field(form, "beneficiaryAccountNo"),
  note: field(form, "note"),
});

export async function captureRefundAction(form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("refund.captureRequest");
    await captureRefundRequest(getDb(), getEvidenceStore(), actor, field(form, "member"), bankFields(form), await fileOf(form, "request", "the member's signed request"));
    return "Refund request captured. Management decides it.";
  });
}

export async function approveRefundAction(id: string, form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("refund.approve");
    await approveRefund(getDb(), actor, id, field(form, "comment"));
    return "Refund approved. The Cashier prepares the voucher once the transfer is made.";
  });
}

export async function rejectRefundAction(id: string, form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("refund.approve");
    await rejectRefund(getDb(), actor, id, field(form, "comment"));
    return "Refund rejected. The member sees the reason.";
  });
}

export async function prepareRefundVoucherAction(id: string, form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("voucher.refund.prepare");
    await prepareRefundVoucher(
      getDb(),
      getEvidenceStore(),
      actor,
      id,
      { bankAccountId: field(form, "bankAccountId"), valueDate: field(form, "valueDate"), transferRef: field(form, "transferRef") },
      await fileOf(form, "evidence", "the transfer evidence"),
    );
    return "Refund voucher prepared. The Finance Manager verifies it.";
  });
}

export async function verifyRefundVoucherAction(voucherId: string) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("voucher.refund.verify");
    await verifyRefundVoucher(getDb(), actor, voucherId);
    return "Refund verified and posted. The member's credit is reduced.";
  });
}

export async function returnRefundVoucherAction(voucherId: string, form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("voucher.refund.verify");
    await returnRefundVoucher(getDb(), actor, voucherId, field(form, "reason"));
    return "Voucher returned to the Cashier.";
  });
}

export async function prepareReclassificationAction(form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("reclassification.prepare");
    await prepareReclassification(
      getDb(),
      getEvidenceStore(),
      actor,
      { rowId: field(form, "rowId"), amount: field(form, "amount"), reason: field(form, "reason") },
      await fileOf(form, "request", "the member's request"),
    );
    return "Reclassification prepared. The Finance Manager verifies it.";
  });
}

export async function verifyReclassificationAction(id: string) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("reclassification.verify");
    await verifyReclassification(getDb(), actor, id);
    return "Reclassification verified: the loan was recomputed and the amount is now Overpayment Credit.";
  });
}

export async function returnReclassificationAction(id: string, form: FormData) {
  return runAndReturn(PAGE, async () => {
    const actor = await authorizeAction("reclassification.verify");
    await returnReclassification(getDb(), actor, id, field(form, "comment"));
    return "Reclassification returned to the Treasurer.";
  });
}
