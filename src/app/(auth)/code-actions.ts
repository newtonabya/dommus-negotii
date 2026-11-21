"use server";

import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { allowShared } from "@/lib/rate-limit";
import { auth } from "@/shell/auth/auth";
import { setNextCodeChannel, type CodeChannel } from "@/shell/auth/code-channel";
import { normalizeNigerianPhone } from "@/shell/auth/phone";
import { clientIp } from "@/shell/auth/security";

type Result = { ok: true } | { ok: false; error: string };

/**
 * "Send a new code by SMS / by email" on the sign-in and forgot-password code
 * screens. The answer is the same whether or not the number has an account
 * or an email, so it reveals nothing; the per-phone code limit in auth.ts
 * still applies to both channels together.
 */
export async function resendCodeAction(purpose: "sign-in" | "reset", identifier: string, channel: CodeChannel): Promise<Result> {
  const phoneNumber = normalizeNigerianPhone(identifier);
  if (!phoneNumber) return { ok: false, error: "Enter a Nigerian mobile number, e.g. 0803 123 4567." };
  if (channel !== "SMS" && channel !== "EMAIL") return { ok: false, error: "Choose SMS or email." };
  const db = getDb();
  const requestHeaders = await headers();
  if (!(await allowShared(db, `resend-code-ip:${clientIp(requestHeaders) ?? "unknown"}`, 10, 60_000))) {
    return { ok: false, error: "Too many requests. Wait a minute and try again." };
  }
  try {
    if (!(await db.user.findUnique({ where: { phoneNumber }, select: { id: true } }))) return { ok: true };
    await setNextCodeChannel(db, phoneNumber, channel);
    if (purpose === "sign-in") await auth.api.sendPhoneNumberOTP({ body: { phoneNumber }, headers: requestHeaders });
    else await auth.api.requestPasswordResetPhoneNumber({ body: { phoneNumber }, headers: requestHeaders });
    return { ok: true };
  } catch (error) {
    console.error("[resend code]", error);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
