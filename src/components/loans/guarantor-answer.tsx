import type { Guarantor } from "@/generated/prisma/client";

const day = (d: Date | null) => (d ? d.toLocaleDateString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", year: "numeric" }) : "");

/** Where the guarantor's SMS answer stands, in words for the member. */
export function guarantorAnswer(g: Pick<Guarantor, "acceptance" | "requestedAt" | "respondedAt" | "acceptExpiresAt">, loanStatus: string, now = new Date()) {
  if (g.acceptance === "ACCEPTED") return { short: "Accepted", tone: "text-success", text: `Accepted on ${day(g.respondedAt)}.` };
  if (g.acceptance === "DECLINED") {
    return {
      short: "Declined",
      tone: "text-danger",
      text:
        loanStatus === "SUBMITTED"
          ? `Declined on ${day(g.respondedAt)}. This application can't go ahead: cancel it and apply again with another guarantor.`
          : `Declined on ${day(g.respondedAt)}. The Loan Officer will contact you about another guarantor.`,
    };
  }
  if (g.acceptance === "PENDING") {
    if (g.acceptExpiresAt && g.acceptExpiresAt.getTime() <= now.getTime()) {
      return { short: "No answer", tone: "text-danger", text: `Their link expired on ${day(g.acceptExpiresAt)} without an answer. Ask the Loan Officer to send it again.` };
    }
    return {
      short: "Waiting",
      tone: "text-accent",
      text: `Waiting for their answer. They were sent an SMS link on ${day(g.requestedAt)}${g.acceptExpiresAt ? `; it works until ${day(g.acceptExpiresAt)}` : ""}. The Loan Officer can't verify the application until they accept.`,
    };
  }
  return { short: "Not asked yet", tone: "text-muted", text: "Not asked yet: the Loan Officer will send them the request by SMS." };
}
