import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { writeAudit } from "@/shell/audit/audit";
import { notify } from "@/shell/notifications/notify";
import { routeToPhone } from "@/shell/notifications/phone-route";
import { ngn, tellMember, tellStaff } from "../notices";
import { LoanError } from "./common";

/**
 * Every guarantor, member or not, accepts or declines by a personal link sent
 * to their phone by SMS (while SMS is off: to their email on record, or handed
 * over by the Loan Officer); a non-member also signs the paper form. The Loan
 * Officer can't verify, Management can't approve and the Cashier can't pay out
 * until the guarantor has accepted. The link holds 32 random bytes; only its
 * SHA-256 is stored. It works once, for 7 days, while the loan is open.
 */
const LINK_DAYS = 7;

/** Loan states in which the guarantor can still be asked (after SUBMITTED only for loans that moved on before the rule). */
const ASKABLE = new Set(["SUBMITTED", "VERIFIED", "RECOMMENDED", "APPROVED", "ACTIVE"]);

/** Whether the guarantor has confirmed by link. */
export const guarantorAccepted = (g: { acceptance: string | null } | null | undefined) => g?.acceptance === "ACCEPTED";

export const guaranteeUrl = (token: string) => `${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/guarantee/${token}`;

export interface GuaranteeRequest {
  /** How the link went: by SMS, by email (SMS switched off), or not at all. */
  sent: "SMS" | "EMAIL" | null;
  /** The link itself, for a Loan Officer to hand over in person when it couldn't be sent. Never show it to the applicant. */
  link: string;
}

/**
 * Sends (or sends again) the request to the guarantor: by SMS, or while SMS is
 * switched off, to the email on record for the guarantor's phone. Returns null
 * when the loan has no guarantor to ask.
 */
export async function requestGuarantee(db: Db, loanId: string, actorId: string | null): Promise<GuaranteeRequest | null> {
  const loan = await db.loan.findUnique({ where: { id: loanId }, include: { guarantor: true, member: { select: { fullName: true } } } });
  const g = loan?.guarantor;
  if (!loan || !g) return null;
  if (!ASKABLE.has(loan.status)) throw new LoanError("This loan is closed: the guarantor can't be asked.");
  if (g.acceptance === "ACCEPTED") throw new LoanError("The guarantor has already accepted.");
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LINK_DAYS * 86_400_000);
  await db.guarantor.update({ where: { id: g.id }, data: { acceptance: "PENDING", acceptTokenHash: sha256Hex(token), requestedAt: now, respondedAt: null, acceptExpiresAt: expiresAt } });
  await writeAudit(db, { action: "loan.guarantee.requested", entityType: "Loan", entityId: loanId, userId: actorId, ipAddress: null, after: { guarantorMemberId: g.memberId, guarantorPhone: g.phone } });
  const until = expiresAt.toLocaleDateString("en-NG", { timeZone: "Africa/Lagos", day: "numeric", month: "long" });
  const link = guaranteeUrl(token);
  const route = await routeToPhone(db, g.phone);
  if (!route) return { sent: null, link };
  // Holds a link, so it is sent directly and its text is never stored.
  const ok = await notify(db, {
    idempotencyKey: `guarantee.request:${g.id}:${now.getTime()}`,
    channel: route.channel,
    recipient: route.recipient,
    template: "guarantee.request",
    subject: route.channel === "EMAIL" ? "Please confirm a loan guarantee" : undefined,
    text: `MOAUM Credit Super Store: ${loan.member.fullName} has named you as guarantor for a loan of ${ngn(loan.amountRequested)} over ${loan.tenureRequested} months. Accept or decline here: ${link} This link is for you only and expires on ${until}.`,
    payload: { loanId, guarantorId: g.id },
  }).catch(() => false);
  return { sent: ok ? route.channel : null, link };
}

/**
 * Loan Officer: sends the request again and, when it couldn't be sent (SMS off
 * and no email on record), hands back the link to give the guarantor in
 * person. Showing it is audited; the guarantor's answer records their address.
 */
export async function requestGuaranteeForOfficer(db: Db, loanId: string, actorId: string): Promise<{ sent: "SMS" | "EMAIL" } | { sent: null; link: string }> {
  const result = await requestGuarantee(db, loanId, actorId);
  if (!result) throw new LoanError("This loan has no guarantor to ask.");
  if (result.sent) return { sent: result.sent };
  await writeAudit(db, { action: "loan.guarantee.link_shown", entityType: "Loan", entityId: loanId, userId: actorId, ipAddress: null });
  return { sent: null, link: result.link };
}

/** What the guarantor's page shows for a link; null when the link is unknown. */
export async function guaranteeByToken(db: Db, token: string) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const g = await db.guarantor.findUnique({
    where: { acceptTokenHash: sha256Hex(token) },
    include: { loan: { select: { id: true, status: true, loanAccountNo: true, amountRequested: true, tenureRequested: true, member: { select: { id: true, fullName: true } } } } },
  });
  if (!g) return null;
  const expired = !g.acceptExpiresAt || g.acceptExpiresAt.getTime() <= Date.now();
  const state: "open" | "accepted" | "declined" | "expired" | "closed" =
    g.acceptance === "ACCEPTED" ? "accepted" : g.acceptance === "DECLINED" ? "declined" : !ASKABLE.has(g.loan.status) ? "closed" : expired ? "expired" : "open";
  return { guarantor: g, loan: g.loan, state };
}

/** The guarantor's answer. Works once, while the link is open. */
export async function respondToGuarantee(db: PrismaClient, token: string, accept: boolean, ipAddress: string | null): Promise<"accepted" | "declined"> {
  const found = await guaranteeByToken(db, token);
  if (!found) throw new LoanError("This link is not valid. Ask the applicant to send a new request.");
  if (found.state === "accepted" || found.state === "declined") throw new LoanError("You have already answered this request.");
  if (found.state === "expired") throw new LoanError("This link has expired. Ask the applicant or the Loan Officer to send a new one.");
  if (found.state === "closed") throw new LoanError("This loan is closed: there is nothing to answer.");
  const { guarantor: g, loan } = found;
  const answer = accept ? "ACCEPTED" : "DECLINED";
  await db.$transaction(async (tx) => {
    const { count } = await tx.guarantor.updateMany({ where: { id: g.id, acceptance: "PENDING" }, data: { acceptance: answer, respondedAt: new Date() } });
    if (count !== 1) throw new LoanError("You have already answered this request.");
    await writeAudit(tx, { action: accept ? "loan.guarantee.accepted" : "loan.guarantee.declined", entityType: "Loan", entityId: loan.id, userId: null, ipAddress, after: { guarantorMemberId: g.memberId } });
    const no = loan.loanAccountNo ?? "your application";
    // The loan had moved on before the guarantor was asked (a loan from before this rule).
    const late = loan.status !== "SUBMITTED";
    await tellMember(
      tx,
      loan.member.id,
      `guarantee.${answer.toLowerCase()}:${g.id}:${g.requestedAt?.getTime() ?? 0}`,
      `guarantee.${answer.toLowerCase()}`,
      late
        ? accept
          ? `${g.fullName} confirmed they guarantee your loan ${no}.`
          : `${g.fullName} declined to guarantee your loan ${no}. The Loan Officer will contact you about another guarantor.`
        : accept
          ? `${g.fullName} accepted to guarantee your loan application ${no}. It now goes to the Loan Officer.`
          : `${g.fullName} declined to guarantee your loan application ${no}. Cancel it and apply again with another guarantor.`,
    );
    await tellStaff(
      tx,
      late && !accept ? ["LOAN_OFFICER", "MANAGEMENT"] : ["LOAN_OFFICER"],
      `guarantee.${answer.toLowerCase()}:${g.id}:${g.requestedAt?.getTime() ?? 0}`,
      `staff.guarantee.${answer.toLowerCase()}`,
      `Guarantor ${accept ? "accepted" : "declined"}: ${no}`,
      `${g.fullName} ${accept ? "accepted" : "declined"} to guarantee ${loan.member.fullName}'s loan ${no}.` +
        (late ? (accept ? " The guarantee is now confirmed." : ` The loan is already ${loan.status.toLowerCase()}: find a new guarantor or decide how to secure it.`) : accept ? " It can now be verified." : ""),
    );
  });
  return accept ? "accepted" : "declined";
}
