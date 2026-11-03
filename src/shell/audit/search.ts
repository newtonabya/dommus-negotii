import ExcelJS from "exceljs";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { addDays, compareDates, localDate, TIME_ZONE, type LocalDate } from "@/lib/dates";

/** PRD F2: the Auditor searches the audit trail by user, date, record and action. */
export interface AuditFilters {
  /** Name, email or user id. */
  user?: string;
  from?: LocalDate;
  to?: LocalDate;
  action?: string;
  entityType?: string;
  entityId?: string;
}

export const AUDIT_PAGE_SIZE = 50;
/** Rows in one Excel export; narrow the filters for more. */
export const AUDIT_EXPORT_LIMIT = 20_000;

type Params = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");

/** Reads the filters from a query string, with messages for anything that doesn't parse. */
export function parseAuditFilters(params: Params): { filters: AuditFilters; errors: string[] } {
  const filters: AuditFilters = {};
  const errors: string[] = [];
  for (const [name, label] of [
    ["from", "From"],
    ["to", "To"],
  ] as const) {
    const text = one(params[name]);
    if (!text) continue;
    try {
      filters[name] = localDate(text);
    } catch {
      errors.push(`${label}: enter a date as YYYY-MM-DD.`);
    }
  }
  if (filters.from && filters.to && compareDates(filters.from, filters.to) > 0) errors.push("From must be on or before To.");
  for (const name of ["user", "action", "entityType", "entityId"] as const) {
    const text = one(params[name]);
    if (text) filters[name] = text.slice(0, 200);
  }
  return { filters, errors };
}

/** The same filters as a query string, for paging and export links. */
export function filtersToQuery(filters: AuditFilters, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}

/** Midnight in Lagos (UTC+1 all year) at the start of a date. */
const startOfDay = (d: LocalDate) => new Date(`${d}T00:00:00+01:00`);

async function whereFor(db: Db, filters: AuditFilters): Promise<Prisma.AuditLogWhereInput> {
  const where: Prisma.AuditLogWhereInput = {};
  if (filters.user) {
    const users = await db.user.findMany({
      where: {
        OR: [
          { name: { contains: filters.user, mode: "insensitive" } },
          { email: { contains: filters.user, mode: "insensitive" } },
        ],
      },
      select: { id: true },
      take: 200,
    });
    where.userId = { in: [filters.user, ...users.map((u) => u.id)] };
  }
  if (filters.from || filters.to) {
    where.occurredAt = {
      ...(filters.from ? { gte: startOfDay(filters.from) } : {}),
      ...(filters.to ? { lt: startOfDay(addDays(filters.to, 1)) } : {}),
    };
  }
  if (filters.action) where.action = filters.action;
  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.entityId) where.entityId = filters.entityId;
  return where;
}

/** Who did it, as people read it. */
async function actorNames(db: Db, userIds: (string | null)[]) {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  return (id: string | null) => {
    if (!id) return { name: "System", email: "" };
    const user = byId.get(id);
    if (user) return { name: user.name, email: user.email };
    if (id.startsWith("invitation:")) return { name: "Registrant (before login)", email: "" };
    return { name: "Unknown user", email: "" };
  };
}

export const formatAuditTime = (d: Date) =>
  d.toLocaleString("en-NG", { timeZone: TIME_ZONE, dateStyle: "medium", timeStyle: "medium" });

/** One page of matching entries, newest first. */
export async function searchAudit(db: Db, filters: AuditFilters, page = 1) {
  const where = await whereFor(db, filters);
  const [total, rows, actions, entityTypes] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * AUDIT_PAGE_SIZE,
      take: AUDIT_PAGE_SIZE,
    }),
    db.auditLog.groupBy({ by: ["action"], orderBy: { action: "asc" } }),
    db.auditLog.groupBy({ by: ["entityType"], orderBy: { entityType: "asc" } }),
  ]);
  const actor = await actorNames(db, rows.map((r) => r.userId));
  return {
    total,
    page,
    pages: Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)),
    rows: rows.map((r) => ({ ...r, actor: actor(r.userId) })),
    actions: actions.map((a) => a.action),
    entityTypes: entityTypes.map((e) => e.entityType),
  };
}

const json = (v: Prisma.JsonValue | null) => (v === null ? "" : JSON.stringify(v));

/** The matching entries as an Excel workbook (PRD F2 DoD), newest first, capped at AUDIT_EXPORT_LIMIT rows. */
export async function exportAudit(db: Db, filters: AuditFilters, exportedBy: string) {
  const where = await whereFor(db, filters);
  const [total, rows] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: AUDIT_EXPORT_LIMIT }),
  ]);
  const actor = await actorNames(db, rows.map((r) => r.userId));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Dommus Negotii";
  const sheet = workbook.addWorksheet("Audit trail");
  sheet.columns = [
    { header: "Time (Lagos)", key: "time", width: 24 },
    { header: "Time (UTC, ISO)", key: "iso", width: 26 },
    { header: "User", key: "user", width: 24 },
    { header: "User email", key: "email", width: 28 },
    { header: "User id", key: "userId", width: 36 },
    { header: "IP address", key: "ip", width: 16 },
    { header: "Action", key: "action", width: 30 },
    { header: "Record type", key: "entityType", width: 20 },
    { header: "Record id", key: "entityId", width: 38 },
    { header: "Before", key: "before", width: 50 },
    { header: "After", key: "after", width: 50 },
    { header: "Evidence", key: "evidence", width: 38 },
    { header: "Entry id", key: "id", width: 38 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of rows) {
    const who = actor(r.userId);
    sheet.addRow({
      time: formatAuditTime(r.occurredAt),
      iso: r.occurredAt.toISOString(),
      user: who.name,
      email: who.email,
      userId: r.userId ?? "",
      ip: r.ipAddress ?? "",
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId ?? "",
      before: json(r.before),
      after: json(r.after),
      evidence: r.evidenceRef ?? "",
      id: r.id,
    });
  }

  const about = workbook.addWorksheet("About this export");
  about.columns = [
    { header: "Item", key: "item", width: 24 },
    { header: "Value", key: "value", width: 60 },
  ];
  about.getRow(1).font = { bold: true };
  about.addRow({ item: "Exported", value: formatAuditTime(new Date()) });
  about.addRow({ item: "Exported by", value: exportedBy });
  about.addRow({ item: "Matching entries", value: total });
  about.addRow({ item: "Entries in this file", value: rows.length });
  if (total > rows.length) {
    about.addRow({ item: "Note", value: `Only the newest ${AUDIT_EXPORT_LIMIT} entries are included. Narrow the filters to export the rest.` });
  }
  for (const [k, v] of Object.entries(filters)) if (v) about.addRow({ item: `Filter: ${k}`, value: v });

  return { bytes: new Uint8Array(await workbook.xlsx.writeBuffer()), total, included: rows.length };
}
