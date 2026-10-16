import { describe, expect, test } from "vitest";
import { allocateRefund, defaultKind, KIND_SCOPES } from "../app/lib/claims";
import { csvCell } from "../app/lib/program.server";

describe("allocateRefund", () => {
  const sources = [
    { parentId: "t1", gateway: "shopify_payments", max: 30 },
    { parentId: "t2", gateway: "gift_card", max: 20.5 },
  ];
  test("fills payments in order, never past what each can refund", () => {
    expect(allocateRefund(sources, 10)).toEqual([{ parentId: "t1", gateway: "shopify_payments", amount: 10 }]);
    expect(allocateRefund(sources, 45.25)).toEqual([
      { parentId: "t1", gateway: "shopify_payments", amount: 30 },
      { parentId: "t2", gateway: "gift_card", amount: 15.25 },
    ]);
  });
  test("refuses more than the payments hold, and nothing", () => {
    expect(allocateRefund(sources, 50.51)).toBeNull();
    expect(allocateRefund(sources, 0)).toBeNull();
    expect(allocateRefund([], 1)).toBeNull();
  });
  test("cents survive floating point", () => {
    const r = allocateRefund([{ parentId: "a", gateway: "g", max: 0.3 }], 0.1 + 0.2)!;
    expect(r[0].amount).toBe(0.3);
  });
});

describe("resolution kinds", () => {
  test("approval choice → first action; optional scopes per action", () => {
    expect(defaultKind("REFUND")).toBe("REFUND");
    expect(defaultKind("OTHER")).toBe("MANUAL");
    expect(defaultKind(null)).toBe("MANUAL");
    expect(KIND_SCOPES.REPLACEMENT).toEqual(["write_draft_orders"]);
    expect(KIND_SCOPES.REFUND).toEqual([]);
  });
});

describe("csvCell", () => {
  test("quotes and defuses formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell(null)).toBe("");
  });
});
