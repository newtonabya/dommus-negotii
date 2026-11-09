import type { Metadata } from "next";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui/form";
import { getDb } from "@/lib/db";
import { todayInLagos } from "@/lib/dates";
import { formatNaira, kobo } from "@/lib/money";
import { listBankAccounts } from "@/modules/credit/banking/bank-accounts";
import { listReclassifications, reclassifiableRows } from "@/modules/credit/refunds/reclassifications";
import { listRefunds } from "@/modules/credit/refunds/refunds";
import { requireStaffPermission } from "@/shell/auth/session";
import { hasPermission } from "@/shell/rbac/permissions";
import {
  approveRefundAction,
  captureRefundAction,
  prepareReclassificationAction,
  prepareRefundVoucherAction,
  rejectRefundAction,
  returnReclassificationAction,
  returnRefundVoucherAction,
  verifyReclassificationAction,
  verifyRefundVoucherAction,
} from "./actions";

export const metadata: Metadata = { title: "Refunds" };

const naira = (v: bigint) => formatNaira(kobo(v));
const day = (d: Date) => d.toISOString().slice(0, 10);
const FILE = "block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-accent/10 file:px-3 file:py-2 file:text-accent";
const STATUS = { REQUESTED: "Waiting for Management", APPROVED: "Approved: waiting for the Cashier's voucher", REJECTED: "Rejected", CANCELLED: "Withdrawn by the member", PAID: "Paid" } as const;

export default async function RefundsPage({ searchParams }: PageProps<"/staff/refunds">) {
  const user = await requireStaffPermission("credit.read");
  const can = (a: Parameters<typeof hasPermission>[1]) => hasPermission(user.assignments, a);
  const q = await searchParams;
  const ok = typeof q.ok === "string" ? q.ok : null;
  const error = typeof q.error === "string" ? q.error : null;
  const loanNo = typeof q.loan === "string" ? q.loan : "";
  const db = getDb();
  const [refunds, reclasses, accounts, lookup] = await Promise.all([
    listRefunds(db),
    listReclassifications(db),
    can("voucher.refund.prepare") ? listBankAccounts(db, true) : Promise.resolve([]),
    loanNo && can("reclassification.prepare") ? reclassifiableRows(db, loanNo) : Promise.resolve(null),
  ]);
  const open = refunds.filter((r) => r.status === "REQUESTED" || r.status === "APPROVED");
  const done = refunds.filter((r) => !open.includes(r));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Refunds of Overpayment Credit</h1>
        <p className="text-sm text-muted">
          A member&apos;s request (in the portal, or signed and captured by a Loan Officer) → Management approves → the Cashier
          makes the transfer and prepares the voucher → the Finance Manager verifies it. Each step is a different person, and the
          credit must still cover the refund at every step.
        </p>
      </div>
      {ok ? <Alert tone="success">{ok}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card title={`In progress (${open.length})`}>
        {open.length === 0 ? <p className="text-sm text-muted">No refunds in progress.</p> : null}
        <ul className="flex flex-col text-sm">
          {open.map((r) => {
            const pending = r.vouchers.find((v) => v.status === "PREPARED");
            const returned = r.vouchers.find((v) => v.status === "RETURNED");
            return (
              <li key={r.id} className="flex flex-col gap-2 border-t border-border py-3 first:border-0">
                <div>
                  <strong className="tabular-nums">{naira(r.amount)}</strong> to {r.member.fullName} ({r.member.memberNo}) · {r.beneficiaryBank} {r.beneficiaryAccountNo} ({r.beneficiaryName})
                  <div className="text-muted">
                    {STATUS[r.status]} · asked {day(r.requestedAt)} {r.channel === "ASSISTED" ? "on a signed form" : "in the portal"}
                    {r.requestEvidenceId ? (
                      <>
                        {" "}
                        ·{" "}
                        <a className="underline" href={`/api/v1/evidence/${r.requestEvidenceId}`} target="_blank" rel="noopener">
                          signed request
                        </a>
                      </>
                    ) : null}
                    {r.note ? ` · "${r.note}"` : ""}
                  </div>
                </div>
                {r.status === "REQUESTED" && can("refund.approve") ? (
                  <div className="flex flex-wrap gap-2">
                    <form action={approveRefundAction.bind(null, r.id)} className="flex gap-2">
                      <Input name="comment" placeholder="Comment (optional)" className="w-48" />
                      <Button type="submit">Approve</Button>
                    </form>
                    <form action={rejectRefundAction.bind(null, r.id)} className="flex gap-2">
                      <Input name="comment" required minLength={5} placeholder="Why not (the member sees it)" className="w-60" />
                      <Button type="submit" variant="danger">
                        Reject
                      </Button>
                    </form>
                  </div>
                ) : null}
                {r.status === "APPROVED" && !pending && can("voucher.refund.prepare") ? (
                  <form action={prepareRefundVoucherAction.bind(null, r.id)} className="grid gap-3 sm:grid-cols-2">
                    {returned ? <p className="text-danger sm:col-span-2">Last voucher returned: {returned.returnReason}</p> : null}
                    <Field label="Paid from">
                      <Select name="bankAccountId" required defaultValue="">
                        <option value="" disabled>
                          Choose…
                        </option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.bankName} {a.accountNumber}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Value date">
                      <Input name="valueDate" type="date" required defaultValue={todayInLagos()} />
                    </Field>
                    <Field label="Transfer reference">
                      <Input name="transferRef" required minLength={3} />
                    </Field>
                    <Field label="Transfer evidence" hint="PDF or image">
                      <input type="file" name="evidence" required accept=".pdf,.jpg,.jpeg,.png" className={FILE} />
                    </Field>
                    <div className="sm:col-span-2">
                      <Button type="submit">Prepare refund voucher</Button>
                    </div>
                  </form>
                ) : null}
                {pending ? (
                  <div className="rounded-lg bg-accent/5 p-3">
                    Voucher {pending.transferRef} · {day(pending.valueDate)} · from {pending.bankAccount.bankName} {pending.bankAccount.accountNumber} ·{" "}
                    <a className="underline" href={`/api/v1/evidence/${pending.evidenceId}`} target="_blank" rel="noopener">
                      transfer evidence
                    </a>
                    {can("voucher.refund.verify") && pending.preparedById !== user.id ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <form action={verifyRefundVoucherAction.bind(null, pending.id)}>
                          <Button type="submit">Verify and post</Button>
                        </form>
                        <form action={returnRefundVoucherAction.bind(null, pending.id)} className="flex gap-2">
                          <Input name="reason" required minLength={5} placeholder="Why it goes back" className="w-56" />
                          <Button type="submit" variant="danger">
                            Return
                          </Button>
                        </form>
                      </div>
                    ) : (
                      <span className="text-muted"> · waiting for the Finance Manager</span>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>

      {can("refund.captureRequest") ? (
        <Card title="Capture a signed refund request">
          <form action={captureRefundAction} className="grid gap-4 sm:grid-cols-2">
            <Field label="Member" hint="Member number (MCS-…) or MOAUM ID">
              <Input name="member" required />
            </Field>
            <Field label="Amount (₦)">
              <Input name="amount" required inputMode="decimal" />
            </Field>
            <Field label="Account holder's name">
              <Input name="beneficiaryName" required minLength={3} />
            </Field>
            <Field label="Bank">
              <Input name="beneficiaryBank" required minLength={2} />
            </Field>
            <Field label="Account number" hint="10 digits">
              <Input name="beneficiaryAccountNo" required inputMode="numeric" pattern="\d{10}" />
            </Field>
            <Field label="Signed request" hint="PDF or image">
              <input type="file" name="request" required accept=".pdf,.jpg,.jpeg,.png" className={FILE} />
            </Field>
            <div className="sm:col-span-2">
              <Button type="submit">Capture request</Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card title="Refund a prepayment instead of reducing the loan">
        <p className="mb-3 text-sm text-muted">
          When a member paid more than was due and asks for the extra back (before the next regular schedule for their payroll
          posts), the Treasurer moves it to Overpayment Credit and the Finance Manager verifies. The loan is recomputed as if that
          part had never been paid; the refund then follows the steps above.
        </p>
        {can("reclassification.prepare") ? (
          <div className="flex flex-col gap-3">
            <form className="flex flex-wrap items-end gap-2">
              <Field label="Loan number">
                <Input name="loan" defaultValue={loanNo} placeholder="CSS-2026-00001" className="w-48" />
              </Field>
              <Button type="submit" variant="secondary">
                Find repayments
              </Button>
            </form>
            {loanNo && !lookup ? <p className="text-sm text-danger">No loan {loanNo}.</p> : null}
            {lookup ? (
              lookup.repayments.length === 0 ? (
                <p className="text-sm text-muted">No repayment on {lookup.loan.loanAccountNo} went to principal.</p>
              ) : (
                <form action={prepareReclassificationAction} className="grid gap-3 sm:grid-cols-2">
                  <Field label="Repayment">
                    <Select name="rowId" required defaultValue="">
                      <option value="" disabled>
                        Choose…
                      </option>
                      {lookup.repayments.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.date} · {naira(r.amount)} (principal {naira(r.principal)}) · {r.reference}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Amount to move (₦)">
                    <Input name="amount" required inputMode="decimal" />
                  </Field>
                  <Field label="Reason">
                    <Input name="reason" required minLength={10} />
                  </Field>
                  <Field label="Member's request" hint="PDF or image">
                    <input type="file" name="request" required accept=".pdf,.jpg,.jpeg,.png" className={FILE} />
                  </Field>
                  <div className="sm:col-span-2">
                    <Button type="submit">Prepare</Button>
                  </div>
                </form>
              )
            ) : null}
          </div>
        ) : null}
        {reclasses.length ? (
          <ul className="mt-4 text-sm">
            {reclasses.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2 first:border-0">
                <span>
                  {naira(x.amount)} from {x.row.member.fullName}&apos;s repayment of {day(x.row.paymentDate)} on {x.row.loan?.loanAccountNo ?? x.row.loan?.legacyAccountNo} ({x.row.schedule.scheduleReference}) ·{" "}
                  <span className="text-muted">{x.status === "PREPARED" ? "waiting for the Finance Manager" : x.status === "VERIFIED" ? "verified" : `returned: ${x.returnComment}`}</span>
                </span>
                {x.status === "PREPARED" && can("reclassification.verify") && x.preparedById !== user.id ? (
                  <span className="flex flex-wrap gap-2">
                    <form action={verifyReclassificationAction.bind(null, x.id)}>
                      <Button type="submit">Verify</Button>
                    </form>
                    <form action={returnReclassificationAction.bind(null, x.id)} className="flex gap-2">
                      <Input name="comment" required minLength={5} placeholder="Why" className="w-40" />
                      <Button type="submit" variant="danger">
                        Return
                      </Button>
                    </form>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card title="Decided">
        {done.length === 0 ? <p className="text-sm text-muted">None yet.</p> : null}
        <ul className="text-sm tabular-nums">
          {done.map((r) => (
            <li key={r.id} className="border-t border-border py-2 first:border-0">
              {naira(r.amount)} · {r.member.fullName} ({r.member.memberNo}) · {STATUS[r.status]}
              {r.paidAt ? ` on ${day(r.paidAt)}` : ""}
              {r.decisionComment && r.status === "REJECTED" ? <span className="text-muted"> · {r.decisionComment}</span> : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
