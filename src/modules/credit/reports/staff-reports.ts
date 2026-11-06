import ExcelJS from "exceljs";
import type { Db } from "@/lib/db";
import { compareDates, localDate, todayInLagos, type LocalDate } from "@/lib/dates";
import { formatNaira, kobo } from "@/lib/money";
import { PdfWriter, type Column } from "@/lib/pdf";
import type { Action } from "@/shell/rbac/permissions";
import { ageingReport } from "../banking/matching";
import { ledgerPrincipalOutstanding } from "../loans/queries";
import { loanLiveState } from "../loans/repayments";
import { monthsBack } from "./dashboard";

/**
 * Staff reports (PRD F13). Each report is built once as rows of typed cells and
 * rendered three ways: on screen, Excel and PDF. Money is kept in kobo until
 * it is displayed.
 */
export type Cell = string | number | bigint | null;
export interface ReportColumn {
  header: string;
  kind: "text" | "money" | "count" | "date";
  width: number;
}
export interface ReportResult {
  title: string;
  subtitle: string;
  columns: ReportColumn[];
  rows: Cell[][];
  /** A totals row, when the report has one. */
  totals: Cell[] | null;
  notes: string[];
}
export interface Period {
  from: LocalDate;
  to: LocalDate;
}

interface ReportDef {
  key: string;
  title: string;
  description: string;
  permission: Action;
  usesPeriod: boolean;
  landscape?: boolean;
  build: (db: Db, period: Period) => Promise<ReportResult>;
}

const toDb = (d: LocalDate) => new Date(`${d}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);
const sumCol = (rows: Cell[][], i: number) => rows.reduce<bigint>((t, r) => t + (typeof r[i] === "bigint" ? (r[i] as bigint) : 0n), 0n);
const periodText = (p: Period) => `${p.from} to ${p.to}`;
const monthsIn = (p: Period) => monthsBack(p.to, 120).filter((m) => m >= p.from.slice(0, 7));

const text = (header: string, width = 2): ReportColumn => ({ header, kind: "text", width });
const money = (header: string, width = 1.4): ReportColumn => ({ header, kind: "money", width });
const count = (header: string, width = 0.9): ReportColumn => ({ header, kind: "count", width });
const date = (header: string, width = 1.1): ReportColumn => ({ header, kind: "date", width });

export const REPORTS: ReportDef[] = [
  {
    key: "active-loans",
    title: "Active loans register",
    description: "Every active loan with its member, terms and principal outstanding per the ledger.",
    permission: "reports.read",
    usesPeriod: false,
    landscape: true,
    async build(db) {
      const loans = await db.loan.findMany({
        where: { status: "ACTIVE" },
        include: { member: { select: { fullName: true, memberNo: true, remittanceSource: { select: { code: true } } } } },
        orderBy: { d0: "asc" },
      });
      const outstanding = await ledgerPrincipalOutstanding(db, loans.map((l) => l.id));
      const rows: Cell[][] = loans.map((l) => [
        l.member.fullName,
        l.member.memberNo,
        l.loanAccountNo ?? l.legacyAccountNo,
        l.member.remittanceSource?.code ?? "Direct",
        l.d0 ? day(l.d0) : null,
        l.amountApproved ?? 0n,
        l.tenureApproved,
        l.rateBps === null ? null : `${l.rateBps / 100}%`,
        outstanding.get(l.id) ?? 0n,
      ]);
      return {
        title: "Active loans register",
        subtitle: `As at ${todayInLagos()} · ${loans.length} loan(s)`,
        columns: [text("Member", 2.4), text("Member no.", 1.2), text("Loan", 1.5), text("Source", 1.1), date("Paid out"), money("Approved"), count("Months", 0.7), text("Rate/month", 0.9), money("Principal outstanding", 1.6)],
        rows,
        totals: ["Total", null, null, null, null, sumCol(rows, 5), null, null, sumCol(rows, 8)],
        notes: ["Principal outstanding = principal paid out (CASH_OUT) less principal recovered (PRINCIPAL_RECOVERY), reversals included."],
      };
    },
  },
  {
    key: "collections",
    title: "Expected vs actual collections",
    description: "Instalments due against repayments received, per month and per remittance source.",
    permission: "reports.read",
    usesPeriod: true,
    async build(db, period) {
      const months = monthsIn(period);
      const [loans, rows] = await Promise.all([
        db.loan.findMany({
          where: { status: { in: ["ACTIVE", "CLOSED"] }, bindingSchedule: { not: { equals: null } } },
          select: { bindingSchedule: true, member: { select: { remittanceSource: { select: { code: true } } } } },
        }),
        db.remittanceRow.findMany({
          where: { reversedAt: null, paymentDate: { gte: toDb(period.from), lte: toDb(period.to) } },
          select: { paymentDate: true, amount: true, member: { select: { remittanceSource: { select: { code: true } } } } },
        }),
      ]);
      const key = (m: string, s: string) => `${m}|${s}`;
      const expected = new Map<string, bigint>();
      const actual = new Map<string, bigint>();
      const sources = new Set<string>();
      for (const l of loans) {
        const source = l.member.remittanceSource?.code ?? "Direct";
        for (const i of (l.bindingSchedule as { installments?: Array<{ dueDate: string; amount: string }> } | null)?.installments ?? []) {
          if (i.dueDate < period.from || i.dueDate > period.to) continue;
          sources.add(source);
          expected.set(key(i.dueDate.slice(0, 7), source), (expected.get(key(i.dueDate.slice(0, 7), source)) ?? 0n) + BigInt(i.amount));
        }
      }
      for (const r of rows) {
        const source = r.member.remittanceSource?.code ?? "Direct";
        sources.add(source);
        const k = key(day(r.paymentDate).slice(0, 7), source);
        actual.set(k, (actual.get(k) ?? 0n) + r.amount);
      }
      const out: Cell[][] = [];
      for (const m of months) {
        for (const s of [...sources].sort()) {
          const e = expected.get(key(m, s)) ?? 0n;
          const a = actual.get(key(m, s)) ?? 0n;
          if (e === 0n && a === 0n) continue;
          out.push([m, s, e, a, a - e]);
        }
      }
      return {
        title: "Expected vs actual collections",
        subtitle: periodText(period),
        columns: [text("Month", 1), text("Source", 1.4), money("Expected"), money("Received"), money("Difference")],
        rows: out,
        totals: ["Total", null, sumCol(out, 2), sumCol(out, 3), sumCol(out, 4)],
        notes: [
          "Expected: instalments falling due in the month on each loan's binding schedule. Received: live remittance rows by payment date, including rows posted to Overpayment Credit.",
        ],
      };
    },
  },
  {
    key: "interest-income",
    title: "Interest income per month",
    description: "Recognised interest (revenue) per month, net of reversals; ties to the ledger.",
    permission: "reports.read",
    usesPeriod: true,
    async build(db, period) {
      const events = await db.ledgerEvent.findMany({
        where: { moduleCode: "CREDIT", revenueAmount: { not: 0n }, occurredAt: { gte: toDb(period.from), lte: toDb(period.to) } },
        select: { occurredAt: true, revenueAmount: true, reversesEventId: true },
      });
      const rows: Cell[][] = monthsIn(period).map((m) => {
        const inMonth = events.filter((e) => day(e.occurredAt).startsWith(m));
        const posted = inMonth.filter((e) => !e.reversesEventId).reduce((t, e) => t + e.revenueAmount, 0n);
        const reversed = inMonth.filter((e) => e.reversesEventId).reduce((t, e) => t + e.revenueAmount, 0n);
        return [m, posted, reversed, posted + reversed];
      });
      return {
        title: "Interest income per month",
        subtitle: periodText(period),
        columns: [text("Month", 1), money("Posted"), money("Reversed (recomputes)"), money("Net interest income")],
        rows,
        totals: ["Total", sumCol(rows, 1), sumCol(rows, 2), sumCol(rows, 3)],
        notes: ["INTEREST_INCOME revenue by occurred date. Principal, opening balances, Overpayment Credits and bank interest are never revenue."],
      };
    },
  },
  {
    key: "arrears",
    title: "Arrears listing",
    description: "Active loans with principal or interest overdue today (amounts only).",
    permission: "reports.read",
    usesPeriod: false,
    async build(db) {
      const today = todayInLagos();
      const loans = await db.loan.findMany({ where: { status: "ACTIVE" }, include: { member: { select: { fullName: true, memberNo: true, phone: true } } } });
      const rows: Cell[][] = [];
      for (const l of loans) {
        const live = await loanLiveState(db, l, today);
        if (!live) continue;
        const { principalArrears, interestArrears } = live.state;
        if (principalArrears + interestArrears === 0n) continue;
        rows.push([l.member.fullName, l.member.memberNo, l.member.phone, l.loanAccountNo ?? l.legacyAccountNo, principalArrears, interestArrears, principalArrears + interestArrears]);
      }
      rows.sort((a, b) => ((b[6] as bigint) > (a[6] as bigint) ? 1 : -1));
      return {
        title: "Arrears listing",
        subtitle: `As at ${today} · ${rows.length} loan(s) with arrears`,
        columns: [text("Member", 2.2), text("Member no.", 1.1), text("Phone", 1.3), text("Loan", 1.4), money("Principal overdue"), money("Interest overdue"), money("Total overdue")],
        rows,
        totals: ["Total", null, null, null, sumCol(rows, 4), sumCol(rows, 5), sumCol(rows, 6)],
        notes: ["Amounts only; no overdue classification in Phase 1."],
      };
    },
  },
  {
    key: "track-a",
    title: "Schedule vs bank (Track A)",
    description: "Each posted schedule against its bank-verified lodgements, with Recorded, not yet paid.",
    permission: "reports.read",
    usesPeriod: true,
    async build(db, period) {
      const schedules = await db.remittanceSchedule.findMany({
        where: { postedAt: { gte: toDb(period.from), lte: new Date(`${period.to}T23:59:59Z`) } },
        include: {
          remittanceSource: { select: { code: true } },
          rows: { where: { reversedAt: null }, select: { amount: true } },
          lodgements: { select: { amount: true, status: true } },
        },
        orderBy: { postedAt: "asc" },
      });
      const rows: Cell[][] = schedules.map((s) => {
        const recorded = s.rows.reduce((t, r) => t + r.amount, 0n);
        const verified = s.lodgements.filter((l) => l.status !== "UNVERIFIED").reduce((t, l) => t + l.amount, 0n);
        const declared = s.lodgements.filter((l) => l.status === "UNVERIFIED").reduce((t, l) => t + l.amount, 0n);
        const diff = recorded - verified;
        return [s.scheduleReference, s.remittanceSource.code, s.monthCovered, recorded, verified, declared, diff > 0n ? diff : 0n, diff < 0n ? -diff : 0n];
      });
      return {
        title: "Schedule vs bank (Track A)",
        subtitle: `Schedules posted ${periodText(period)}`,
        columns: [text("Schedule", 1.6), text("Source", 1), text("Month", 0.9), money("Recorded"), money("Bank-verified"), money("Declared, unverified"), money("Recorded, not yet paid"), money("Excess")],
        rows,
        totals: ["Total", null, null, sumCol(rows, 3), sumCol(rows, 4), sumCol(rows, 5), sumCol(rows, 6), sumCol(rows, 7)],
        notes: ["Recorded = live rows after corrections. Loan balances are never changed by these differences."],
      };
    },
    landscape: true,
  },
  {
    key: "unapplied-credits",
    title: "Unapplied Bank Credits",
    description: "Bank credits with no lodgement and no member tag, with ageing.",
    permission: "reports.read",
    usesPeriod: false,
    async build(db) {
      const report = await ageingReport(db);
      const rows: Cell[][] = report.unappliedCredits.rows.map((r) => [day(r.transactionDate), `${r.bankAccount.bankName} ${r.bankAccount.accountNumber}`, r.reference, r.narration, r.amount, r.days, r.bucket]);
      return {
        title: "Unapplied Bank Credits",
        subtitle: `As at ${report.asOf}`,
        columns: [date("Date"), text("Account", 1.6), text("Reference", 1.1), text("Narration", 2.4), money("Amount"), count("Days", 0.6), text("Age", 0.7)],
        rows,
        totals: ["Total", null, null, null, report.unappliedCredits.total, null, null],
        notes: Object.entries(report.unappliedCredits.totals).map(([b, v]) => `${b} days: ${formatNaira(kobo(v))}`),
      };
    },
  },
  {
    key: "unverified-lodgements",
    title: "Unverified Lodgements",
    description: "Lodgements declared on schedules that no bank credit has confirmed, with ageing.",
    permission: "reports.read",
    usesPeriod: false,
    async build(db) {
      const report = await ageingReport(db);
      const rows: Cell[][] = report.unverifiedLodgements.rows.map((r) => [day(r.depositDate), `${r.bankAccount.bankName} ${r.bankAccount.accountNumber}`, r.reference, r.schedule?.scheduleReference ?? null, r.amount, r.days, r.bucket]);
      return {
        title: "Unverified Lodgements",
        subtitle: `As at ${report.asOf}`,
        columns: [date("Deposit date"), text("Account", 1.6), text("Reference", 1.1), text("Schedule", 1.4), money("Amount"), count("Days", 0.6), text("Age", 0.7)],
        rows,
        totals: ["Total", null, null, null, report.unverifiedLodgements.total, null, null],
        notes: Object.entries(report.unverifiedLodgements.totals).map(([b, v]) => `${b} days: ${formatNaira(kobo(v))}`),
      };
    },
  },
  {
    key: "overpayment-credits",
    title: "Overpayment Credits",
    description: "Each member's Overpayment Credit: credited, refunded and balance, from the ledger.",
    permission: "reports.read",
    usesPeriod: false,
    async build(db) {
      const groups = await db.ledgerEvent.groupBy({
        by: ["moduleEntityId", "eventType"],
        where: { moduleEntityType: "Member", eventType: { in: ["DEPOSIT_CREDITED", "DEPOSIT_REFUNDED"] } },
        _sum: { depositDelta: true },
      });
      const byMember = new Map<string, { credited: bigint; refunded: bigint }>();
      for (const g of groups) {
        const m = byMember.get(g.moduleEntityId) ?? { credited: 0n, refunded: 0n };
        if (g.eventType === "DEPOSIT_CREDITED") m.credited += g._sum.depositDelta ?? 0n;
        else m.refunded += g._sum.depositDelta ?? 0n;
        byMember.set(g.moduleEntityId, m);
      }
      const members = await db.member.findMany({ where: { id: { in: [...byMember.keys()] } }, select: { id: true, fullName: true, memberNo: true } });
      const name = new Map(members.map((m) => [m.id, m]));
      const rows: Cell[][] = [...byMember]
        .filter(([, v]) => v.credited !== 0n || v.refunded !== 0n)
        .map(([id, v]) => [name.get(id)?.fullName ?? "Unknown member", name.get(id)?.memberNo ?? id.slice(0, 8), v.credited, v.refunded, v.credited - v.refunded])
        .sort((a, b) => ((b[4] as bigint) > (a[4] as bigint) ? 1 : -1));
      return {
        title: "Overpayment Credits",
        subtitle: `As at ${todayInLagos()}`,
        columns: [text("Member", 2.4), text("Member no.", 1.2), money("Credited"), money("Refunded"), money("Balance")],
        rows,
        totals: ["Total", null, sumCol(rows, 2), sumCol(rows, 3), sumCol(rows, 4)],
        notes: ["Credited: DEPOSIT_CREDITED net of reversals. Refunded: DEPOSIT_REFUNDED (refunds arrive with F12)."],
      };
    },
  },
  {
    key: "invitations",
    title: "Invitations and conversion",
    description: "Invitations sent, by sender and status, with conversion to registered and activated members.",
    permission: "invitation.read",
    usesPeriod: true,
    async build(db, period) {
      const now = new Date();
      const invitations = await db.invitation.findMany({
        where: { createdAt: { gte: toDb(period.from), lte: new Date(`${period.to}T23:59:59Z`) } },
        select: { sentById: true, type: true, registeredAt: true, revokedAt: true, expiresAt: true, member: { select: { status: true } } },
      });
      const senders = await db.user.findMany({ where: { id: { in: [...new Set(invitations.map((i) => i.sentById))] } }, select: { id: true, name: true } });
      const name = new Map(senders.map((s) => [s.id, s.name]));
      const rows = new Map<string, { sent: number; open: number; expired: number; revoked: number; registered: number; activated: number }>();
      for (const i of invitations) {
        const r = rows.get(i.sentById) ?? { sent: 0, open: 0, expired: 0, revoked: 0, registered: 0, activated: 0 };
        r.sent++;
        if (i.revokedAt) r.revoked++;
        else if (i.registeredAt) r.registered++;
        else if (i.expiresAt < now) r.expired++;
        else r.open++;
        if (i.member?.status === "ACTIVE" || i.member?.status === "EXITED") r.activated++;
        rows.set(i.sentById, r);
      }
      const out: Cell[][] = [...rows].map(([id, r]) => [name.get(id) ?? id, r.sent, r.open, r.expired, r.revoked, r.registered, r.activated, r.sent ? `${Math.round((r.activated / r.sent) * 100)}%` : "-"]);
      const total = (i: number) => out.reduce((t, r) => t + (r[i] as number), 0);
      return {
        title: "Invitations and conversion",
        subtitle: `Sent ${periodText(period)}`,
        columns: [text("Sender", 2), count("Sent"), count("Open"), count("Expired"), count("Revoked"), count("Registered"), count("Activated"), text("Conversion", 0.9)],
        rows: out,
        totals: ["Total", total(1), total(2), total(3), total(4), total(5), total(6), total(1) ? `${Math.round((total(6) / total(1)) * 100)}%` : "-"],
        notes: ["Activated: the member the invitation created is active (or has since exited). Imported members count under the Admin who imported them."],
      };
    },
  },
  {
    key: "ledger",
    title: "Ledger export",
    description: "Every ledger event in the period with its evidence references, for auditors.",
    permission: "ledger.export",
    usesPeriod: true,
    landscape: true,
    async build(db, period) {
      const events = await db.ledgerEvent.findMany({
        where: { occurredAt: { gte: toDb(period.from), lte: toDb(period.to) } },
        orderBy: [{ occurredAt: "asc" }, { postedAt: "asc" }],
        take: 50_000,
      });
      const rows: Cell[][] = events.map((e) => [
        day(e.occurredAt),
        e.postedAt.toISOString(),
        e.moduleCode,
        e.eventType,
        e.source,
        `${e.moduleEntityType}:${e.moduleEntityId}`,
        e.cashAmount,
        e.revenueAmount,
        e.principalAmount,
        e.interestAmount,
        e.depositDelta,
        e.reversesEventId,
        e.evidenceRefs.join(" "),
        e.id,
      ]);
      return {
        title: "Ledger export",
        subtitle: `${periodText(period)} · ${events.length} event(s)${events.length === 50_000 ? " (first 50,000)" : ""}`,
        columns: [
          date("Occurred"),
          text("Posted", 1.6),
          text("Module", 0.8),
          text("Type", 1.5),
          text("Source", 1.4),
          text("Record", 2.2),
          money("Cash"),
          money("Revenue"),
          money("Principal"),
          money("Interest"),
          money("Deposit"),
          text("Reverses", 1.4),
          text("Evidence", 2.4),
          text("Event id", 1.4),
        ],
        rows,
        totals: ["Total", null, null, null, null, null, sumCol(rows, 6), sumCol(rows, 7), sumCol(rows, 8), sumCol(rows, 9), sumCol(rows, 10), null, null, null],
        notes: ["Reversals carry negative amounts, so totals are net."],
      };
    },
  },
];

export function reportByKey(key: string) {
  return REPORTS.find((r) => r.key === key) ?? null;
}

/** The period from query parameters, defaulting to the year to date. */
export function parsePeriod(from: string | null | undefined, to: string | null | undefined): Period {
  const today = todayInLagos();
  const read = (v: string | null | undefined, fallback: LocalDate) => {
    try {
      return v ? localDate(v) : fallback;
    } catch {
      return fallback;
    }
  };
  const p = { from: read(from, localDate(`${today.slice(0, 4)}-01-01`)), to: read(to, today) };
  return compareDates(p.from, p.to) > 0 ? { from: p.to, to: p.from } : p;
}

export function displayCell(cell: Cell, column: ReportColumn): string {
  if (cell === null || cell === undefined) return "";
  if (column.kind === "money" && typeof cell === "bigint") return formatNaira(kobo(cell));
  return String(cell);
}

/** Excel: money as numbers in naira (formatted), so the sheet can be summed. */
export async function reportXlsx(report: ReportResult): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Dommus Negotii";
  const ws = wb.addWorksheet(report.title.slice(0, 31));
  ws.addRow([report.title]).font = { bold: true, size: 13 };
  ws.addRow([report.subtitle]);
  ws.addRow([]);
  const header = ws.addRow(report.columns.map((c) => c.header));
  header.font = { bold: true };
  const value = (cell: Cell, c: ReportColumn) => (c.kind === "money" && typeof cell === "bigint" ? Number(cell) / 100 : typeof cell === "bigint" ? cell.toString() : cell);
  for (const r of report.rows) ws.addRow(r.map((cell, i) => value(cell, report.columns[i] as ReportColumn)));
  if (report.totals) ws.addRow(report.totals.map((cell, i) => value(cell, report.columns[i] as ReportColumn))).font = { bold: true };
  report.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(10, Math.round(c.width * 9));
    if (c.kind === "money") col.numFmt = '"₦"#,##0.00;-"₦"#,##0.00';
  });
  if (report.notes.length) {
    ws.addRow([]);
    for (const n of report.notes) ws.addRow([n]).font = { italic: true };
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export async function reportPdf(report: ReportResult, landscape = false): Promise<Uint8Array> {
  const pdf = await PdfWriter.create(report.title, "Dommus Negotii · MOAUM Credit Super Store", { landscape });
  pdf.title(report.title, report.subtitle);
  const columns: Column[] = report.columns.map((c) => ({ header: c.header, width: c.width, align: c.kind === "money" || c.kind === "count" ? "right" : "left" }));
  const rows = report.rows.map((r) => r.map((cell, i) => displayCell(cell, report.columns[i] as ReportColumn)));
  if (report.totals) rows.push(report.totals.map((cell, i) => displayCell(cell, report.columns[i] as ReportColumn)));
  if (rows.length === 0) pdf.paragraph("Nothing to report.", 9.5, true);
  else pdf.table(columns, rows, { totalRow: Boolean(report.totals), size: report.columns.length > 9 ? 6.5 : 8 });
  for (const n of report.notes) pdf.paragraph(n, 8, true);
  return pdf.bytes();
}
