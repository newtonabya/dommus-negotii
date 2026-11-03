import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";

/** A Prisma client or an interactive-transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Options for every interactive transaction (PRD §5). Prisma's default 5 s
 * limit is too tight for a cold Neon compute or a slow link; imports with many
 * rows pass their own larger timeout.
 */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * The app's database client. Connects as app_runtime through Neon's pooled
 * connection (DATABASE_URL), never as the owner role.
 */
export function getDb(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = createClient(url);
  if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = client;
  return client;
}

export { createClient };
