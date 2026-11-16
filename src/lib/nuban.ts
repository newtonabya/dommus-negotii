/**
 * Nigerian account number (NUBAN) check digit, per the CBN standard: the
 * institution code (a bank's 3-digit CBN code, padded to six) followed by the
 * first nine digits of the account number are weighted 3, 7, 3, 3, 7, 3, …;
 * the check digit (the tenth) is 10 − (sum mod 10), with 10 written as 0.
 *
 * This catches a mistyped digit or the wrong bank. It does not prove the
 * account exists or whose it is: that needs a name enquiry through a payment
 * provider. Banks are listed only where the CBN code is well established;
 * microfinance banks and fintechs (OFI codes) are not checked.
 */
const BANK_CODES: Array<{ code: string; names: string[] }> = [
  { code: "044", names: ["access"] },
  { code: "023", names: ["citibank", "citi bank"] },
  { code: "050", names: ["ecobank"] },
  { code: "070", names: ["fidelity"] },
  { code: "011", names: ["first bank", "firstbank", "fbn"] },
  { code: "214", names: ["fcmb", "first city monument"] },
  { code: "058", names: ["gtbank", "guaranty trust", "gtco", "gt bank"] },
  { code: "030", names: ["heritage"] },
  { code: "301", names: ["jaiz"] },
  { code: "082", names: ["keystone"] },
  { code: "076", names: ["polaris", "skye"] },
  { code: "101", names: ["providus"] },
  { code: "221", names: ["stanbic"] },
  { code: "068", names: ["standard chartered"] },
  { code: "232", names: ["sterling"] },
  { code: "100", names: ["suntrust", "sun trust"] },
  { code: "102", names: ["titan"] },
  { code: "032", names: ["union bank"] },
  { code: "033", names: ["united bank for africa", "uba"] },
  { code: "215", names: ["unity"] },
  { code: "035", names: ["wema", "alat"] },
  { code: "057", names: ["zenith"] },
];

const WEIGHTS = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3];

/** The bank's CBN code from its name as typed ("GTBank", "Guaranty Trust Bank (GTBank)" …); null if not a listed bank. */
export function bankCodeFor(bankName: string): string | null {
  // Whole words only, so "uba" never matches inside another word.
  const name = ` ${bankName.toLowerCase().replace(/[^a-z]+/g, " ").trim()} `;
  return BANK_CODES.find((b) => b.names.some((n) => name.includes(` ${n} `)))?.code ?? null;
}

/** Same account: the same 10 digits and, where both banks are listed, the same bank. */
export function sameAccount(a: { bank: string; accountNo: string }, b: { bank: string; accountNo: string }): boolean {
  const digits = (s: string) => s.replace(/[\s-]/g, "");
  if (digits(a.accountNo) !== digits(b.accountNo)) return false;
  const [x, y] = [bankCodeFor(a.bank), bankCodeFor(b.bank)];
  return x && y ? x === y : a.bank.trim().toLowerCase() === b.bank.trim().toLowerCase();
}

/** True when the ten-digit account number's check digit fits the bank code. */
export function nubanValid(bankCode: string, accountNo: string): boolean {
  if (!/^\d{10}$/.test(accountNo) || !/^\d{3,6}$/.test(bankCode)) return false;
  const digits = (bankCode.padStart(6, "0") + accountNo.slice(0, 9)).split("").map(Number);
  const sum = digits.reduce((t, d, i) => t + d * WEIGHTS[i]!, 0);
  const check = (10 - (sum % 10)) % 10;
  return check === Number(accountNo[9]);
}

export type NubanCheck =
  | { state: "incomplete" }
  | { state: "ok"; bank: string }
  | { state: "mismatch"; bank: string; fitsBanks: string[] }
  | { state: "unchecked" };

const LABEL: Record<string, string> = {
  "044": "Access Bank", "023": "Citibank", "050": "Ecobank", "070": "Fidelity Bank", "011": "First Bank", "214": "FCMB", "058": "GTBank", "030": "Heritage Bank",
  "301": "Jaiz Bank", "082": "Keystone Bank", "076": "Polaris Bank", "101": "Providus Bank", "221": "Stanbic IBTC Bank", "068": "Standard Chartered", "232": "Sterling Bank",
  "100": "SunTrust Bank", "102": "Titan Trust Bank", "032": "Union Bank", "033": "UBA", "215": "Unity Bank", "035": "Wema Bank", "057": "Zenith Bank",
};

/** Checks an account number against the bank chosen; on a mismatch, names the listed banks it would fit. */
export function checkNuban(bankName: string, accountNo: string): NubanCheck {
  const digits = accountNo.replace(/[\s-]/g, "");
  if (!/^\d{10}$/.test(digits) || bankName.trim().length < 2) return { state: "incomplete" };
  const code = bankCodeFor(bankName);
  if (!code) return { state: "unchecked" };
  if (nubanValid(code, digits)) return { state: "ok", bank: LABEL[code] ?? bankName };
  const fitsBanks = BANK_CODES.filter((b) => nubanValid(b.code, digits)).map((b) => LABEL[b.code] ?? b.code);
  return { state: "mismatch", bank: LABEL[code] ?? bankName, fitsBanks };
}
