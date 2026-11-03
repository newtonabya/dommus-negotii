"use server";

import { timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { generateRandomString, hashPassword } from "better-auth/crypto";
import { isPasswordCompromised } from "better-auth/plugins/haveibeenpwned";
import { z } from "zod";
import { getDb, TX_OPTIONS } from "@/lib/db";
import { writeAudit } from "@/shell/audit/audit";
import { clientIp, MIN_PASSWORD_LENGTH, normalizeEmail } from "@/shell/auth/security";
import { adminExists } from "@/shell/users/users";

export interface SetupState {
  error?: string;
}

const schema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(2).max(120),
  email: z.email().transform(normalizeEmail),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(128),
});

function tokenMatches(given: string): boolean {
  const expected = process.env.SETUP_TOKEN;
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * First-run setup: creates the first Admin with their own password. Needs the
 * SETUP_TOKEN from the server's environment and works only while no Admin exists.
 */
export async function createFirstAdmin(_prev: SetupState, form: FormData): Promise<SetupState> {
  const parsed = schema.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "Check the fields: a name, a valid email and a password of at least 10 characters." };
  const { token, name, email, password } = parsed.data;
  const ip = clientIp(await headers());

  if (!tokenMatches(token)) {
    await writeAudit(getDb(), { action: "setup.first_admin.denied", entityType: "Setup", ipAddress: ip });
    return { error: "The setup token is wrong." };
  }
  if (await adminExists()) return { error: "Setup is already complete." };
  let compromised: boolean;
  try {
    compromised = await isPasswordCompromised(password);
  } catch {
    return { error: "Couldn't check the password against known breaches (network problem). Try again." };
  }
  if (compromised) return { error: "That password appears in known data breaches. Choose a different one." };

  // User, password account (Better Auth's "credential" provider), Admin role and
  // audit entry are written together, so a failure leaves nothing half-created.
  const passwordHash = await hashPassword(password);
  const userId = generateRandomString(32, "a-z", "A-Z", "0-9");
  await getDb().$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, name, email, emailVerified: true } });
    await tx.account.create({
      data: {
        id: generateRandomString(32, "a-z", "A-Z", "0-9"),
        userId,
        providerId: "credential",
        accountId: userId,
        password: passwordHash,
      },
    });
    await tx.userModuleRole.create({ data: { userId, moduleCode: "SHELL", role: "ADMIN", assignedById: userId } });
    await writeAudit(tx, {
      action: "setup.first_admin",
      entityType: "User",
      entityId: userId,
      userId,
      ipAddress: ip,
      after: { name, email, roles: ["ADMIN"] },
    });
  }, TX_OPTIONS);
  redirect("/sign-in?reason=setup-done");
}
