"use server";

import type { BankLineCategory } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { getEvidenceStore } from "@/evidence/store";
import { MAX_IMPORT_BYTES } from "@/modules/credit/imports/table";
import {
  matchVoucher,
  recordBankLineEntry,
  recordLodgement,
  returnBankLineEntry,
  tagDirectPayment,
  verifyBankLineEntry,
  verifyLodgement,
} from "@/modules/credit/banking/matching";
import { BankError } from "@/modules/credit/banking/statements";
import { authorizeAction } from "@/shell/auth/session";
import { field, runAndReturn } from "../run-action";

const MATCHING = "/staff/bank/matching";
const CASHIER = "/staff/bank/cashier";

export async function verifyLodgementAction(lineId: string, lodgementId: string) {
  return runAndReturn(MATCHING, async () => {
    const actor = await authorizeAction("lodgement.verify");
    await verifyLodgement(getDb(), actor, lineId, lodgementId);
    return "Lodgement marked BANK_VERIFIED. The Cashier can now record it.";
  });
}

export async function tagMemberAction(lineId: string, form: FormData) {
  return runAndReturn(MATCHING, async () => {
    const actor = await authorizeAction("bankCredit.tagMember");
    const file = form.get("receipt");
    let receipt = null;
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_IMPORT_BYTES) throw new BankError("The receipt is larger than 2 MB.");
      receipt = { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    }
    const tag = await tagDirectPayment(getDb(), getEvidenceStore(), actor, lineId, { member: field(form, "member"), note: field(form, "note") }, receipt);
    return `Tagged to ${tag.member.fullName}. The Treasurer puts it on the month's schedule as a DIRECT row with bank_credit_ref ${tag.reference}.`;
  });
}

export async function matchVoucherAction(lineId: string, voucherId: string) {
  return runAndReturn(MATCHING, async () => {
    const actor = await authorizeAction("bankDebit.match");
    await matchVoucher(getDb(), actor, lineId, voucherId);
    return "Debit matched to its voucher.";
  });
}

export async function verifyEntryAction(id: string) {
  return runAndReturn(MATCHING, async () => {
    const actor = await authorizeAction("bankLineEntry.verify");
    await verifyBankLineEntry(getDb(), actor, id);
    return "Entry verified and posted.";
  });
}

export async function returnEntryAction(id: string, form: FormData) {
  return runAndReturn(MATCHING, async () => {
    const actor = await authorizeAction("bankLineEntry.verify");
    await returnBankLineEntry(getDb(), actor, id, field(form, "reason"));
    return "Entry returned to the Cashier.";
  });
}

export async function recordLodgementAction(lodgementId: string) {
  return runAndReturn(CASHIER, async () => {
    const actor = await authorizeAction("lodgement.record");
    await recordLodgement(getDb(), actor, lodgementId);
    return "Lodgement recorded and applied to its schedule.";
  });
}

export async function recordEntryAction(lineId: string, form: FormData) {
  return runAndReturn(CASHIER, async () => {
    const actor = await authorizeAction("bankLineEntry.record");
    await recordBankLineEntry(getDb(), actor, lineId, field(form, "category") as BankLineCategory, field(form, "note"));
    return "Entry recorded. The Finance Manager verifies it.";
  });
}
