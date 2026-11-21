"use server";

import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { allowShared } from "@/lib/rate-limit";
import { auth } from "@/shell/auth/auth";
import { normalizeNigerianPhone } from "@/shell/auth/phone";
import { phoneResetRoute } from "@/shell/auth/reset-by-phone";
import { clientIp } from "@/shell/auth/security";
import { readSmsConfig } from "@/shell/notifications/sms/config";

type Result = { ok: true; via: "sms" | "email" } | { ok: false; error: string };

/**
 * Forgot password by phone number. With SMS on, the page goes on to text a
 * code. With SMS off, a reset link goes to the account's email if it has one;
 * the answer is the same whether or not it does.
 */
export async function resetByPhoneAction(identifier: string): Promise<Result> {
  const phoneNumber = normalizeNigerianPhone(identifier);
  if (!phoneNumber) return { ok: false, error: "Enter your email, or a Nigerian mobile number such as 0803 123 4567." };
  if (readSmsConfig().config.enabled) return { ok: true, via: "sms" };

  const db = getDb();
  const requestHeaders = await headers();
  const ip = clientIp(requestHeaders) ?? "unknown";
  if (!(await allowShared(db, `reset-phone-ip:${ip}`, 10, 60_000)) || !(await allowShared(db, `reset-phone:${phoneNumber}`, 3, 15 * 60_000))) {
    return { ok: false, error: "Too many requests. Wait 15 minutes and try again." };
  }
  try {
    const route = await phoneResetRoute(db, phoneNumber, false);
    if (route.route === "email") {
      await auth.api.requestPasswordReset({ body: { email: route.email, redirectTo: "/reset-password" }, headers: requestHeaders });
    }
    return { ok: true, via: "email" };
  } catch (error) {
    console.error("[forgot password by phone]", error);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
