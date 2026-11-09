"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { cancelRefund, RefundError, requestRefund } from "@/modules/credit/refunds/refunds";
import { authorizeAction } from "@/shell/auth/session";
import { ForbiddenError } from "@/shell/rbac/permissions";

const PAGE = "/member/credit";
const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

async function run(work: () => Promise<string>): Promise<never> {
  let target: string;
  try {
    target = `${PAGE}?ok=${encodeURIComponent(await work())}`;
  } catch (error) {
    if (!(error instanceof RefundError) && !(error instanceof ForbiddenError)) console.error(error);
    const message = error instanceof RefundError || error instanceof ForbiddenError ? error.message : "Something went wrong. Nothing was changed.";
    target = `${PAGE}?error=${encodeURIComponent(message)}`;
  }
  revalidatePath(PAGE);
  redirect(target as never);
}

export async function requestRefundAction(form: FormData) {
  return run(async () => {
    const actor = await authorizeAction("self.refund.request");
    await requestRefund(getDb(), actor, {
      amount: field(form, "amount"),
      beneficiaryName: field(form, "beneficiaryName"),
      beneficiaryBank: field(form, "beneficiaryBank"),
      beneficiaryAccountNo: field(form, "beneficiaryAccountNo"),
      note: field(form, "note"),
    });
    return "Refund requested. Management decides it; once approved, the money is transferred to your account.";
  });
}

export async function cancelRefundAction(refundId: string) {
  return run(async () => {
    const actor = await authorizeAction("self.refund.request");
    await cancelRefund(getDb(), actor, refundId);
    return "Request withdrawn.";
  });
}
