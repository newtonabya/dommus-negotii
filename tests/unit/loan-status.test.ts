import { canTransition, LOAN_STATUSES, nextStatuses, OPEN_STATUSES, TRANSITIONS, type LoanActor } from "@/modules/credit/domain/loan-status";

describe("loan state machine (PRD F7)", () => {
  it("allows each transition only for its role and prior status", () => {
    expect(canTransition("DRAFT", "SUBMITTED", "self.loan.apply")).toBe(true);
    expect(canTransition(null, "SUBMITTED", "loan.application.captureAssisted")).toBe(true);
    expect(canTransition("SUBMITTED", "VERIFIED", "loan.verify")).toBe(true);
    expect(canTransition("VERIFIED", "RECOMMENDED", "loan.recommend")).toBe(true);
    expect(canTransition("RECOMMENDED", "APPROVED", "loan.approve")).toBe(true);
    expect(canTransition("APPROVED", "DISBURSEMENT_PENDING", "voucher.disbursement.prepare")).toBe(true);
    expect(canTransition("DISBURSEMENT_PENDING", "ACTIVE", "voucher.disbursement.verify")).toBe(true);
    expect(canTransition("DISBURSEMENT_PENDING", "APPROVED", "voucher.disbursement.verify")).toBe(true);
    expect(canTransition("ACTIVE", "CLOSED", "system")).toBe(true);
    expect(canTransition("CLOSED", "ACTIVE", "system")).toBe(true);
  });

  it("refuses the wrong role, the wrong order and skipped steps", () => {
    expect(canTransition("RECOMMENDED", "APPROVED", "loan.verify")).toBe(false); // Loan Officer can't approve
    expect(canTransition("SUBMITTED", "APPROVED", "loan.approve")).toBe(false); // must be recommended first
    expect(canTransition("SUBMITTED", "RECOMMENDED", "loan.recommend")).toBe(false); // must be verified first
    expect(canTransition("APPROVED", "ACTIVE", "voucher.disbursement.verify")).toBe(false); // needs a voucher
    expect(canTransition("DISBURSEMENT_PENDING", "ACTIVE", "voucher.disbursement.prepare")).toBe(false); // Cashier can't verify
    expect(canTransition("RECOMMENDED", "DECLINED", "loan.decline")).toBe(false); // Management rejects instead
    expect(canTransition("APPROVED", "CANCELLED", "self.loan.apply")).toBe(false); // member can't cancel after approval
    expect(canTransition("DISBURSEMENT_PENDING", "CANCELLED", "loan.cancelApproved")).toBe(false); // voucher already prepared
    expect(canTransition("CLOSED", "ACTIVE", "voucher.disbursement.verify")).toBe(false); // only the system reopens
  });

  it("has exactly the PRD's 18 transitions and terminal end states", () => {
    expect(TRANSITIONS).toHaveLength(18);
    const actors = [...new Set(TRANSITIONS.map((t) => t.by))] as LoanActor[];
    for (const end of ["DECLINED", "REJECTED", "CANCELLED"] as const) {
      expect(actors.flatMap((a) => nextStatuses(end, a))).toEqual([]);
    }
  });

  it("counts SUBMITTED to ACTIVE as open, nothing else", () => {
    expect([...OPEN_STATUSES]).toEqual(["SUBMITTED", "VERIFIED", "RECOMMENDED", "APPROVED", "DISBURSEMENT_PENDING", "ACTIVE"]);
    expect(LOAN_STATUSES.filter((s) => !OPEN_STATUSES.includes(s))).toEqual(["DRAFT", "CLOSED", "DECLINED", "REJECTED", "CANCELLED"]);
  });
});
