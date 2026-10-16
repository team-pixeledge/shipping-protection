import { describe, expect, test } from "vitest";
import {
  buildLadder,
  cartProblems,
  DEFAULT_COVERAGE,
  DEFAULT_RULES,
  lineCovered,
  matchesTags,
  quote,
  usesTags,
  type CartLine,
  type Coverage,
  type ProtectionConfig,
} from "../shared/pricing";
import { cartValidationsGenerateRun } from "../extensions/protection-validation/src/cart_validations_generate_run";
import { parseCoverage, parseSettings, settingsErrors } from "../app/lib/settings";

const l = (patch: Partial<CartLine> = {}): CartLine => ({ variantId: 1, productId: 10, quantity: 1, subtotal: 50, ...patch });
const cov = (patch: Partial<Coverage>): Coverage => ({ ...DEFAULT_COVERAGE, ...patch });

describe("lineCovered", () => {
  test("digital items and gift cards are never covered", () => {
    expect(lineCovered(undefined, l({ requiresShipping: false }))).toBe(false);
    expect(lineCovered(cov({ mode: "ONLY", productIds: [10] }), l({ giftCard: true }))).toBe(false);
    expect(lineCovered(undefined, l())).toBe(true); // unknown facts (old inputs) = covered
  });

  test("ONLY covers matches; EXCEPT covers everything else", () => {
    const only = cov({ mode: "ONLY", tags: ["fragile"], productTypes: ["Glass"], vendors: ["Acme"], productIds: [42] });
    expect(lineCovered(only, l({ tagMatch: true }))).toBe(true);
    expect(lineCovered(only, l({ productType: "glass " }))).toBe(true);
    expect(lineCovered(only, l({ vendor: "ACME" }))).toBe(true);
    expect(lineCovered(only, l({ productId: 42 }))).toBe(true);
    expect(lineCovered(only, l({ productType: "", vendor: null }))).toBe(false);
    const except = { ...only, mode: "EXCEPT" as const };
    expect(lineCovered(except, l({ tagMatch: true }))).toBe(false);
    expect(lineCovered(except, l({ productType: "Paper" }))).toBe(true);
  });

  test("tags match ignoring case; ALL never needs tags", () => {
    expect(matchesTags(cov({ tags: ["Fragile"] }), ["fragile", "sale"])).toBe(true);
    expect(matchesTags(cov({ tags: ["Fragile"] }), ["sale"])).toBe(false);
    expect(usesTags(cov({ mode: "ALL", tags: ["x"] }))).toBe(false);
    expect(usesTags(cov({ mode: "EXCEPT", tags: ["x"] }))).toBe(true);
  });
});

const rules = { ...DEFAULT_RULES, mode: "FIXED" as const, fixedFee: 2 };
const cfg = (coverage?: Coverage): ProtectionConfig => ({
  v: 1,
  enabled: true,
  rules,
  currency: "EUR",
  decimals: 2,
  ladder: buildLadder(rules, 2).map((p, i) => [p, 900 + i]),
  productId: 7,
  handle: "shipping-protection",
  defaultOn: true,
  optInCountries: [],
  copy: { title: "", description: "", learnMoreUrl: "" },
  ...(coverage ? { coverage } : {}),
});
const prot = l({ variantId: 900, productId: 7, subtotal: 2 });

describe("cartProblems with coverage", () => {
  test("protection with only digital items is ALONE", () => {
    expect(cartProblems(cfg(), [prot, l({ requiresShipping: false })], 1)).toEqual(["ALONE"]);
    expect(cartProblems(cfg(), [prot, l({ requiresShipping: true })], 1)).toEqual([]);
  });

  test("the fee is judged on covered items only", () => {
    const pct = { ...DEFAULT_RULES, mode: "PERCENT" as const, percent: 10, minFee: 1, maxFee: 100 };
    const c: ProtectionConfig = { ...cfg(cov({ mode: "EXCEPT", vendors: ["Big"] })), rules: pct };
    c.ladder = buildLadder(pct, 2).map((p, i) => [p, 900 + i]);
    // Covered subtotal 50 → fee 5.00; the excluded 500 must not count.
    const five = quote(c, 50)!.variantId;
    const lines = [l({ variantId: five, productId: 7, subtotal: 5 }), l({ subtotal: 50 }), l({ productId: 11, subtotal: 500, vendor: "Big" })];
    expect(cartProblems(c, lines, 1)).toEqual([]);
    const fiftyFive = quote(c, 550)!.variantId;
    expect(cartProblems(c, [{ ...lines[0], variantId: fiftyFive }, lines[1], lines[2]], 1)).toEqual(["PRICE"]);
  });
});

describe("validation function reads coverage facts", () => {
  type Input = Parameters<typeof cartValidationsGenerateRun>[0];
  const input = (lines: unknown[], coverage?: Coverage): Input => ({
    buyerJourney: { step: "CHECKOUT_COMPLETION" },
    presentmentCurrencyRate: "1.0",
    localization: { language: { isoCode: "EN" } },
    cart: { lines: lines as Input["cart"]["lines"] },
    validation: { metafield: { jsonValue: cfg(coverage) } },
  });
  const line = (variant: number, product: number, amount: number, extra: Record<string, unknown> = {}, productExtra = {}) => ({
    quantity: 1,
    cost: { subtotalAmount: { amount: String(amount) } },
    merchandise: {
      __typename: "ProductVariant",
      id: `gid://shopify/ProductVariant/${variant}`,
      ...extra,
      product: { id: `gid://shopify/Product/${product}`, ...productExtra },
    },
  });

  test("a digital-only cart with protection is blocked", () => {
    const out = cartValidationsGenerateRun(input([line(900, 7, 2), line(1, 10, 20, { requiresShipping: false })]));
    expect(out.operations[0].validationAdd.errors[0].message).toMatch(/only covers products that are shipped/);
  });

  test("hasAnyTag from the input query decides tag rules", () => {
    const only = cov({ mode: "ONLY", tags: ["fragile"] });
    const tagged = line(1, 10, 20, { requiresShipping: true }, { hasAnyTag: true });
    const untagged = line(1, 10, 20, { requiresShipping: true }, { hasAnyTag: false });
    expect(cartValidationsGenerateRun(input([line(900, 7, 2), tagged], only)).operations[0].validationAdd.errors).toEqual([]);
    expect(cartValidationsGenerateRun(input([line(900, 7, 2), untagged], only)).operations[0].validationAdd.errors).toHaveLength(1);
  });
});

describe("coverage settings", () => {
  test("parsed, de-duplicated and capped", () => {
    const c = parseCoverage({ mode: "EXCEPT", tags: [" A ", "a", "", 5, "b"], productIds: ["12", 12, -1, "x"], vendors: "nope" });
    expect(c).toEqual({ mode: "EXCEPT", tags: ["A", "b"], productTypes: [], vendors: [], productIds: [12] });
    expect(parseCoverage({ mode: "WHATEVER" }).mode).toBe("ALL");
    expect(parseCoverage({ tags: Array.from({ length: 80 }, (_, i) => `t${i}`) }).tags).toHaveLength(50);
  });

  test("ONLY with no rules would cover nothing — refused", () => {
    const s = parseSettings({ coverage: { mode: "ONLY" } });
    expect(settingsErrors(s).some((e) => e.includes("Only products that match"))).toBe(true);
    expect(settingsErrors(parseSettings({ coverage: { mode: "ONLY", tags: ["x"] } }))).toEqual([]);
  });

  test("product titles are kept only for selected products", () => {
    const s = parseSettings({ coverage: { productIds: [1] }, coverageProductTitles: { "1": "Vase", "2": "Old" } });
    expect(s.coverageProductTitles).toEqual({ "1": "Vase" });
  });
});
