import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Same precedence as Next.js: .env.local overrides .env.
config({ path: [".env.local", ".env"], quiet: true });

// Migrations use the direct (non-pooled) Neon connection as the owner role.
// The app itself connects with DATABASE_URL as app_runtime (src/lib/db.ts).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DIRECT_URL ?? "postgresql://localhost:5432/dommus",
  },
});
