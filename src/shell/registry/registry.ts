import type { ModuleStatus } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { writeAudit } from "@/shell/audit/audit";

/**
 * Module registry (PRD F2, §8 contract 4): every module registers its code,
 * name and the ledger event types it emits, and has a status. OFFLINE stops
 * its staff actions and its ledger postings; DEGRADED only warns.
 */
export class ModuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleError";
  }
}

export interface ModuleActor {
  id: string;
  ipAddress: string | null;
}

export interface ModuleRegistration {
  code: string;
  name: string;
  eventTypes: readonly string[];
}

/** The portal itself: always live, emits no ledger events. */
export const SHELL_MODULE = "SHELL";

/** Registers a module or updates its name and event list (status is left alone). */
export async function registerModule(db: Db, registration: ModuleRegistration) {
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(registration.code)) throw new ModuleError("A module code is 2-20 capital letters, digits or _.");
  const eventTypes = [...new Set(registration.eventTypes)].sort();
  return db.module.upsert({
    where: { code: registration.code },
    create: { code: registration.code, name: registration.name, eventTypes },
    update: { name: registration.name, eventTypes },
  });
}

export async function moduleStatus(db: Db, code: string): Promise<{ name: string; status: ModuleStatus } | null> {
  return db.module.findUnique({ where: { code }, select: { name: true, status: true } });
}

/** Ledger guard: the module must be registered, not OFFLINE, and declare the event type. */
export async function assertModuleCanPost(db: Db, code: string, eventType?: string): Promise<void> {
  const mod = await db.module.findUnique({ where: { code } });
  if (!mod) throw new ModuleError(`Module ${code} is not registered.`);
  if (mod.status === "OFFLINE") throw new ModuleError(`${mod.name} is offline: nothing can be posted for it.`);
  if (eventType !== undefined && !mod.eventTypes.includes(eventType)) {
    throw new ModuleError(`${mod.name} has not registered the event type ${eventType}.`);
  }
}

const STATUSES: readonly ModuleStatus[] = ["LIVE", "DEGRADED", "OFFLINE"];

/** Admin changes a module's status, with a reason (audited). The Portal Shell can't be taken offline. */
export async function setModuleStatus(db: Db, actor: ModuleActor, code: string, status: string, reason: string) {
  if (!STATUSES.includes(status as ModuleStatus)) throw new ModuleError("Choose Live, Degraded or Offline.");
  if (code === SHELL_MODULE) throw new ModuleError("The Portal Shell's status can't be changed.");
  const why = reason.trim();
  if (why.length < 5) throw new ModuleError("Give a reason (at least 5 characters); staff see it in the banner.");
  const mod = await db.module.findUnique({ where: { code } });
  if (!mod) throw new ModuleError("Module not found.");
  if (mod.status === status) throw new ModuleError(`${mod.name} is already ${status.toLowerCase()}.`);

  await db.module.update({ where: { code }, data: { status: status as ModuleStatus } });
  await writeAudit(db, {
    action: "module.status_changed",
    entityType: "Module",
    entityId: code,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    before: { status: mod.status },
    after: { status, reason: why },
  });
}

/** Modules with their events posted so far and role assignments, for the Admin page. */
export async function listModules(db: Db) {
  const [modules, posted, roles, changes] = await Promise.all([
    db.module.findMany({ orderBy: { registeredAt: "asc" } }),
    db.ledgerEvent.groupBy({ by: ["moduleCode", "eventType"], _count: { _all: true } }),
    db.userModuleRole.groupBy({ by: ["moduleCode"], where: { revokedAt: null }, _count: { _all: true } }),
    db.auditLog.findMany({ where: { action: "module.status_changed" }, orderBy: { occurredAt: "desc" }, take: 20 }),
  ]);
  const people = await db.user.findMany({
    where: { id: { in: [...new Set(changes.map((c) => c.userId).filter((id): id is string => Boolean(id)))] } },
    select: { id: true, name: true },
  });
  return {
    modules: modules.map((m) => ({
      ...m,
      events: m.eventTypes.map((type) => ({
        type,
        posted: posted.find((p) => p.moduleCode === m.code && p.eventType === type)?._count._all ?? 0,
      })),
      activeRoles: roles.find((r) => r.moduleCode === m.code)?._count._all ?? 0,
    })),
    changes: changes.map((c) => ({
      id: c.id,
      at: c.occurredAt,
      code: c.entityId ?? "",
      by: people.find((p) => p.id === c.userId)?.name ?? "Unknown",
      before: (c.before as { status?: string } | null)?.status ?? "",
      after: (c.after as { status?: string; reason?: string } | null) ?? {},
    })),
  };
}

/** The latest reason given for a module that isn't live, for the staff banner. */
export async function modulesNotLive(db: Db) {
  const modules = await db.module.findMany({ where: { status: { not: "LIVE" } }, orderBy: { code: "asc" } });
  return Promise.all(
    modules.map(async (m) => {
      const last = await db.auditLog.findFirst({
        where: { action: "module.status_changed", entityId: m.code },
        orderBy: { occurredAt: "desc" },
      });
      return { code: m.code, name: m.name, status: m.status, reason: (last?.after as { reason?: string } | null)?.reason ?? "" };
    }),
  );
}
