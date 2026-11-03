import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// PRD §5: no floating-point arithmetic in money code.
const noFloatMoney = {
  "no-restricted-syntax": [
    "error",
    {
      selector: "Literal[raw=/^\\d*\\.\\d+(e[+-]?\\d+)?$/i]",
      message: "No decimal literals in money code: use integer kobo (bigint) and basis points.",
    },
    {
      selector: "CallExpression[callee.name=/^(parseFloat|Number)$/]",
      message: "No JS numbers for money: use parseNaira() / kobo().",
    },
    {
      selector: "MemberExpression[object.name='Math']",
      message: "No Math in money code: use the bigint helpers in src/lib/money.ts.",
    },
  ],
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["src/lib/money.ts", "src/ledger/**/*.ts", "src/modules/credit/domain/**/*.ts", "src/shell/settings/**/*.ts"],
    rules: noFloatMoney,
  },
  {
    // PRD §6: shared layers never import from a module.
    files: ["src/shell/**", "src/ledger/**", "src/evidence/**", "src/lib/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@/modules/*", "**/modules/*"], message: "Shared layers must not import from a module." }] },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "src/generated/**"]),
]);

export default eslintConfig;
