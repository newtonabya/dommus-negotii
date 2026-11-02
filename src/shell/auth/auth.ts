import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { haveIBeenPwned, phoneNumber, twoFactor } from "better-auth/plugins";
import { getDb } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { writeAudit } from "@/shell/audit/audit";
import { notifyInBackground } from "@/shell/notifications/notify";
import {
  clientIp,
  describeDevice,
  deviceFingerprint,
  LOCKOUT_MINUTES,
  lockoutState,
  MEMBER_IDLE_MINUTES,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  normalizeNigerianPhone,
} from "./security";

export const APP_NAME = "Dommus Negotii";

const db = getDb();

const SIGN_IN_PATHS = new Set(["/sign-in/email", "/sign-in/phone-number"]);
const TWO_FACTOR_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);

/** The login identifier a sign-in request names: a lower-cased email or an E.164 phone. */
function identifierOf(path: string, body: unknown): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (path === "/sign-in/email" && typeof b.email === "string") return normalizeEmail(b.email);
  if (path === "/sign-in/phone-number" && typeof b.phoneNumber === "string") {
    return normalizeNigerianPhone(b.phoneNumber) ?? b.phoneNumber.trim();
  }
  return null;
}

async function findUserByIdentifier(identifier: string) {
  return identifier.startsWith("+")
    ? db.user.findUnique({ where: { phoneNumber: identifier } })
    : db.user.findUnique({ where: { email: identifier } });
}

/** PRD F1: 5 failed sign-ins in 15 minutes lock the identifier for 15 minutes. */
async function assertNotLocked(identifier: string, ip: string | null): Promise<void> {
  const since = new Date(Date.now() - LOCKOUT_MINUTES * 60_000);
  const [failures, lastOk] = await Promise.all([
    db.auditLog.findMany({
      where: { action: "auth.login.failure", entityType: "LoginIdentifier", entityId: identifier, occurredAt: { gt: since } },
      select: { occurredAt: true },
    }),
    db.auditLog.findFirst({
      where: { action: "auth.login.password_ok", entityType: "LoginIdentifier", entityId: identifier },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true },
    }),
  ]);
  const state = lockoutState(
    failures.map((f) => f.occurredAt),
    lastOk?.occurredAt ?? null,
    new Date(),
  );
  if (!state.locked || !state.until) return;
  await writeAudit(db, {
    action: "auth.login.locked",
    entityType: "LoginIdentifier",
    entityId: identifier,
    ipAddress: ip,
    after: { lockedUntil: state.until },
  });
  const minutes = Math.max(1, Math.ceil((state.until.getTime() - Date.now()) / 60_000));
  throw new APIError("TOO_MANY_REQUESTS", {
    message: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    code: "ACCOUNT_LOCKED",
  });
}

/** Sends a new-device alert when a user signs in from a browser not seen before (PRD F1). */
async function alertIfNewDevice(user: { id: string; email: string; phoneNumber?: string | null }, userAgent: string | null) {
  const device = deviceFingerprint(userAgent);
  const seen = await db.auditLog.count({
    where: { action: "auth.login.success", userId: user.id, after: { path: ["device"], equals: device } },
  });
  const anyBefore = await db.auditLog.count({ where: { action: "auth.login.success", userId: user.id } });
  // The current sign-in is already logged, so "first time on this device" means seen === 1.
  if (seen > 1 || anyBefore <= 1) return;
  const when = new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" });
  const text = `New sign-in to your ${APP_NAME} account from ${describeDevice(userAgent)} on ${when} (Lagos time). If this wasn't you, contact the Admin immediately.`;
  const viaSms = !!user.phoneNumber && user.email.endsWith(".invalid");
  notifyInBackground(db, {
    idempotencyKey: `auth.new_device:${user.id}:${device}`,
    channel: viaSms ? "SMS" : "EMAIL",
    recipient: viaSms ? (user.phoneNumber as string) : user.email,
    template: "auth.new_device",
    subject: `New sign-in to ${APP_NAME}`,
    text,
    payload: { userId: user.id, device },
  });
}

export const auth = betterAuth({
  appName: APP_NAME,
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(db, { provider: "postgresql" }),

  user: {
    additionalFields: {
      deactivatedAt: { type: "date", required: false, input: false },
    },
  },

  emailAndPassword: {
    enabled: true,
    // Nobody signs themselves up: Admin creates staff, members come through invitations.
    disableSignUp: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url, token }) => {
      notifyInBackground(db, {
        idempotencyKey: `auth.reset:${sha256Hex(token)}`,
        channel: "EMAIL",
        recipient: user.email,
        template: "auth.password_reset",
        subject: `Set your ${APP_NAME} password`,
        text: `Use this link to set or reset your ${APP_NAME} password:\n\n${url}\n\nIt expires in 1 hour. If you didn't ask for this, ignore this email.`,
        payload: { userId: user.id },
      });
    },
  },

  // Sliding sessions: expire after 60 idle minutes (members). The staff 30-minute
  // limit is enforced in requireStaff() from session.updatedAt, which Better Auth
  // refreshes at most once per updateAge.
  session: {
    expiresIn: MEMBER_IDLE_MINUTES * 60,
    updateAge: 60,
    freshAge: 10 * 60,
  },

  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-in/phone-number": { window: 60, max: 10 },
      "/request-password-reset": { window: 60, max: 3 },
      "/phone-number/send-otp": { window: 60, max: 3 },
      "/phone-number/request-password-reset": { window: 60, max: 3 },
    },
  },

  advanced: {
    ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] },
  },

  databaseHooks: {
    session: {
      create: {
        // Deactivated users can never obtain a session, whatever the route.
        before: async (session) => {
          const user = await db.user.findUnique({ where: { id: session.userId }, select: { deactivatedAt: true } });
          if (user?.deactivatedAt) {
            throw new APIError("FORBIDDEN", { message: "This account has been deactivated.", code: "ACCOUNT_DEACTIVATED" });
          }
        },
      },
    },
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!SIGN_IN_PATHS.has(ctx.path)) return;
      const identifier = identifierOf(ctx.path, ctx.body);
      if (!identifier) return;
      await assertNotLocked(identifier, clientIp(ctx.headers));
    }),

    after: createAuthMiddleware(async (ctx) => {
      const ip = clientIp(ctx.headers);
      const userAgent = ctx.headers?.get("user-agent") ?? null;
      const returned = ctx.context.returned;

      if (SIGN_IN_PATHS.has(ctx.path)) {
        const identifier = identifierOf(ctx.path, ctx.body) ?? "unknown";
        if (returned instanceof APIError) {
          const user = await findUserByIdentifier(identifier);
          await writeAudit(db, {
            action: "auth.login.failure",
            entityType: "LoginIdentifier",
            entityId: identifier,
            userId: user?.id ?? null,
            ipAddress: ip,
            after: { reason: returned.body?.code ?? returned.status, path: ctx.path },
          });
          return;
        }
        await writeAudit(db, {
          action: "auth.login.password_ok",
          entityType: "LoginIdentifier",
          entityId: identifier,
          ipAddress: ip,
          after: { path: ctx.path },
        });
      }

      if (TWO_FACTOR_PATHS.has(ctx.path) && returned instanceof APIError) {
        await writeAudit(db, {
          action: "auth.2fa.failure",
          entityType: "User",
          ipAddress: ip,
          after: { reason: returned.body?.code ?? returned.status, path: ctx.path },
        });
        return;
      }

      const created = ctx.context.newSession;
      // Our hook runs before the two-factor plugin's, so on the password step of
      // a 2FA account newSession is still set; the plugin then withholds it. The
      // real success is logged when the code is verified.
      const awaitingSecondFactor =
        SIGN_IN_PATHS.has(ctx.path) && (created?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled === true;
      // Verifying a code while already signed in is enrolment, not a sign-in.
      const enrolling = TWO_FACTOR_PATHS.has(ctx.path) && ctx.context.session !== null;
      if (enrolling && created) {
        await writeAudit(db, {
          action: "auth.2fa.enabled",
          entityType: "User",
          entityId: created.user.id,
          userId: created.user.id,
          ipAddress: ip,
        });
        return;
      }
      if (created && !awaitingSecondFactor && (SIGN_IN_PATHS.has(ctx.path) || TWO_FACTOR_PATHS.has(ctx.path))) {
        await writeAudit(db, {
          action: "auth.login.success",
          entityType: "User",
          entityId: created.user.id,
          userId: created.user.id,
          ipAddress: ip,
          after: { device: deviceFingerprint(userAgent), path: ctx.path },
        });
        await alertIfNewDevice(created.user as { id: string; email: string; phoneNumber?: string | null }, userAgent);
      }

      if (ctx.path === "/sign-out") {
        await writeAudit(db, { action: "auth.logout", entityType: "User", ipAddress: ip });
      }
    }),
  },

  plugins: [
    twoFactor({ issuer: APP_NAME }),
    phoneNumber({
      otpLength: 6,
      expiresIn: 5 * 60,
      allowedAttempts: 3,
      requireVerification: true,
      phoneNumberValidator: (value) => normalizeNigerianPhone(value) === value,
      sendOTP: ({ phoneNumber: to, code }) => {
        notifyInBackground(db, {
          idempotencyKey: `auth.otp:${randomUUID()}`,
          channel: "SMS",
          recipient: to,
          template: "auth.phone_otp",
          text: `Your ${APP_NAME} code is ${code}. It expires in 5 minutes. Never share it.`,
        });
      },
      sendPasswordResetOTP: ({ phoneNumber: to, code }) => {
        notifyInBackground(db, {
          idempotencyKey: `auth.phone_reset:${randomUUID()}`,
          channel: "SMS",
          recipient: to,
          template: "auth.phone_reset",
          text: `Your ${APP_NAME} password reset code is ${code}. It expires in 5 minutes. Never share it.`,
        });
      },
    }),
    haveIBeenPwned(),
    nextCookies(), // must stay last
  ],
});

export type Auth = typeof auth;
