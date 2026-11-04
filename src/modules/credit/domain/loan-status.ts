/**
 * Loan states and who may move a loan between them (PRD F7). Pure: used by the
 * server to refuse a transition and by the UI to decide which buttons to show.
 */
export const LOAN_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "VERIFIED",
  "RECOMMENDED",
  "APPROVED",
  "DISBURSEMENT_PENDING",
  "ACTIVE",
  "CLOSED",
  "DECLINED",
  "REJECTED",
  "CANCELLED",
] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

/** An open loan counts towards the borrowing and guarantee limits. */
export const OPEN_STATUSES: readonly LoanStatus[] = ["SUBMITTED", "VERIFIED", "RECOMMENDED", "APPROVED", "DISBURSEMENT_PENDING", "ACTIVE"];

/** Who acts: a permission action, or the system itself. */
export type LoanActor =
  | "self.loan.apply"
  | "loan.application.captureAssisted"
  | "loan.verify"
  | "loan.recommend"
  | "loan.decline"
  | "loan.approve"
  | "loan.reject"
  | "loan.cancelApproved"
  | "voucher.disbursement.prepare"
  | "voucher.disbursement.verify"
  | "system";

interface Transition {
  from: LoanStatus | null;
  to: LoanStatus;
  by: LoanActor;
}

export const TRANSITIONS: readonly Transition[] = [
  { from: null, to: "DRAFT", by: "self.loan.apply" },
  { from: "DRAFT", to: "SUBMITTED", by: "self.loan.apply" },
  { from: null, to: "SUBMITTED", by: "loan.application.captureAssisted" },
  { from: "SUBMITTED", to: "VERIFIED", by: "loan.verify" },
  { from: "VERIFIED", to: "RECOMMENDED", by: "loan.recommend" },
  { from: "SUBMITTED", to: "DECLINED", by: "loan.decline" },
  { from: "VERIFIED", to: "DECLINED", by: "loan.decline" },
  { from: "RECOMMENDED", to: "APPROVED", by: "loan.approve" },
  { from: "RECOMMENDED", to: "REJECTED", by: "loan.reject" },
  { from: "APPROVED", to: "DISBURSEMENT_PENDING", by: "voucher.disbursement.prepare" },
  { from: "DISBURSEMENT_PENDING", to: "ACTIVE", by: "voucher.disbursement.verify" },
  { from: "DISBURSEMENT_PENDING", to: "APPROVED", by: "voucher.disbursement.verify" },
  { from: "DRAFT", to: "CANCELLED", by: "self.loan.apply" },
  { from: "SUBMITTED", to: "CANCELLED", by: "self.loan.apply" },
  { from: "APPROVED", to: "CANCELLED", by: "loan.cancelApproved" },
  { from: "ACTIVE", to: "CLOSED", by: "system" },
  { from: "CLOSED", to: "ACTIVE", by: "system" },
  { from: null, to: "ACTIVE", by: "system" },
];

export function canTransition(from: LoanStatus | null, to: LoanStatus, by: LoanActor): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.by === by);
}

/** What `by` may do with a loan in status `from`. */
export function nextStatuses(from: LoanStatus, by: LoanActor): LoanStatus[] {
  return TRANSITIONS.filter((t) => t.from === from && t.by === by).map((t) => t.to);
}

export const STATUS_LABEL: Record<LoanStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  VERIFIED: "Verified",
  RECOMMENDED: "Recommended",
  APPROVED: "Approved",
  DISBURSEMENT_PENDING: "Disbursement pending",
  ACTIVE: "Active",
  CLOSED: "Closed",
  DECLINED: "Declined",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};
