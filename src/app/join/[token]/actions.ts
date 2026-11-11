"use server";

import { headers } from "next/headers";
import { APIError } from "better-auth/api";
import { generateRandomString, hashPassword } from "better-auth/crypto";
import { isPasswordCompromised } from "better-auth/plugins/haveibeenpwned";
import { getDb } from "@/lib/db";
import { beginUpload, EvidenceError, finishUpload } from "@/evidence/service";
import { getEvidenceStore } from "@/evidence/store";
import { MemberError } from "@/modules/credit/members/invitations";
import {
  activateImportedMember,
  checkRegistrationDetails,
  registerMember,
  registrantActorId,
  sendRegistrationCode,
  usableInvitation,
  type ActivationInput,
  type RegistrationDeps,
} from "@/modules/credit/members/registration";
import { MAX_UPLOADS_PER_INVITATION, type RegistrationInput } from "@/modules/credit/members/rules";
import { auth } from "@/shell/auth/auth";
import { clientIp } from "@/shell/auth/security";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  if (error instanceof MemberError || error instanceof EvidenceError) return { ok: false, error: error.message };
  console.error("[registration]", error);
  return { ok: false, error: "Something went wrong. Please try again." };
}

const SCAN_TYPES = new Set(["jpg", "jpeg", "png", "pdf"]);

/** Sends the 6-digit code to the invited phone. */
export async function requestCodeAction(token: string): Promise<Result<null>> {
  try {
    const ip = clientIp(await headers());
    await sendRegistrationCode(getDb(), token, async (phoneNumber) => {
      await auth.api.sendPhoneNumberOTP({ body: { phoneNumber } });
    }, ip);
    return { ok: true, value: null };
  } catch (error) {
    return failure(error);
  }
}

/** ID card scan upload, step 1. The link token stands in for a login. */
export async function beginScanUploadAction(token: string, input: { filename: string; size: number }) {
  try {
    const db = getDb();
    const invitation = await usableInvitation(db, token);
    const ext = input.filename.toLowerCase().split(".").pop() ?? "";
    if (!SCAN_TYPES.has(ext)) throw new MemberError("Upload a JPG, PNG or PDF of your ID card.");
    const actorId = registrantActorId(invitation.id);
    if ((await db.evidenceUpload.count({ where: { uploadedById: actorId } })) >= MAX_UPLOADS_PER_INVITATION) {
      throw new MemberError("Too many upload attempts on this link. Ask MOAUM for a new invitation.");
    }
    const ip = clientIp(await headers());
    return { ok: true as const, value: await beginUpload(db, getEvidenceStore(), { id: actorId, ipAddress: ip }, input) };
  } catch (error) {
    return failure(error);
  }
}

/** ID card scan upload, step 2. */
export async function finishScanUploadAction(token: string, uploadId: string) {
  try {
    const db = getDb();
    const invitation = await usableInvitation(db, token);
    const ip = clientIp(await headers());
    const result = await finishUpload(db, getEvidenceStore(), { id: registrantActorId(invitation.id), ipAddress: ip }, uploadId);
    return { ok: true as const, value: result };
  } catch (error) {
    return failure(error);
  }
}

const deps: RegistrationDeps = {
  verifyCode: async (phoneNumber, code) => {
    try {
      await auth.api.consumePhoneNumberOTP({ body: { phoneNumber, code } });
      return true;
    } catch (error) {
      // Only a rejected code is "wrong"; anything else (e.g. the database
      // unreachable) must not be reported as a bad code.
      const rejected = ["INVALID_OTP", "OTP_EXPIRED", "OTP_NOT_FOUND", "TOO_MANY_ATTEMPTS"];
      if (error instanceof APIError && rejected.includes(String(error.body?.code))) return false;
      throw error;
    }
  },
  hashPassword,
  isPasswordCompromised,
  newId: () => generateRandomString(32, "a-z", "A-Z", "0-9"),
};

/** Before the code is sent: checks the details, so mistakes show on the form they belong to. */
export async function checkDetailsAction(token: string, input: RegistrationInput): Promise<Result<null>> {
  try {
    await checkRegistrationDetails(getDb(), token, input);
    return { ok: true, value: null };
  } catch (error) {
    return failure(error);
  }
}

/** Final step: checks the SMS code and creates the PENDING member and their login. */
export async function registerAction(token: string, input: RegistrationInput & { code: string }): Promise<Result<null>> {
  try {
    await registerMember(getDb(), token, input, deps, clientIp(await headers()));
    return { ok: true, value: null };
  } catch (error) {
    return failure(error);
  }
}

/** Imported member's final step: checks the SMS code and sets up their login. */
export async function activateAction(token: string, input: ActivationInput & { code: string }): Promise<Result<null>> {
  try {
    await activateImportedMember(getDb(), token, input, deps, clientIp(await headers()));
    return { ok: true, value: null };
  } catch (error) {
    return failure(error);
  }
}
