import { describe, expect, it } from "vitest";
import { formatCreditBalance, UNKNOWN_BALANCE } from "./format-credit-balance";

describe("formatCreditBalance", () => {
  it("renders cents as dollars", () => {
    // The false bug report: 100000 read as "1000.00 credits". It is $1000.00.
    expect(formatCreditBalance(100_000)).toBe("1000.00");
    expect(formatCreditBalance(50)).toBe("0.50");
  });

  it("renders a real zero balance as 0.00", () => {
    expect(formatCreditBalance(0)).toBe("0.00");
  });

  it("does NOT render an unknown balance as zero", () => {
    // `useGetCredits` returns undefined while loading and after a failure. The
    // old inline `credits ?? 0` told the founder they were broke.
    expect(formatCreditBalance(undefined)).toBe(UNKNOWN_BALANCE);
    expect(formatCreditBalance(null)).toBe(UNKNOWN_BALANCE);
    expect(formatCreditBalance(undefined)).not.toBe("0.00");
  });
});
