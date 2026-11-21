import type { Db } from "@/lib/db";
import { formatNaira, kobo, ZERO } from "@/lib/money";
import { ledgerPrincipalOutstanding } from "@/modules/credit/loans/queries";
import type { Action } from "@/shell/rbac/permissions";

export interface QueueItem {
  key: string;
  label: string;
  count: number;
  href: string;
}

/**
 * What waits for the signed-in staff member, from the permissions they hold:
 * each line is a step only their role can take next. Counts only; the linked
 * page has the list. Lines with nothing waiting are left out.
 */
export async function workQueue(db: Db, can: (action: Action) => boolean): Promise<QueueItem[]> {
  const lines: Array<{ key: string; label: string; href: string; when: boolean; count: () => Promise<number> }> = [
    { key: "members", label: "New members to check and activate", href: "/staff/members", when: can("member.activate"), count: () => db.member.count({ where: { status: "PENDING" } }) },
    { key: "profile", label: "Profile changes to decide", href: "/staff/members/profile-changes", when: can("member.profileChange.approve"), count: () => db.profileChangeRequest.count({ where: { status: "PENDING" } }) },
    { key: "verify", label: "Loan applications to verify", href: "/staff/loans", when: can("loan.verify"), count: () => db.loan.count({ where: { status: "SUBMITTED" } }) },
    { key: "recommend", label: "Verified loans to recommend", href: "/staff/loans", when: can("loan.recommend"), count: () => db.loan.count({ where: { status: "VERIFIED" } }) },
    { key: "approve", label: "Loans to approve or reject", href: "/staff/loans", when: can("loan.approve"), count: () => db.loan.count({ where: { status: "RECOMMENDED" } }) },
    { key: "payout", label: "Approved loans to pay out", href: "/staff/loans", when: can("voucher.disbursement.prepare"), count: () => db.loan.count({ where: { status: "APPROVED" } }) },
    { key: "voucher", label: "Disbursement vouchers to verify", href: "/staff/loans", when: can("voucher.disbursement.verify"), count: () => db.voucher.count({ where: { status: "PREPARED", loanId: { not: null } } }) },
    { key: "refund-approve", label: "Refund requests to decide", href: "/staff/refunds", when: can("refund.approve"), count: () => db.refund.count({ where: { status: "REQUESTED" } }) },
    { key: "refund-pay", label: "Approved refunds to pay", href: "/staff/refunds", when: can("voucher.refund.prepare"), count: () => db.refund.count({ where: { status: "APPROVED", vouchers: { none: { status: "PREPARED" } } } }) },
    { key: "refund-verify", label: "Refund vouchers to verify", href: "/staff/refunds", when: can("voucher.refund.verify"), count: () => db.voucher.count({ where: { status: "PREPARED", refundId: { not: null } } }) },
    { key: "corrections", label: "Schedule corrections to verify", href: "/staff/remittance", when: can("correction.verify"), count: () => db.correctionBatch.count({ where: { status: "PREPARED" } }) },
    { key: "reclass", label: "Reclassifications to verify", href: "/staff/refunds", when: can("reclassification.verify"), count: () => db.reclassification.count({ where: { status: "PREPARED" } }) },
    { key: "lodgements", label: "Lodgements to verify against the bank", href: "/staff/bank/matching", when: can("lodgement.verify"), count: () => db.lodgement.count({ where: { status: "UNVERIFIED" } }) },
    { key: "bank-entries", label: "Bank charges and transfers to verify", href: "/staff/bank/matching", when: can("bankLineEntry.verify"), count: () => db.bankLineEntry.count({ where: { status: "PREPARED" } }) },
    { key: "record", label: "Verified lodgements to record", href: "/staff/bank/cashier", when: can("lodgement.record"), count: () => db.lodgement.count({ where: { status: "BANK_VERIFIED" } }) },
    { key: "legacy", label: "Legacy loan files to commit", href: "/staff/legacy-loans", when: can("legacyImport.commit"), count: () => db.importBatch.count({ where: { kind: "LEGACY_LOANS", status: "PREVIEWED" } }) },
    { key: "settings", label: "Setting changes to approve", href: "/staff/admin/settings", when: can("settings.financial.approve"), count: () => db.settingChangeRequest.count({ where: { status: "PENDING" } }) },
    { key: "exceptions-review", label: "Open exceptions to review", href: "/staff/exceptions", when: can("exception.review"), count: () => db.exceptionRecord.count({ where: { status: "OPEN" } }) },
    { key: "exceptions-close", label: "Reviewed exceptions to close", href: "/staff/exceptions", when: can("exception.close"), count: () => db.exceptionRecord.count({ where: { status: "UNDER_REVIEW" } }) },
  ];
  const wanted = lines.filter((l) => l.when);
  const counts = await Promise.all(wanted.map((l) => l.count()));
  return wanted.map((l, i) => ({ key: l.key, label: l.label, href: l.href, count: counts[i]! })).filter((l) => l.count > 0);
}

export interface SummaryTile {
  key: string;
  label: string;
  value: string;
  note?: string;
  tone: "blue" | "green" | "sky";
}

/**
 * Three headline figures for the staff home, chosen by what the person may
 * read: the loan book for credit roles, membership for the others. Cheap
 * counts and one ledger sum, so the home page stays quick.
 */
export async function staffSummary(db: Db, can: (action: Action) => boolean): Promise<SummaryTile[]> {
  const activeMembers = () => db.member.count({ where: { status: "ACTIVE" } });
  if (can("credit.read")) {
    const [active, members, inReview] = await Promise.all([
      db.loan.findMany({ where: { status: "ACTIVE" }, select: { id: true } }),
      activeMembers(),
      db.loan.count({ where: { status: { in: ["SUBMITTED", "VERIFIED", "RECOMMENDED", "APPROVED", "DISBURSEMENT_PENDING"] } } }),
    ]);
    const outstanding = await ledgerPrincipalOutstanding(db, active.map((l) => l.id));
    const total = [...outstanding.values()].reduce((t, v) => kobo(t + v), ZERO);
    return [
      { key: "active", label: "Active loans", value: active.length.toLocaleString("en-NG"), note: `${inReview.toLocaleString("en-NG")} in review or paying out`, tone: "blue" },
      { key: "principal", label: "Principal outstanding", value: formatNaira(total), note: "On active loans", tone: "green" },
      { key: "members", label: "Active members", value: members.toLocaleString("en-NG"), tone: "sky" },
    ];
  }
  if (can("member.directory.read") || can("invitation.send") || can("users.manage")) {
    const [members, waiting, invited] = await Promise.all([
      activeMembers(),
      db.member.count({ where: { status: "PENDING" } }),
      db.invitation.count({ where: { registeredAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    return [
      { key: "members", label: "Active members", value: members.toLocaleString("en-NG"), tone: "blue" },
      { key: "waiting", label: "Registrations waiting", value: waiting.toLocaleString("en-NG"), note: "For a Loan Officer to activate", tone: "green" },
      { key: "invited", label: "Invitations open", value: invited.toLocaleString("en-NG"), note: "Sent, not yet used", tone: "sky" },
    ];
  }
  return [];
}
