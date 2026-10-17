import { describe, expect, test } from "vitest";
import { acceptedVariants, cartProblems, marketFor, quote, DEFAULT_RULES, type ProtectionConfig } from "../shared/pricing";
import { marketLabel, planMarketPrices, type MarketInfo } from "../app/lib/markets.server";
import { cartTransformRun } from "../extensions/protection-transform/src/cart_transform_run";
import { checkoutState, displayPrice } from "../extensions/protection-checkout/src/logic";
import { parseSettings, settingsErrors } from "../app/lib/settings";

const cfg: ProtectionConfig = {
  v: 1,
  enabled: true,
  rules: { ...DEFAULT_RULES, mode: "PERCENT", percent: 3, minFee: 1, maxFee: 50, minSubtotal: 0 },
  currency: "USD",
  decimals: 2,
  ladder: [
    [100, 11],
    [150, 12],
    [300, 13],
    [5000, 14],
  ],
  productId: 999,
  handle: "shipping-protection",
  defaultOn: true,
  optInCountries: [],
  copy: { title: "", description: "", learnMoreUrl: "" },
  markets: [{ marketId: 7, name: "Europe", countries: ["DE", "FR"], amount: 2.99, currency: "EUR", variantId: 77 }],
  checkout: true,
};

describe("market fixed prices", () => {
  test("a shopper in the market gets the market's variant and price", () => {
    expect(marketFor(cfg, "de")?.name).toBe("Europe");
    expect(marketFor(cfg, "US")).toBeNull();
    expect(quote(cfg, 100, "DE")).toMatchObject({ variantId: 77, fixed: { amount: 2.99, currency: "EUR" } });
    expect(quote(cfg, 100, "US")).toMatchObject({ variantId: 13 });
    // Still only when protection is offered at all.
    expect(quote({ ...cfg, rules: { ...cfg.rules, minSubtotal: 500 } }, 100, "DE")).toBeNull();
  });

  test("the checkout rule accepts the market variant only in its market", () => {
    expect([...acceptedVariants(cfg, 100, "FR")]).toEqual([77]);
    expect(acceptedVariants(cfg, 100, "US").has(77)).toBe(false);
    const line = (variantId: number, productId = 999, subtotal = 3) => ({ variantId, productId, quantity: 1, subtotal });
    const goods = { variantId: 1, productId: 1, quantity: 1, subtotal: 100 };
    expect(cartProblems(cfg, [goods, line(77)], 1, "DE")).toEqual([]);
    expect(cartProblems(cfg, [goods, line(77)], 1, "US")).toEqual(["PRICE"]);
    expect(cartProblems(cfg, [goods, line(13)], 1, "DE")).toEqual(["PRICE"]);
  });

  test("planning drops markets that are gone", () => {
    const markets: MarketInfo[] = [
      { id: 7, name: "Europe", currency: "EUR", countries: ["DE"], catalogId: "c", priceListId: "p" },
    ];
    const { planned, warnings } = planMarketPrices(markets, [
      { marketId: 7, amount: 2.99 },
      { marketId: 8, amount: 5 },
    ]);
    expect(planned).toEqual([{ market: markets[0], amount: 2.99, label: "2.99 EUR" }]);
    expect(warnings).toHaveLength(1);
    expect(marketLabel(3, "GBP")).toBe("3.00 GBP");
  });

  test("settings keep one price per market and need an amount", () => {
    const s = parseSettings({
      marketPrices: [
        { marketId: 7, name: "Europe", currency: "EUR", amount: "2.999" },
        { marketId: 7, amount: 9 },
        { marketId: "x", amount: 1 },
        { marketId: 8, name: "UK", currency: "gbp", amount: 0 },
      ],
    });
    expect(s.marketPrices).toEqual([
      { marketId: 7, name: "Europe", currency: "EUR", amount: 3 },
      { marketId: 8, name: "UK", currency: "", amount: 0 },
    ]);
    expect(settingsErrors(s).some((e) => e.includes("UK"))).toBe(true);
  });
});

describe("exact pricing cart transform", () => {
  const input = (country = "US", rate = 1, protectionQty = 1) => ({
    presentmentCurrencyRate: rate,
    localization: { country: { isoCode: country } },
    cart: {
      lines: [
        {
          id: "gid://shopify/CartLine/1",
          quantity: 1,
          cost: { subtotalAmount: { amount: 87 * rate } },
          merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/1", requiresShipping: true, product: { id: "gid://shopify/Product/1" } },
        },
        {
          id: "gid://shopify/CartLine/2",
          quantity: protectionQty,
          cost: { subtotalAmount: { amount: 3 } },
          merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/13", product: { id: "gid://shopify/Product/999" } },
        },
      ],
    },
    cartTransform: { metafield: { jsonValue: { ...cfg, exact: true } } },
  });

  test("sets the protection line to the exact fee, in the shopper's currency", () => {
    expect(cartTransformRun(input()).operations).toEqual([
      { lineUpdate: { cartLineId: "gid://shopify/CartLine/2", price: { adjustment: { fixedPricePerUnit: { amount: "2.61" } } } } },
    ]);
    expect(cartTransformRun(input("US", 0.9)).operations[0].lineUpdate.price.adjustment.fixedPricePerUnit.amount).toBe("2.35");
  });

  test("does nothing when off, in a fixed-price market, or with duplicates", () => {
    expect(cartTransformRun({ ...input(), cartTransform: { metafield: { jsonValue: cfg } } }).operations).toEqual([]);
    expect(cartTransformRun(input("DE")).operations).toEqual([]);
    expect(cartTransformRun(input("US", 1, 2)).operations).toEqual([]);
  });
});

describe("checkout toggle logic", () => {
  const lines = [
    { id: "a", merchandiseId: "gid://shopify/ProductVariant/1", productId: "gid://shopify/Product/1", quantity: 1, amount: 100, requiresShipping: true },
  ];
  test("offers the same variant and price as the storefront", () => {
    const s = checkoutState(cfg, lines, 1, "US");
    expect(s.offered).toBe(true);
    expect(s.quote?.variantId).toBe(13);
    expect(displayPrice(cfg, s.quote!, 1)).toEqual({ amount: 3, currency: null });
    expect(displayPrice({ ...cfg, exact: true }, s.quote!, 1)).toEqual({ amount: 3, currency: null });
    const eu = checkoutState(cfg, lines, 1, "DE");
    expect(displayPrice(cfg, eu.quote!, 1)).toEqual({ amount: 2.99, currency: "EUR" });
  });
  test("never guesses: unknown rate or tag coverage means no toggle", () => {
    expect(checkoutState(cfg, lines, null, "US").offered).toBe(false);
    const tagged = { ...cfg, coverage: { mode: "ONLY" as const, tags: ["fragile"], productTypes: [], vendors: [], productIds: [] } };
    expect(checkoutState(tagged, lines, 1, "US").offered).toBe(false);
    expect(checkoutState(cfg, [], 1, "US").offered).toBe(false);
    // Only when the plan includes the checkout toggle.
    expect(checkoutState({ ...cfg, checkout: false }, lines, 1, "US").offered).toBe(false);
  });
});
