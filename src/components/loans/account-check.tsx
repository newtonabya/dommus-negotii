import { checkNuban } from "@/lib/nuban";

/**
 * Says, as the account number is typed, whether it fits the bank chosen
 * (NUBAN check digit). A warning, not a block: it can't see microfinance banks
 * and fintechs, and it doesn't prove whose the account is.
 */
export function AccountCheck({ bank, accountNo }: { bank: string; accountNo: string }) {
  const c = checkNuban(bank, accountNo);
  if (c.state === "incomplete") return null;
  if (c.state === "ok") {
    return (
      <span role="status" className="text-xs font-semibold text-success">
        ✓ A valid {c.bank} account number. Check the account name with the member.
      </span>
    );
  }
  if (c.state === "unchecked") {
    return (
      <span role="status" className="text-xs text-muted">
        This bank&apos;s numbers can&apos;t be checked here (microfinance banks and fintechs): check the number carefully.
      </span>
    );
  }
  return (
    <span role="alert" className="text-xs font-semibold text-danger">
      ✗ This is not a valid {c.bank} account number: a digit is wrong, or it belongs to another bank.
      {c.fitsBanks.length > 0 && c.fitsBanks.length <= 4 ? ` It would fit: ${c.fitsBanks.join(", ")}.` : ""}
    </span>
  );
}
