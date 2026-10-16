import { describe, expect, test } from "vitest";
import { cartValidationsGenerateRun } from "../extensions/protection-validation/src/cart_validations_generate_run";
import { buildLadder, DEFAULT_RULES, quote, type ProtectionConfig } from "../shared/pricing";
import { embedEnabled, parseSettingsData } from "../app/lib/embed.server";
import { orderDetails, type OrderPayload } from "../app/lib/orders.server";
import { parseSettings } from "../app/lib/settings";
import { findOnlineStorePublication } from "../app/lib/setup.server";

const rules = { ...DEFAULT_RULES, mode: "PERCENT" as const, percent: 3, minFee: 0.5, maxFee: 100 };
const cfg: ProtectionConfig = {
  v: 1,
  enabled: true,
  rules,
  currency: "EUR",
  decimals: 2,
  ladder: buildLadder(rules, 2).map((p, i) => [p, 5000 + i]),
  productId: 7,
  handle: "shipping-protection",
  defaultOn: true,
  optInCountries: [],
  copy: { title: "", description: "", learnMoreUrl: "" },
};

const line = (variant: number, product: number, quantity: number, amount: number) => ({
  quantity,
  cost: { subtotalAmount: { amount: String(amount) } },
  merchandise: {
    __typename: "ProductVariant",
    id: `gid://shopify/ProductVariant/${variant}`,
    product: { id: `gid://shopify/Product/${product}` },
  },
});

const input = (lines: ReturnType<typeof line>[], step = "CHECKOUT_COMPLETION", lang = "EN", c: unknown = cfg) => ({
  buyerJourney: { step },
  presentmentCurrencyRate: "1.0",
  localization: { language: { isoCode: lang } },
  cart: { lines },
  validation: { metafield: c ? { jsonValue: c } : null },
});

const errors = (r: ReturnType<typeof cartValidationsGenerateRun>) => r.operations[0].validationAdd.errors;

describe("validation function", () => {
  const ok = quote(cfg, 100)!.variantId;

  test("correct protection passes", () => {
    expect(errors(cartValidationsGenerateRun(input([line(1, 1, 1, 100), line(ok, 7, 1, 3)])))).toEqual([]);
  });
  test("duplicate blocked at checkout, in the buyer's language", () => {
    const r = cartValidationsGenerateRun(input([line(1, 1, 1, 100), line(ok, 7, 2, 6)], "CHECKOUT_INTERACTION", "DE"));
    expect(errors(r)).toHaveLength(1);
    expect(errors(r)[0].message).toMatch(/Versandschutz/);
    expect(errors(r)[0].target).toBe("$.cart");
  });
  test("never blocks cart interactions (the widget swaps variants there)", () => {
    expect(errors(cartValidationsGenerateRun(input([line(ok, 7, 3, 9)], "CART_INTERACTION")))).toEqual([]);
  });
  test("no config or switched off → no errors", () => {
    expect(errors(cartValidationsGenerateRun(input([line(ok, 7, 3, 9)], undefined, "EN", null)))).toEqual([]);
    expect(errors(cartValidationsGenerateRun(input([line(ok, 7, 3, 9)], undefined, "EN", { ...cfg, enabled: false })))).toEqual([]);
  });
  test("protection alone is blocked", () => {
    expect(errors(cartValidationsGenerateRun(input([line(ok, 7, 1, 3)])))).toHaveLength(1);
  });
  test("unknown language falls back to English", () => {
    const r = cartValidationsGenerateRun(input([line(ok, 7, 1, 3)], undefined, "PT_BR"));
    expect(errors(r)[0].message).toMatch(/only covers products that are shipped/);
  });
});

describe("orderDetails", () => {
  const payload = (lines: OrderPayload["line_items"], attrs: OrderPayload["note_attributes"] = []): OrderPayload => ({
    id: 1,
    name: "#1001",
    created_at: "2026-10-16T10:00:00Z",
    currency: "USD",
    line_items: lines,
    note_attributes: attrs,
  });
  test("protected order, fee in shop money", () => {
    const d = orderDetails(
      payload(
        [
          { product_id: 1, quantity: 2, price_set: { shop_money: { amount: "20.00", currency_code: "EUR" } } },
          { product_id: 7, quantity: 1, price_set: { shop_money: { amount: "2.95", currency_code: "EUR" } } },
        ],
        [{ name: "_shipping_protection", value: "accepted" }],
      ),
      7,
      "EUR",
    );
    expect(d).toEqual({ protected: true, choice: "accepted", fee: 2.95, currency: "EUR" });
  });
  test("declined order", () => {
    const d = orderDetails(payload([{ product_id: 1, quantity: 1 }], [{ name: "_shipping_protection", value: "declined" }]), 7, "EUR");
    expect(d).toEqual({ protected: false, choice: "declined", fee: 0, currency: "EUR" });
  });
});

describe("embed detection", () => {
  const data = (disabled: boolean) =>
    `/* auto-generated */ {"current":{"blocks":{"123":{"type":"shopify://apps/shipping-protection/blocks/shipping-protection-embed/abc","disabled":${disabled},"settings":{}}}}}`;
  test("on", () => expect(embedEnabled(parseSettingsData(data(false)))).toBe(true));
  test("off", () => expect(embedEnabled(parseSettingsData(data(true)))).toBe(false));
  test("missing", () => expect(embedEnabled(parseSettingsData('{"current":"Default"}'))).toBe(false));
});

describe("parseSettings", () => {
  test("rejects junk and unsafe links", () => {
    const s = parseSettings({
      rules: { mode: "HACK", percent: "4", tiers: [{ from: "x", type: "PERCENT", value: 2 }] },
      optInCountries: ["de", "xx1", "FR", "DE"],
      copy: { learnMoreUrl: "javascript:alert(1)", title: "  Hi  " },
      enabled: "yes",
      extra: "ignored",
    });
    expect(s.rules.mode).toBe("PERCENT");
    expect(s.rules.percent).toBe(4);
    expect(s.rules.tiers[0].from).toBe(0);
    expect(s.optInCountries).toEqual(["DE", "FR"]);
    expect(s.copy.learnMoreUrl).toBe("");
    expect(s.copy.title).toBe("Hi");
    expect(s.enabled).toBe(false);
    expect("extra" in s).toBe(false);
  });
});

describe("findOnlineStorePublication", () => {
  const pub = (id: string, title: string, handles: string[]) => ({
    id,
    catalog: { title, apps: { nodes: handles.map((handle) => ({ handle })) } },
  });

  test("matches the Online Store app handle, whatever the title", () => {
    const nodes = [pub("pos", "Point of Sale", ["pos"]), pub("os", "Onlineshop", ["online_store"])];
    expect(findOnlineStorePublication(nodes)?.id).toBe("os");
  });

  test("falls back to the English title; null catalogs are skipped", () => {
    const nodes = [{ id: "x", catalog: null }, { id: "os", catalog: { title: "Online Store" } }];
    expect(findOnlineStorePublication(nodes)?.id).toBe("os");
  });

  test("undefined when there is no Online Store", () => {
    expect(findOnlineStorePublication([pub("pos", "Point of Sale", ["pos"])])).toBeUndefined();
  });
});
