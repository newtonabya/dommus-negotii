import { STATUS_LABEL, type LoanStatus } from "@/modules/credit/domain/loan-status";

const TONE: Record<LoanStatus, string> = {
  DRAFT: "bg-background text-muted",
  SUBMITTED: "bg-accent/10 text-accent",
  VERIFIED: "bg-accent/10 text-accent",
  RECOMMENDED: "bg-accent/10 text-accent",
  APPROVED: "bg-accent/10 text-accent",
  DISBURSEMENT_PENDING: "bg-accent/10 text-accent",
  ACTIVE: "bg-success/10 text-success",
  CLOSED: "bg-background text-muted",
  DECLINED: "bg-danger/10 text-danger",
  REJECTED: "bg-danger/10 text-danger",
  CANCELLED: "bg-background text-muted",
};

/** Loan status as a word, never colour alone. */
export function LoanStatusBadge({ status }: { status: LoanStatus }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONE[status]}`}>{STATUS_LABEL[status]}</span>;
}
