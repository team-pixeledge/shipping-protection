import { describe, expect, test } from "vitest";
import {
  buildLadder,
  cartProblems,
  computeFee,
  DEFAULT_RULES,
  MAX_LADDER,
  quote,
  rulesErrors,
  snapIndex,
  startsOn,
  type PricingRules,
  type ProtectionConfig,
} from "../shared/pricing";

const rules = (r: Partial<PricingRules>): PricingRules => ({ ...DEFAULT_RULES, ...r });

function config(r: PricingRules, extra: Partial<ProtectionConfig> = {}): ProtectionConfig {
  const prices = buildLadder(r, 2);
  return {
    v: 1,
    enabled: true,
    rules: r,
    currency: "EUR",
    decimals: 2,
    ladder: prices.map((p, i) => [p, 1000 + i]),
    productId: 7,
    handle: "shipping-protection",
    defaultOn: true,
    optInCountries: ["DE"],
    copy: { title: "", description: "", learnMoreUrl: "" },
    ...extra,
  };
}

describe("computeFee", () => {
  test("fixed", () => {
    expect(computeFee(rules({ mode: "FIXED", fixedFee: 2.5 }), 10)).toBe(2.5);
  });
  test("percent is clamped to floor and cap", () => {
    const r = rules({ mode: "PERCENT", percent: 3, minFee: 1, maxFee: 20 });
    expect(computeFee(r, 10)).toBe(1); // 0.30 → floor
    expect(computeFee(r, 100)).toBeCloseTo(3);
    expect(computeFee(r, 5000)).toBe(20); // 150 → cap
  });
  test("tiers pick the highest tier reached", () => {
    const r = rules({ mode: "TIERED" }); // 0→1.95, 50→2.95, 150→2%
    expect(computeFee(r, 49.99)).toBe(1.95);
    expect(computeFee(r, 50)).toBe(2.95);
    expect(computeFee(r, 200)).toBeCloseTo(4);
  });
  test("not offered: empty cart, below minimum subtotal, below first tier", () => {
    expect(computeFee(DEFAULT_RULES, 0)).toBeNull();
    expect(computeFee(rules({ minSubtotal: 30 }), 29)).toBeNull();
    expect(computeFee(rules({ mode: "TIERED", tiers: [{ from: 20, type: "FIXED", value: 1 }] }), 19)).toBeNull();
  });
});

describe("buildLadder", () => {
  test("fixed mode has exactly one price", () => {
    expect(buildLadder(rules({ mode: "FIXED", fixedFee: 2.95 }), 2)).toEqual([295]);
  });
  test("narrow percent range gets every cent", () => {
    const l = buildLadder(rules({ mode: "PERCENT", minFee: 1, maxFee: 2 }), 2);
    expect(l[0]).toBe(100);
    expect(l.at(-1)).toBe(200);
    expect(l).toHaveLength(101);
  });
  test("wide range stays within the cap and covers both ends", () => {
    const l = buildLadder(rules({ mode: "PERCENT", minFee: 0.5, maxFee: 1000 }), 2);
    expect(l.length).toBeLessThanOrEqual(MAX_LADDER);
    expect(l[0]).toBe(50);
    expect(l.at(-1)).toBe(100000);
    // Geometric, ~3.1% apart (2000× range over 250 points); rounding to
    // whole cents widens the first few steps a little (50 → 52 is 4%).
    for (let i = 1; i < l.length; i++) expect(l[i] / l[i - 1]).toBeLessThanOrEqual(1.045);
  });
  test("tiers include each fixed fee exactly", () => {
    const l = buildLadder(rules({ mode: "TIERED" }), 2);
    expect(l).toContain(195);
    expect(l).toContain(295);
    expect(l.length).toBeLessThanOrEqual(MAX_LADDER);
  });
  test("zero-decimal currency (JPY)", () => {
    const l = buildLadder(rules({ mode: "PERCENT", minFee: 100, maxFee: 300 }), 0);
    expect(l[0]).toBe(100);
    expect(l.at(-1)).toBe(300);
  });
});

test("snapIndex picks nearest, ties up", () => {
  const p = [100, 200, 300];
  expect(snapIndex(p, 149)).toBe(0);
  expect(snapIndex(p, 150)).toBe(1);
  expect(snapIndex(p, 10)).toBe(0);
  expect(snapIndex(p, 999)).toBe(2);
});

describe("quote", () => {
  test("percent fee lands on a ladder price within 2%", () => {
    const cfg = config(rules({ mode: "PERCENT", percent: 3, minFee: 0.5, maxFee: 500 }));
    for (const subtotal of [20, 87.3, 412.11, 9000]) {
      const q = quote(cfg, subtotal)!;
      expect(Math.abs(q.priceMinor / 100 - q.fee) / q.fee).toBeLessThan(0.02);
    }
  });
  test("disabled → null", () => {
    expect(quote(config(DEFAULT_RULES, { enabled: false }), 100)).toBeNull();
  });
});

test("startsOn respects opt-in countries", () => {
  const cfg = config(DEFAULT_RULES);
  expect(startsOn(cfg, "US")).toBe(true);
  expect(startsOn(cfg, "de")).toBe(false);
  expect(startsOn({ ...cfg, defaultOn: false }, "US")).toBe(false);
});

describe("cartProblems", () => {
  const cfg = config(rules({ mode: "PERCENT", percent: 3, minFee: 0.5, maxFee: 500 }));
  const item = (subtotal: number) => ({ variantId: 1, productId: 1, quantity: 1, subtotal });
  const prot = (variantId: number, quantity = 1) => ({ variantId, productId: 7, quantity, subtotal: 0 });

  test("no protection, no problem", () => {
    expect(cartProblems(cfg, [item(100)], 1)).toEqual([]);
  });
  test("correct variant passes", () => {
    const q = quote(cfg, 100)!;
    expect(cartProblems(cfg, [item(100), prot(q.variantId)], 1)).toEqual([]);
  });
  test("duplicate quantity", () => {
    const q = quote(cfg, 100)!;
    expect(cartProblems(cfg, [item(100), prot(q.variantId, 2)], 1)).toEqual(["DUPLICATE"]);
  });
  test("protection alone", () => {
    expect(cartProblems(cfg, [prot(1000)], 1)).toEqual(["ALONE"]);
  });
  test("cheap variant on a big cart is a price problem", () => {
    const cheapest = cfg.ladder[0][1];
    expect(cartProblems(cfg, [item(5000), prot(cheapest)], 1)).toEqual(["PRICE"]);
  });
  test("presentment currency is converted back with the rate", () => {
    const q = quote(cfg, 100)!; // €100
    // Cart in a currency worth 1.1 per EUR: lines show 110.
    expect(cartProblems(cfg, [item(110), prot(q.variantId)], 1.1)).toEqual([]);
  });
  test("small drift is tolerated", () => {
    const q = quote(cfg, 100)!;
    expect(cartProblems(cfg, [item(102), prot(q.variantId)], 1)).toEqual([]);
  });
  test("below minimum subtotal → unavailable", () => {
    const c = config(rules({ minSubtotal: 50 }));
    expect(cartProblems(c, [item(20), prot(c.ladder[0][1])], 1)).toEqual(["UNAVAILABLE"]);
  });
});

describe("rulesErrors", () => {
  test("defaults are valid in every mode", () => {
    for (const mode of ["FIXED", "PERCENT", "TIERED"] as const)
      expect(rulesErrors(rules({ mode }))).toEqual([]);
  });
  test("percent without a cap", () => {
    expect(rulesErrors(rules({ mode: "PERCENT", maxFee: 0 }))).not.toEqual([]);
  });
  test("duplicate tier start", () => {
    const tiers = [
      { from: 0, type: "FIXED" as const, value: 1 },
      { from: 0, type: "FIXED" as const, value: 2 },
    ];
    expect(rulesErrors(rules({ mode: "TIERED", tiers }))).toContain("Two tiers start at the same order value.");
  });
});
