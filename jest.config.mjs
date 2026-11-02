import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";
import nextJest from "next/jest.js";

// Tests see only the TEST_* variables from .env.local, never the app's
// DATABASE_URL, so no test can write to staging by accident.
if (existsSync(".env.local")) {
  for (const [key, value] of Object.entries(parse(readFileSync(".env.local")))) {
    if (key.startsWith("TEST_") && process.env[key] === undefined) process.env[key] = value;
  }
}

const createJestConfig = nextJest({ dir: "./" });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
};

export default createJestConfig(config);
