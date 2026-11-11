import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db } from "@/lib/db";
import { compareDates, localDate, todayInLagos, type LocalDate } from "@/lib/dates";
import { bps, type Bps } from "@/lib/money";
import { writeAudit } from "@/shell/audit/audit";
import {
  definitionOf,
  defaultValue,
  formatValue,
  parseInput,
  SETTINGS,
  type CountKey,
  type DateKey,
  type RateKey,
  type SettingDefinition,
  type SettingKey,
  type StoredValue,
} from "./definitions";
import { queueForRoles } from "@/shell/notifications/messages";

/** Messages from this error are written for the user and safe to show. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export interface SettingsActor {
  id: string;
  ipAddress: string | null;
}

const MIN_REASON = 10;

const toDbDate = (d: LocalDate) => new Date(`${d}T00:00:00Z`);
const fromDbDate = (d: Date) => localDate(d.toISOString().slice(0, 10));

function definition(key: string): SettingDefinition {
  const def = definitionOf(key);
  if (!def) throw new SettingsError(`Unknown setting "${key}".`);
  return def;
}

/**
 * The value in force on a date: the stored row with the latest effective date
 * on or before it (latest entry wins on the same date), else the default.
 * Proposals never count until Management approves them (AT-r).
 */
async function storedValueOn(db: Db, key: string, on: LocalDate): Promise<StoredValue> {
  const row = await db.setting.findFirst({
    where: { key, effectiveFrom: { lte: toDbDate(on) } },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
  });
  return row ? (row.value as StoredValue) : defaultValue(definition(key));
}

export async function getRateSetting(db: Db, key: RateKey, on: LocalDate = todayInLagos()): Promise<Bps> {
  return bps(BigInt(String(await storedValueOn(db, key, on))));
}

export async function getCountSetting(db: Db, key: CountKey, on: LocalDate = todayInLagos()): Promise<number> {
  const value = await storedValueOn(db, key, on);
  if (typeof value !== "number") throw new Error(`Setting ${key} holds a non-number`);
  return value;
}

export async function getDateSetting(db: Db, key: DateKey, on: LocalDate = todayInLagos()): Promise<LocalDate | null> {
  const value = await storedValueOn(db, key, on);
  return value === null ? null : localDate(String(value));
}

function sameValue(a: StoredValue, b: StoredValue): boolean {
  return a === b || (a !== null && b !== null && String(a) === String(b));
}

/** Changes an operational setting at once (Admin). Financial settings go through proposeChange. */
export async function changeSetting(db: Db, actor: SettingsActor, key: SettingKey, text: string, today = todayInLagos()) {
  const def = definition(key);
  if (def.financial) throw new SettingsError(`${def.label} is a financial setting: propose the change for Management approval.`);
  const parsed = parseInput(def, text);
  if ("error" in parsed) throw new SettingsError(parsed.error);
  const before = await storedValueOn(db, key, today);
  if (sameValue(before, parsed.value)) throw new SettingsError(`${def.label} is already ${formatValue(def, before)}.`);

  await db.setting.create({
    data: { key, value: parsed.value as Prisma.InputJsonValue, effectiveFrom: toDbDate(today), createdById: actor.id },
  });
  await writeAudit(db, {
    action: "setting.changed",
    entityType: "Setting",
    entityId: key,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    before: { value: before },
    after: { value: parsed.value, effectiveFrom: today },
  });
}

export interface ProposalInput {
  key: SettingKey;
  value: string;
  effectiveFrom: string;
  reason: string;
}

/** Admin proposes a financial setting change; it does nothing until Management approves it. */
export async function proposeChange(db: Db, actor: SettingsActor, input: ProposalInput, today = todayInLagos()) {
  const def = definition(input.key);
  if (!def.financial) throw new SettingsError(`${def.label} is not a financial setting: change it directly.`);
  const parsed = parseInput(def, input.value);
  if ("error" in parsed) throw new SettingsError(parsed.error);

  let effectiveFrom: LocalDate;
  try {
    effectiveFrom = localDate(input.effectiveFrom.trim());
  } catch {
    throw new SettingsError("Enter the effective date as YYYY-MM-DD.");
  }
  if (compareDates(effectiveFrom, today) < 0) {
    throw new SettingsError(`The effective date can't be in the past (today is ${today}).`);
  }
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON) throw new SettingsError("Give a reason of at least 10 characters.");
  const before = await storedValueOn(db, input.key, effectiveFrom);
  if (sameValue(before, parsed.value)) {
    throw new SettingsError(`${def.label} will already be ${formatValue(def, before)} on ${effectiveFrom}.`);
  }

  let request;
  try {
    request = await db.settingChangeRequest.create({
      data: {
        key: input.key,
        proposedValue: parsed.value as Prisma.InputJsonValue,
        effectiveFrom: toDbDate(effectiveFrom),
        reason,
        proposedById: actor.id,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new SettingsError(`${def.label} already has a proposal waiting for Management. Withdraw it first.`);
    }
    throw error;
  }
  await writeAudit(db, {
    action: "setting.change_proposed",
    entityType: "SettingChangeRequest",
    entityId: request.id,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    before: { key: input.key, value: before },
    after: { key: input.key, value: parsed.value, effectiveFrom, reason },
  });
  await queueForRoles(
    db,
    ["MANAGEMENT"],
    { key: `setting.proposed:${request.id}`, template: "staff.setting.proposed", subject: `A setting change waits for approval: ${def.label}`, text: `A change to ${def.label} was proposed, effective ${effectiveFrom}, and waits for Management's approval.\n\nReason: ${reason}\n\nSee Settings in Dommus Negotii.` },
    actor.id,
  );
  return request;
}

async function pendingRequest(db: Db, requestId: string) {
  const request = await db.settingChangeRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new SettingsError("Proposal not found.");
  if (request.status !== "PENDING") throw new SettingsError(`This proposal was already ${request.status.toLowerCase()}.`);
  return request;
}

/**
 * Management approves a proposal: the value takes effect on its effective date.
 * A proposal whose date has passed can't be approved (no backdating).
 */
export async function approveChange(db: PrismaClient, actor: SettingsActor, requestId: string, note = "", today = todayInLagos()) {
  const request = await pendingRequest(db, requestId);
  const def = definition(request.key);
  if (request.proposedById === actor.id) throw new SettingsError("You can't approve your own proposal.");
  const effectiveFrom = fromDbDate(request.effectiveFrom);
  if (compareDates(effectiveFrom, today) < 0) {
    throw new SettingsError(
      `The effective date (${effectiveFrom}) has passed, and a change can't be backdated. Reject it; the Admin can propose it again with a new date.`,
    );
  }
  const before = await storedValueOn(db, request.key, effectiveFrom);

  await db.$transaction(async (tx) => {
    const { count } = await tx.settingChangeRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: { status: "APPROVED", decidedById: actor.id, decidedAt: new Date(), decisionNote: note.trim() || null },
    });
    if (count !== 1) throw new SettingsError("This proposal was decided by someone else just now.");
    await tx.setting.create({
      data: {
        key: request.key,
        value: request.proposedValue as Prisma.InputJsonValue,
        effectiveFrom: request.effectiveFrom,
        createdById: actor.id,
        changeRequestId: request.id,
      },
    });
    await writeAudit(tx, {
      action: "setting.change_approved",
      entityType: "SettingChangeRequest",
      entityId: request.id,
      userId: actor.id,
      ipAddress: actor.ipAddress,
      before: { key: request.key, value: before },
      after: { key: request.key, value: request.proposedValue as StoredValue, effectiveFrom, proposedBy: request.proposedById },
    });
  }, TX_OPTIONS);
  return { label: def.label, value: formatValue(def, request.proposedValue as StoredValue), effectiveFrom };
}

/** Management rejects a proposal, with a reason the Admin will see. */
export async function rejectChange(db: Db, actor: SettingsActor, requestId: string, note: string) {
  const request = await pendingRequest(db, requestId);
  const reason = note.trim();
  if (reason.length < 5) throw new SettingsError("Say why you're rejecting it (at least 5 characters).");
  const { count } = await db.settingChangeRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "REJECTED", decidedById: actor.id, decidedAt: new Date(), decisionNote: reason },
  });
  if (count !== 1) throw new SettingsError("This proposal was decided by someone else just now.");
  await writeAudit(db, {
    action: "setting.change_rejected",
    entityType: "SettingChangeRequest",
    entityId: requestId,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    after: { key: request.key, note: reason },
  });
}

/** The proposer takes back a proposal before it is decided. */
export async function withdrawChange(db: Db, actor: SettingsActor, requestId: string) {
  const request = await pendingRequest(db, requestId);
  if (request.proposedById !== actor.id) throw new SettingsError("Only the person who proposed it can withdraw it.");
  const { count } = await db.settingChangeRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "WITHDRAWN", decidedAt: new Date() },
  });
  if (count !== 1) throw new SettingsError("This proposal was decided by someone else just now.");
  await writeAudit(db, {
    action: "setting.change_withdrawn",
    entityType: "SettingChangeRequest",
    entityId: requestId,
    userId: actor.id,
    ipAddress: actor.ipAddress,
    after: { key: request.key },
  });
}

// `today` is a parameter so tests can work on far-future dates: the setting
// table is append-only, so test rows must never change today's values.

/** Everything the settings page shows: current and upcoming values, open proposals and recent history. */
export async function settingsOverview(db: Db) {
  const today = todayInLagos();
  const [rows, requests] = await Promise.all([
    db.setting.findMany({ orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }] }),
    db.settingChangeRequest.findMany({ orderBy: { proposedAt: "desc" }, take: 50 }),
  ]);
  const people = await db.user.findMany({
    where: { id: { in: [...new Set([...requests.flatMap((r) => [r.proposedById, r.decidedById ?? ""]), ...rows.map((r) => r.createdById)])] } },
    select: { id: true, name: true },
  });
  const name = (id: string | null) => (id ? (people.find((p) => p.id === id)?.name ?? "Unknown") : "");

  const settings = (SETTINGS as readonly SettingDefinition[]).map((def) => {
    const own = rows.filter((r) => r.key === def.key);
    const inForce = own.filter((r) => compareDates(fromDbDate(r.effectiveFrom), today) <= 0).at(-1);
    const upcoming = own
      .filter((r) => compareDates(fromDbDate(r.effectiveFrom), today) > 0)
      .map((r) => ({ value: formatValue(def, r.value as StoredValue), effectiveFrom: fromDbDate(r.effectiveFrom) }));
    const pending = requests.find((r) => r.key === def.key && r.status === "PENDING");
    return {
      def,
      current: formatValue(def, inForce ? (inForce.value as StoredValue) : defaultValue(def)),
      isDefault: !inForce,
      since: inForce ? fromDbDate(inForce.effectiveFrom) : null,
      changedBy: inForce ? name(inForce.createdById) : null,
      upcoming,
      pending: pending
        ? {
            id: pending.id,
            value: formatValue(def, pending.proposedValue as StoredValue),
            effectiveFrom: fromDbDate(pending.effectiveFrom),
            reason: pending.reason,
            proposedById: pending.proposedById,
            proposedBy: name(pending.proposedById),
            proposedAt: pending.proposedAt,
            overdue: compareDates(fromDbDate(pending.effectiveFrom), today) < 0,
          }
        : null,
    };
  });

  const history = requests.map((r) => {
    const def = definitionOf(r.key);
    return {
      id: r.id,
      label: def?.label ?? r.key,
      value: def ? formatValue(def, r.proposedValue as StoredValue) : JSON.stringify(r.proposedValue),
      effectiveFrom: fromDbDate(r.effectiveFrom),
      reason: r.reason,
      status: r.status,
      proposedBy: name(r.proposedById),
      proposedAt: r.proposedAt,
      decidedBy: name(r.decidedById),
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
    };
  });
  return { today, settings, history };
}
