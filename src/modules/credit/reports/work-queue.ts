import type { Db } from "@/lib/db";
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
