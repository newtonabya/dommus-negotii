"use server";

import { headers } from "next/headers";
import { generateRandomString, hashPassword } from "better-auth/crypto";
import { isPasswordCompromised } from "better-auth/plugins/haveibeenpwned";
import { getDb } from "@/lib/db";
import { MemberError } from "@/modules/credit/members/invitations";
import { redeemSignInLink } from "@/modules/credit/members/sign-in-links";
import { clientIp } from "@/shell/auth/security";

type Result = { ok: true; firstTime: boolean } | { ok: false; error: string };

/** Sets the member's password from a Loan Officer's sign-in link. */
export async function setPasswordFromLinkAction(token: string, input: { password: string; confirmPassword: string; consent: boolean }): Promise<Result> {
  try {
    const { firstTime } = await redeemSignInLink(
      getDb(),
      token,
      input,
      { hashPassword, isPasswordCompromised, newId: () => generateRandomString(32, "a-z", "A-Z", "0-9") },
      clientIp(await headers()),
    );
    return { ok: true, firstTime };
  } catch (error) {
    if (error instanceof MemberError) return { ok: false, error: error.message };
    console.error("[sign-in link]", error);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
