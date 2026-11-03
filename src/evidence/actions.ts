"use server";

import { getDb } from "@/lib/db";
import { authorizeAction } from "@/shell/auth/session";
import { ForbiddenError } from "@/shell/rbac/permissions";
import { beginUpload, EvidenceError, finishUpload, type BeginUploadResult, type FinishUploadResult } from "./service";
import { getEvidenceStore } from "./store";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  if (error instanceof EvidenceError || error instanceof ForbiddenError) return { ok: false, error: error.message };
  console.error("[evidence]", error);
  return { ok: false, error: "The upload failed. Please try again." };
}

/** Step 1 of an upload: returns a 5-minute URL for the browser to PUT the file to. */
export async function beginEvidenceUpload(input: { filename: string; size: number }): Promise<Result<BeginUploadResult>> {
  try {
    const user = await authorizeAction("evidence.upload");
    return { ok: true, value: await beginUpload(getDb(), getEvidenceStore(), user, input) };
  } catch (error) {
    return failure(error);
  }
}

/** Step 2: the server checks, hashes and files the uploaded bytes. */
export async function finishEvidenceUpload(uploadId: string): Promise<Result<FinishUploadResult>> {
  try {
    const user = await authorizeAction("evidence.upload");
    return { ok: true, value: await finishUpload(getDb(), getEvidenceStore(), user, uploadId) };
  } catch (error) {
    return failure(error);
  }
}
