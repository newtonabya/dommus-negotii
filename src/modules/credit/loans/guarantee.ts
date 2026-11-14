import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";
import { writeAudit } from "@/shell/audit/audit";
import { notify } from "@/shell/notifications/notify";
import { ngn, tellMember, tellStaff } from "../notices";
import { LoanError } from "./common";

/**
 * A member named as guarantor accepts or declines by a personal link sent to
 * their phone by SMS (a signed paper form is the other way a guarantee is
 * given). The link holds 32 random bytes; only its SHA-256 is stored. It works
 * once, for 7 days, and only while the application is still waiting for the
 * Loan Officer.
 */
const LINK_DAYS = 7;

export const guaranteeUrl = (token: string) => `${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/guarantee/${token}`;

/**
 * Sends (or sends again) the request to a member guarantor. Returns false when
 * the loan has no member guarantor to ask, or the SMS could not be sent.
 */
export async function requestGuarantee(db: Db, loanId: string, actorId: string | null): Promise<boolean> {
  const loan = await db.loan.findUnique({ where: { id: loanId }, include: { guarantor: true, member: { select: { fullName: true } } } });
  const g = loan?.guarantor;
  if (!loan || !g || !g.memberId) return false;
  if (loan.status !== "SUBMITTED") throw new LoanError("The guarantor is only asked while the application waits for the Loan Officer.");
  if (g.acceptance === "ACCEPTED") throw new LoanError("The guarantor has already accepted.");
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LINK_DAYS * 86_400_000);
  await db.guarantor.update({ where: { id: g.id }, data: { acceptance: "PENDING", acceptTokenHash: sha256Hex(token), requestedAt: now, respondedAt: null, acceptExpiresAt: expiresAt } });
  await writeAudit(db, { action: "loan.guarantee.requested", entityType: "Loan", entityId: loanId, userId: actorId, ipAddress: null, after: { guarantorMemberId: g.memberId } });
  const until = expiresAt.toLocaleDateString("en-NG", { timeZone: "Africa/Lagos", day: "numeric", month: "long" });
  // Holds a link, so it is sent directly and its text is never stored.
  return notify(db, {
    idempotencyKey: `guarantee.request:${g.id}:${now.getTime()}`,
    channel: "SMS",
    recipient: g.phone,
    template: "guarantee.request",
    text: `MOAUM Credit Super Store: ${loan.member.fullName} has named you as guarantor for a loan of ${ngn(loan.amountRequested)} over ${loan.tenureRequested} months. Accept or decline here: ${guaranteeUrl(token)} This link is for you only and expires on ${until}.`,
    payload: { loanId, guarantorId: g.id },
  }).catch(() => false);
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
    g.acceptance === "ACCEPTED" ? "accepted" : g.acceptance === "DECLINED" ? "declined" : g.loan.status !== "SUBMITTED" ? "closed" : expired ? "expired" : "open";
  return { guarantor: g, loan: g.loan, state };
}

/** The guarantor's answer. Works once, while the link is open. */
export async function respondToGuarantee(db: PrismaClient, token: string, accept: boolean, ipAddress: string | null): Promise<"accepted" | "declined"> {
  const found = await guaranteeByToken(db, token);
  if (!found) throw new LoanError("This link is not valid. Ask the applicant to send a new request.");
  if (found.state === "accepted" || found.state === "declined") throw new LoanError("You have already answered this request.");
  if (found.state === "expired") throw new LoanError("This link has expired. Ask the applicant or the Loan Officer to send a new one.");
  if (found.state === "closed") throw new LoanError("This application is no longer waiting for a guarantor.");
  const { guarantor: g, loan } = found;
  const answer = accept ? "ACCEPTED" : "DECLINED";
  await db.$transaction(async (tx) => {
    const { count } = await tx.guarantor.updateMany({ where: { id: g.id, acceptance: "PENDING" }, data: { acceptance: answer, respondedAt: new Date() } });
    if (count !== 1) throw new LoanError("You have already answered this request.");
    await writeAudit(tx, { action: accept ? "loan.guarantee.accepted" : "loan.guarantee.declined", entityType: "Loan", entityId: loan.id, userId: null, ipAddress, after: { guarantorMemberId: g.memberId } });
    const no = loan.loanAccountNo ?? "your application";
    await tellMember(
      tx,
      loan.member.id,
      `guarantee.${answer.toLowerCase()}:${g.id}:${g.requestedAt?.getTime() ?? 0}`,
      `guarantee.${answer.toLowerCase()}`,
      accept ? `${g.fullName} accepted to guarantee your loan application ${no}. It now goes to the Loan Officer.` : `${g.fullName} declined to guarantee your loan application ${no}. Cancel it and apply again with another guarantor.`,
    );
    await tellStaff(
      tx,
      ["LOAN_OFFICER"],
      `guarantee.${answer.toLowerCase()}:${g.id}:${g.requestedAt?.getTime() ?? 0}`,
      `staff.guarantee.${answer.toLowerCase()}`,
      `Guarantor ${accept ? "accepted" : "declined"}: ${no}`,
      `${g.fullName} ${accept ? "accepted" : "declined"} to guarantee ${loan.member.fullName}'s loan application ${no}.${accept ? " It can now be verified." : ""}`,
    );
  });
  return accept ? "accepted" : "declined";
}
