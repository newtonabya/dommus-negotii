"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { allowShared } from "@/lib/rate-limit";
import { LoanError } from "@/modules/credit/loans/common";
import { respondToGuarantee } from "@/modules/credit/loans/guarantee";
import { clientIp } from "@/shell/auth/security";
import { deliverSoon } from "@/shell/notifications/messages";

/** The guarantor's answer from their personal link. No login: the link itself is the proof. */
export async function answerGuaranteeAction(token: string, accept: boolean): Promise<never> {
  const ip = clientIp(await headers());
  const db = getDb();
  let query: string;
  if (!(await allowShared(db, `guarantee:${ip ?? "unknown"}`, 10, 60_000))) {
    query = `error=${encodeURIComponent("Too many attempts from this connection. Try again in a minute.")}`;
  } else {
    try {
      await respondToGuarantee(db, token, accept, ip);
      deliverSoon(db);
      query = "done=1";
    } catch (error) {
      if (!(error instanceof LoanError)) throw error;
      query = `error=${encodeURIComponent(error.message)}`;
    }
  }
  redirect(`/guarantee/${token}?${query}` as never);
}
