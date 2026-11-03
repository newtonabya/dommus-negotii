/**
 * Normalises a Nigerian mobile number to E.164 (+234…). Accepts 0803…, 234803…,
 * +234 803 …; returns null when it isn't a valid Nigerian mobile number.
 * Safe in the browser (no Node imports).
 */
export function normalizeNigerianPhone(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, "");
  let national: string;
  if (/^\+234\d{10}$/.test(digits)) national = digits.slice(4);
  else if (/^234\d{10}$/.test(digits)) national = digits.slice(3);
  else if (/^0\d{10}$/.test(digits)) national = digits.slice(1);
  // Spreadsheets store 0803… as the number 803…, dropping the leading zero.
  else if (/^[789]\d{9}$/.test(digits)) national = digits;
  else return null;
  return /^[789][01]\d{8}$/.test(national) ? `+234${national}` : null;
}
