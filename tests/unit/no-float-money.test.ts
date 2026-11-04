/**
 * Guard (PRD F6 DoD): money and rate code never uses floating point. The lint
 * rule enforces this too; this test fails even if lint is skipped.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const files = [
  "src/lib/money.ts",
  ...readdirSync("src/modules/credit/domain").filter((f) => f.endsWith(".ts")).map((f) => path.join("src/modules/credit/domain", f)),
  ...readdirSync("src/ledger").filter((f) => f.endsWith(".ts")).map((f) => path.join("src/ledger", f)),
];

describe("no floating-point money code", () => {
  it.each(files)("%s", (file) => {
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/(["'`])(?:\.|(?!\1).)*\1/g, '""');
    expect(code).not.toMatch(/(?<![\w.])\d*\.\d+(?![\w.])/); // decimal literals
    expect(code).not.toMatch(/\bparseFloat\s*\(|(?<![.\w])Number\s*\(/);
    expect(code).not.toMatch(/\bMath\./);
  });
});
