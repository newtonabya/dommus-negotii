import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LoanStatusBadge } from "@/components/loans/status-badge";
import { Alert, Button, Card, Field, Input } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { bps, formatNaira, kobo } from "@/lib/money";
import { listBankAccounts } from "@/modules/credit/banking/bank-accounts";
import { STATUS_LABEL } from "@/modules/credit/domain/loan-status";
import { planSchedule } from "@/modules/credit/domain/schedule";
import { exposurePanel, loanDetail } from "@/modules/credit/loans/queries";
import { requireStaffPermission } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import { formatPercent } from "@/shell/settings/definitions";
import { getRateSetting } from "@/shell/settings/settings";
import {
  approveLoanAction,
  cancelApprovedLoanAction,
  declineLoanAction,
  recommendLoanAction,
  rejectLoanAction,
  returnVoucherAction,
  verifyLoanAction,
  verifyVoucherAction,
} from "./actions";
import { VoucherForm } from "./voucher-form";

export const metadata: Metadata = { title: "Loan" };

const naira = (v: bigint | string) => formatNaira(kobo(BigInt(v)));
const when = (d: Date) => d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" });
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");

interface ScheduleRow {
  k: number;
  dueDate: string;
  principal: string;
  interest: string;
  amount: string;
}

function ScheduleTable({ rows, total, interest, indicative }: { rows: ScheduleRow[]; total: string; interest: string; indicative: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {indicative ? <p className="text-sm text-muted">Indicative: paid on time from today. The binding schedule is fixed when the loan is paid out.</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-sm tabular-nums">
          <thead className="text-xs text-muted uppercase">
            <tr>
              <th className="py-1 pr-3">#</th>
              <th className="py-1 pr-3">Due</th>
              <th className="py-1 pr-3 text-right">Principal</th>
              <th className="py-1 pr-3 text-right">Interest</th>
              <th className="py-1 text-right">Instalment</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k} className="border-t border-border">
                <td className="py-1 pr-3">{r.k}</td>
                <td className="py-1 pr-3">{r.dueDate}</td>
                <td className="py-1 pr-3 text-right">{naira(r.principal)}</td>
                <td className="py-1 pr-3 text-right">{naira(r.interest)}</td>
                <td className="py-1 text-right font-medium">{naira(r.amount)}</td>
              </tr>
            ))}
            <tr className="border-t border-border font-semibold">
              <td className="py-1" colSpan={3}>
                Total
              </td>
              <td className="py-1 pr-3 text-right">{naira(interest)}</td>
              <td className="py-1 text-right">{naira(total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default async function LoanPage({ params, searchParams }: PageProps<"/staff/loans/[id]">) {
  const user = await requireStaffPermission("credit.read");
  const { id } = await params;
  const { ok, error } = await searchParams;
  const db = getDb();
  const loan = await loanDetail(db, id);
  if (!loan) notFound();
  const can = (a: Parameters<typeof hasPermission>[1]) => hasPermission(user.assignments, a);
  const own = loan.member.userId === user.id;
  const today = todayInLagos();
  const [exposure, accounts, rate] = await Promise.all([
    can("loan.verify") || can("loan.approve") ? exposurePanel(db, loan.id) : null,
    can("voucher.disbursement.prepare") && loan.status === "APPROVED" ? listBankAccounts(db, true) : [],
    getRateSetting(db, "interest_rate_bps", today),
  ]);
  const pending = loan.vouchers.find((v) => v.status === "PREPARED");

  const binding = loan.bindingSchedule as { installments: ScheduleRow[]; total: string; totalInterest: string } | null;
  const indicative = binding
    ? null
    : planSchedule({
        principal: kobo(loan.amountApproved ?? loan.amountRequested),
        tenure: loan.tenureApproved ?? loan.tenureRequested,
        rate: loan.rateBps !== null ? bps(BigInt(loan.rateBps)) : rate,
        d0: today,
      });
  const commentBox = (name = "comment", required = false, placeholder = "Comment") => (
    <Input name={name} required={required} minLength={required ? 5 : undefined} placeholder={placeholder} className="min-w-56 flex-1" />
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/staff/loans" className="text-sm underline">
            ← Loans
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">
            <span className="font-mono">{loan.loanAccountNo ?? "Draft"}</span> <LoanStatusBadge status={loan.status} />
          </h1>
          <p className="text-sm text-muted">
            {loan.member.fullName} · {loan.member.moaumIdNumber} · {loan.member.phone}
            {loan.assisted ? " · paper application" : ""}
          </p>
        </div>
      </div>
      {typeof ok === "string" ? <Alert tone="success">{ok}</Alert> : null}
      {typeof error === "string" ? <Alert tone="error">{error}</Alert> : null}
      {own ? <Alert tone="error">This is your own loan: you can see it, but every action on it must be taken by someone else.</Alert> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Terms">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm tabular-nums">
            <dt className="text-muted">Requested</dt>
            <dd>
              {naira(loan.amountRequested)} over {loan.tenureRequested} months
            </dd>
            <dt className="text-muted">Approved</dt>
            <dd>{loan.amountApproved !== null ? `${naira(loan.amountApproved)} over ${loan.tenureApproved} months` : "—"}</dd>
            <dt className="text-muted">Rate</dt>
            <dd>{loan.rateBps !== null ? `${formatPercent(bps(BigInt(loan.rateBps)))} per month (fixed at approval)` : "Set at approval"}</dd>
            <dt className="text-muted">Disbursed</dt>
            <dd>{day(loan.d0)}</dd>
            <dt className="text-muted">Purpose</dt>
            <dd>{loan.purpose}</dd>
            {loan.applicationEvidenceId ? (
              <>
                <dt className="text-muted">Signed application</dt>
                <dd>
                  <a href={`/api/v1/evidence/${loan.applicationEvidenceId}`} target="_blank" rel="noopener" className="underline">
                    Open form
                  </a>
                </dd>
              </>
            ) : null}
            <dt className="text-muted">KYC</dt>
            <dd>{loan.member.idScanEvidenceId ? <a href={`/api/v1/evidence/${loan.member.idScanEvidenceId}`} target="_blank" rel="noopener" className="underline">ID card scan</a> : <span className="text-danger">ID scan missing</span>}</dd>
          </dl>
        </Card>

        <Card title="Guarantor">
          {loan.guarantor ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
              <dt className="text-muted">Name</dt>
              <dd>{loan.guarantor.fullName}</dd>
              <dt className="text-muted">Member?</dt>
              <dd>{loan.guarantor.moaumIdNumber ? `Yes · ${loan.guarantor.moaumIdNumber}` : "No"}</dd>
              <dt className="text-muted">Phone</dt>
              <dd>{loan.guarantor.phone}</dd>
              <dt className="text-muted">Address</dt>
              <dd>{loan.guarantor.address}</dd>
              <dt className="text-muted">Relationship</dt>
              <dd>{loan.guarantor.relationship}</dd>
              <dt className="text-muted">Signed form</dt>
              <dd>
                {loan.guarantor.formEvidenceId ? (
                  <a href={`/api/v1/evidence/${loan.guarantor.formEvidenceId}`} target="_blank" rel="noopener" className="underline">
                    Open form
                  </a>
                ) : (
                  <span className="text-danger">Not uploaded</span>
                )}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-muted">None yet.</p>
          )}
        </Card>
      </div>

      {exposure ? (
        <Card title="Exposure">
          <div className="grid gap-4 sm:grid-cols-2 text-sm tabular-nums">
            <div>
              <div className="font-medium">Applicant</div>
              <p>
                Open loans: <strong>{exposure.applicant.openCount}</strong> of {exposure.applicant.maxOpen} allowed
                {exposure.applicant.openCount >= exposure.applicant.maxOpen ? <span className="text-danger"> · at the limit</span> : null}
              </p>
              <p>Outstanding principal: {formatNaira(exposure.applicant.outstandingPrincipal)}</p>
              <p>Overpayment Credit: {formatNaira(exposure.applicant.overpaymentCredit)}</p>
              <p className="text-muted">
                History: {exposure.applicant.history.closed} closed · {exposure.applicant.history.declinedOrRejected} declined or rejected ·{" "}
                {exposure.applicant.history.cancelled} cancelled
              </p>
              <p className="text-muted">Arrears appear here once repayments are posted.</p>
              <ul className="mt-2">
                {exposure.applicant.loans.map((l) => (
                  <li key={l.id}>
                    <span className="font-mono">{l.loanAccountNo ?? "—"}</span> {STATUS_LABEL[l.status]} · {formatNaira(kobo(l.amountApproved ?? l.amountRequested))}
                    {l.status === "ACTIVE" ? ` · ${formatNaira(l.outstanding)} outstanding` : ""}
                  </li>
                ))}
              </ul>
            </div>
            {exposure.guarantor ? (
              <div>
                <div className="font-medium">Guarantor · {exposure.guarantor.name}</div>
                <p>
                  Open guarantees: <strong>{exposure.guarantor.openGuarantees}</strong> of {exposure.guarantor.maxGuarantees} allowed (this loan included)
                </p>
                <p>Outstanding principal guaranteed: {formatNaira(exposure.guarantor.outstandingPrincipal)}</p>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {!own ? (
        <>
          {can("loan.verify") && loan.status === "SUBMITTED" ? (
            <Card title="Verify KYC and guarantor">
              <form action={verifyLoanAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="id" value={loan.id} />
                {commentBox("comment", false, "What you checked (optional)")}
                <Button type="submit">Mark verified</Button>
              </form>
            </Card>
          ) : null}
          {can("loan.recommend") && loan.status === "VERIFIED" ? (
            <Card title="Recommend to Management">
              <form action={recommendLoanAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="id" value={loan.id} />
                {commentBox("comment", true, "Your recommendation")}
                <Button type="submit">Recommend</Button>
              </form>
            </Card>
          ) : null}
          {can("loan.decline") && (loan.status === "SUBMITTED" || loan.status === "VERIFIED") ? (
            <form action={declineLoanAction} className="flex flex-wrap gap-2">
              <input type="hidden" name="id" value={loan.id} />
              {commentBox("comment", true, "Reason for declining (the member sees it)")}
              <Button type="submit" variant="danger">
                Decline
              </Button>
            </form>
          ) : null}

          {can("loan.approve") && loan.status === "RECOMMENDED" ? (
            <Card title="Approve">
              <form action={approveLoanAction} className="grid gap-4 sm:grid-cols-3">
                <input type="hidden" name="id" value={loan.id} />
                <Field label="Amount (₦)" hint={`Up to ${naira(loan.amountRequested)}`}>
                  <Input name="amount" required defaultValue={(loan.amountRequested / 100n).toString()} inputMode="decimal" />
                </Field>
                <Field label="Tenure (months)">
                  <Input name="tenure" type="number" min={1} max={12} required defaultValue={loan.tenureRequested} />
                </Field>
                <Field label="Comment (optional)">
                  <Input name="comment" />
                </Field>
                <p className="text-sm text-muted sm:col-span-3">The rate in force today ({formatPercent(rate)} per month) is fixed on the loan. Limits are checked again.</p>
                <div className="sm:col-span-3">
                  <Button type="submit">Approve</Button>
                </div>
              </form>
              <form action={rejectLoanAction} className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
                <input type="hidden" name="id" value={loan.id} />
                {commentBox("comment", true, "Reason for rejecting (the member sees it)")}
                <Button type="submit" variant="danger">
                  Reject
                </Button>
              </form>
            </Card>
          ) : null}
          {can("loan.cancelApproved") && loan.status === "APPROVED" ? (
            <form action={cancelApprovedLoanAction} className="flex flex-wrap gap-2">
              <input type="hidden" name="id" value={loan.id} />
              {commentBox("comment", true, "Reason for cancelling the approved loan")}
              <Button type="submit" variant="danger">
                Cancel approved loan
              </Button>
            </form>
          ) : null}

          {can("voucher.disbursement.prepare") && loan.status === "APPROVED" ? (
            <Card title="Disbursement voucher">
              <VoucherForm
                loanId={loan.id}
                amount={naira(loan.amountApproved ?? 0n)}
                today={today}
                member={loan.member.fullName}
                accounts={accounts.map((a) => ({ id: a.id, label: `${a.bankName} · ${a.accountNumber}` }))}
              />
            </Card>
          ) : null}
          {can("voucher.disbursement.verify") && pending ? (
            <Card title="Verify the disbursement voucher">
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm tabular-nums">
                <dt className="text-muted">Amount</dt>
                <dd>{naira(pending.amount)}</dd>
                <dt className="text-muted">From</dt>
                <dd>
                  {pending.bankAccount.bankName} · {pending.bankAccount.accountNumber}
                </dd>
                <dt className="text-muted">To</dt>
                <dd>
                  {pending.beneficiaryName} · {pending.beneficiaryBank} · {pending.beneficiaryAccountNo}
                </dd>
                <dt className="text-muted">Value date</dt>
                <dd>{day(pending.valueDate)}</dd>
                <dt className="text-muted">Reference</dt>
                <dd>{pending.transferRef}</dd>
                <dt className="text-muted">Evidence</dt>
                <dd>
                  <a href={`/api/v1/evidence/${pending.evidenceId}`} target="_blank" rel="noopener" className="underline">
                    Open transfer evidence
                  </a>
                </dd>
                <dt className="text-muted">Prepared by</dt>
                <dd>
                  {pending.preparedByName}, {when(pending.preparedAt)}
                </dd>
              </dl>
              {pending.preparedById === user.id ? (
                <p className="text-sm text-muted">You prepared this voucher, so someone else must verify it.</p>
              ) : (
                <div className="mt-4 flex flex-wrap gap-3 border-t border-border pt-4">
                  <form action={verifyVoucherAction}>
                    <input type="hidden" name="id" value={loan.id} />
                    <input type="hidden" name="voucherId" value={pending.id} />
                    <Button type="submit">Verify and activate the loan</Button>
                  </form>
                  <form action={returnVoucherAction} className="flex flex-1 flex-wrap gap-2">
                    <input type="hidden" name="id" value={loan.id} />
                    <input type="hidden" name="voucherId" value={pending.id} />
                    {commentBox("reason", true, "Why it is returned")}
                    <Button type="submit" variant="danger">
                      Return
                    </Button>
                  </form>
                </div>
              )}
            </Card>
          ) : null}
        </>
      ) : null}

      <Card title={binding ? "Binding schedule" : "Schedule"}>
        {binding ? (
          <ScheduleTable rows={binding.installments} total={binding.total} interest={binding.totalInterest} indicative={false} />
        ) : indicative ? (
          <ScheduleTable
            rows={indicative.installments.map((i) => ({ k: i.k, dueDate: i.dueDate, principal: i.principal.toString(), interest: i.interest.toString(), amount: i.amount.toString() }))}
            total={indicative.total.toString()}
            interest={indicative.totalInterest.toString()}
            indicative
          />
        ) : null}
      </Card>

      {loan.vouchers.length > 0 ? (
        <Card title="Vouchers">
          <ul className="text-sm">
            {loan.vouchers.map((v) => (
              <li key={v.id} className="border-t border-border py-2 first:border-0">
                <strong>{v.status}</strong> · {naira(v.amount)} · {v.transferRef} · value {day(v.valueDate)} · prepared by {v.preparedByName}
                {v.verifiedByName ? ` · ${v.status === "RETURNED" ? "returned" : "verified"} by ${v.verifiedByName}` : ""}
                {v.returnReason ? <div className="text-danger">Returned: {v.returnReason}</div> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="History">
        <ol className="text-sm">
          {loan.transitions.map((t) => (
            <li key={t.id} className="border-t border-border py-2 first:border-0">
              <strong>{STATUS_LABEL[t.toStatus]}</strong> · {t.byName} · {when(t.at)}
              {t.comment ? <div className="text-muted">{t.comment}</div> : null}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
