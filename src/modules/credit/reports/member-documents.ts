import { createHmac, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import type { Db } from "@/lib/db";
import { todayInLagos, type LocalDate } from "@/lib/dates";
import { formatNaira, kobo } from "@/lib/money";
import { PdfWriter } from "@/lib/pdf";
import { STATUS_LABEL } from "../domain/loan-status";
import { loanTerms } from "../loans/common";
import { overpaymentCredit } from "../loans/queries";
import { loanLiveState } from "../loans/repayments";
import { payoffQuote } from "../domain/recompute";

const naira = (v: bigint) => formatNaira(kobo(v));
const day = (d: Date) => d.toISOString().slice(0, 10);
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}% per month`;

export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentError";
  }
}

// ───────────────────────────── Receipts ─────────────────────────────

function receiptSecret(): string {
  const secret = process.env.RECEIPT_SECRET ?? process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("RECEIPT_SECRET or BETTER_AUTH_SECRET is needed to sign receipts");
  return secret;
}

/** The receipt's checksum: an HMAC of the row id, so only the system can issue a genuine one. */
export function receiptCode(rowId: string): string {
  return createHmac("sha256", receiptSecret()).update(`receipt:${rowId}`).digest("base64url").slice(0, 12);
}

/** Receipt number shown on the receipt: the schedule reference and the row. */
export const receiptNumber = (scheduleReference: string, rowNo: number) => `RC-${scheduleReference}-${String(rowNo).padStart(3, "0")}`;

export const receiptToken = (rowId: string) => `${rowId}.${receiptCode(rowId)}`;

export function receiptUrl(rowId: string): string {
  const base = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/verify/${receiptToken(rowId)}`;
}

/** "Amina Bello" → "A***a B***o": enough to recognise, not enough to identify. */
export function maskName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => (w.length <= 2 ? `${w[0] ?? ""}*` : `${w[0]}${"*".repeat(Math.min(3, w.length - 2))}${w.at(-1)}`))
    .join(" ");
}

/**
 * What the public verification page may show for a receipt token (PRD F13):
 * genuine or not, number, amount, date and a masked name. Nothing else.
 */
export async function verifyReceipt(db: Db, token: string) {
  const [rowId, code] = token.split(".");
  if (!rowId || !code || !UUID.test(rowId)) return { genuine: false as const };
  const expected = Buffer.from(receiptCode(rowId));
  const given = Buffer.from(code);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { genuine: false as const };
  const row = await db.remittanceRow.findUnique({
    where: { id: rowId },
    include: { schedule: { select: { scheduleReference: true } }, member: { select: { fullName: true } } },
  });
  if (!row) return { genuine: false as const };
  return {
    genuine: true as const,
    number: receiptNumber(row.schedule.scheduleReference, row.rowNo),
    amount: naira(row.amount),
    date: day(row.paymentDate),
    member: maskName(row.member.fullName),
    reversed: row.reversedAt !== null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadRow(db: Db, rowId: string) {
  if (!UUID.test(rowId)) throw new DocumentError("Repayment not found.");
  const row = await db.remittanceRow.findUnique({
    where: { id: rowId },
    include: {
      schedule: { select: { scheduleReference: true, monthCovered: true, postedAt: true, remittanceSource: { select: { code: true, name: true } } } },
      member: { select: { id: true, userId: true, fullName: true, memberNo: true } },
      loan: { select: { loanAccountNo: true, legacyAccountNo: true } },
    },
  });
  if (!row) throw new DocumentError("Repayment not found.");
  return row;
}

/** Who may download a document: the member it belongs to, or staff who can read credit records. */
export async function rowOwner(db: Db, rowId: string) {
  return (await loadRow(db, rowId)).member.userId;
}

/** PDF receipt for one posted repayment row, with a QR code to the verification page. */
export async function receiptPdf(db: Db, rowId: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const row = await loadRow(db, rowId);
  const number = receiptNumber(row.schedule.scheduleReference, row.rowNo);
  const pdf = await PdfWriter.create(`Receipt ${number}`);
  pdf.title("Repayment receipt", `MOAUM Credit Super Store · receipt ${number}`);
  pdf.facts([
    ["Receipt number", number],
    ["Member", `${row.member.fullName} (${row.member.memberNo})`],
    ["Amount", naira(row.amount)],
    ["Payment date", day(row.paymentDate)],
    ["Paid through", row.rowType === "DIRECT" ? "Direct payment to MOAUM's bank" : `${row.schedule.remittanceSource.name} payroll`],
    ["Schedule", `${row.schedule.scheduleReference} (${row.schedule.monthCovered})`],
    ["Applied to", row.toCredit || !row.loan ? "Overpayment Credit" : `Loan ${row.loan.loanAccountNo ?? row.loan.legacyAccountNo}`],
    ["Posted", day(row.schedule.postedAt)],
    ...(row.reversedAt ? ([["Status", `Reversed by a correction on ${day(row.reversedAt)}`]] as Array<[string, string]>) : []),
  ]);
  const url = receiptUrl(row.id);
  const png = await QRCode.toBuffer(url, { type: "png", margin: 1, width: 240, errorCorrectionLevel: "M" });
  await pdf.image(new Uint8Array(png), 110);
  pdf.paragraph(`Scan the code, or open ${url}, to check this receipt is genuine. Checksum ${receiptCode(row.id)}.`, 8, true);
  return { bytes: await pdf.bytes(), filename: `receipt-${number}.pdf` };
}

// ───────────────────────────── Loan statement and payoff quote ─────────────────────────────

async function loadLoan(db: Db, loanId: string) {
  if (!UUID.test(loanId)) throw new DocumentError("Loan not found.");
  const loan = await db.loan.findUnique({ where: { id: loanId }, include: { member: { select: { id: true, userId: true, fullName: true, memberNo: true } } } });
  if (!loan) throw new DocumentError("Loan not found.");
  return loan;
}

export async function loanOwner(db: Db, loanId: string) {
  return (await loadLoan(db, loanId)).member.userId;
}

/**
 * The member's loan statement (PRD F13): terms, the schedule as it stands,
 * every payment with its split and receipt number, provisional current-cycle
 * interest, balances and Overpayment Credit.
 */
export async function loanStatementPdf(db: Db, loanId: string, asOf: LocalDate = todayInLagos()) {
  const loan = await loadLoan(db, loanId);
  const live = await loanLiveState(db, loan, asOf);
  if (!live) throw new DocumentError("A statement is available once the loan has been paid out.");
  const rows = await db.remittanceRow.findMany({
    where: { loanId: loan.id, toCredit: false, reversedAt: null },
    include: { schedule: { select: { scheduleReference: true } } },
  });
  const numbers = new Map(rows.map((r) => [r.id, receiptNumber(r.schedule.scheduleReference, r.rowNo)]));
  const credit = await overpaymentCredit(db, loan.memberId);
  const { state } = live;
  const no = loan.loanAccountNo ?? loan.legacyAccountNo ?? "loan";

  const pdf = await PdfWriter.create(`Loan statement ${no}`);
  pdf.title("Loan statement", `${loan.member.fullName} (${loan.member.memberNo}) · loan ${no} · as at ${asOf}`);
  pdf.facts([
    ["Status", STATUS_LABEL[loan.status]],
    ["Approved", `${naira(loan.amountApproved ?? 0n)} over ${loan.tenureApproved} months`],
    ["Interest", `${pct(loan.rateBps ?? 0)} on the reducing balance`],
    ["Paid out", loan.d0 ? day(loan.d0) : "-"],
    ["Principal outstanding", naira(state.outstandingPrincipal)],
    ["Overdue", state.principalArrears + state.interestArrears > 0n ? `${naira(state.principalArrears)} principal + ${naira(state.interestArrears)} interest` : "Nothing overdue"],
    ["Interest charged / paid", `${naira(state.interestCharged)} / ${naira(state.interestPaid)}`],
    ["Overpayment Credit (all loans)", naira(credit)],
    ...(state.closedOn ? ([["Closed", `Repaid in full on ${state.closedOn}`]] as Array<[string, string]>) : []),
    ...(live.payoff ? ([["To pay off", `${naira(live.payoff.amount)} if paid by ${live.payoff.validUntil}`]] as Array<[string, string]>) : []),
  ]);

  pdf.heading("Schedule as it stands");
  pdf.table(
    [
      { header: "#", width: 0.5 },
      { header: "Due", width: 1.4 },
      { header: "Principal", width: 1.5, align: "right" },
      { header: "Principal paid", width: 1.5, align: "right" },
      { header: "Interest", width: 1.5, align: "right" },
      { header: "Interest paid", width: 1.5, align: "right" },
    ],
    state.installments.map((i) => [
      String(i.k),
      i.dueDate,
      naira(i.principal),
      naira(i.principalPaid),
      `${naira(i.interest)}${i.provisional ? " *" : ""}`,
      naira(i.interestPaid),
    ]),
  );
  if (state.installments.some((i) => i.provisional)) {
    pdf.paragraph("* Provisional: this cycle's interest can still go down if a catch-up payment dated inside the cycle arrives.", 8, true);
  }

  pdf.heading("Payments");
  if (live.repayments.length === 0) pdf.paragraph("No payments yet.", 9.5, true);
  else {
    pdf.table(
      [
        { header: "Date", width: 1.3 },
        { header: "Receipt", width: 2.4 },
        { header: "Amount", width: 1.4, align: "right" },
        { header: "Interest", width: 1.3, align: "right" },
        { header: "Principal", width: 1.3, align: "right" },
        { header: "To credit", width: 1.2, align: "right" },
      ],
      [
        ...live.repayments.map((r) => [r.date, numbers.get(r.id) ?? r.reference, naira(r.amount), naira(r.interest), naira(r.principal), naira(r.credit)]),
        [
          "Total",
          "",
          naira(live.repayments.reduce((t, r) => t + r.amount, 0n)),
          naira(live.repayments.reduce((t, r) => t + r.interest, 0n)),
          naira(live.repayments.reduce((t, r) => t + r.principal, 0n)),
          naira(live.repayments.reduce((t, r) => t + r.credit, 0n)),
        ],
      ],
      { totalRow: true },
    );
  }
  return { bytes: await pdf.bytes(), filename: `statement-${no}-${asOf}.pdf` };
}

/** Payoff quote (PRD F6, F13) for a payment made on `on`. */
export async function payoffQuotePdf(db: Db, loanId: string, on: LocalDate = todayInLagos()) {
  const loan = await loadLoan(db, loanId);
  if (loan.status !== "ACTIVE" || !loan.d0) throw new DocumentError("A payoff quote is only for an active loan.");
  const payments = (await db.remittanceRow.findMany({ where: { loanId: loan.id, toCredit: false, reversedAt: null }, include: { schedule: { select: { postedAt: true } } } })).map((r) => ({
    id: r.id,
    date: day(r.paymentDate) as LocalDate,
    amount: kobo(r.amount),
    order: `${r.schedule.postedAt.toISOString()}|${String(r.rowNo).padStart(6, "0")}`,
  }));
  const quote = payoffQuote(loanTerms(loan), payments, on);
  if (!quote) throw new DocumentError("This loan is already repaid.");
  const no = loan.loanAccountNo ?? loan.legacyAccountNo ?? "loan";
  const pdf = await PdfWriter.create(`Payoff quote ${no}`);
  pdf.title("Payoff quote", `${loan.member.fullName} (${loan.member.memberNo}) · loan ${no} · issued ${on}`);
  pdf.facts([
    ["Amount to pay off", naira(quote.amount)],
    ["Of which principal", naira(quote.principal)],
    ["Of which interest", naira(quote.interest)],
    ["Valid if paid by", quote.validUntil],
  ]);
  pdf.paragraph(
    "This is exactly what closes the loan if it reaches MOAUM on or before the date above. After that date another cycle's interest is due and a new quote is needed. Any amount paid above it becomes Overpayment Credit, which is refunded on request.",
    9,
    true,
  );
  return { bytes: await pdf.bytes(), filename: `payoff-quote-${no}-${on}.pdf`, quote };
}
