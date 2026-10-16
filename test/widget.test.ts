// @vitest-environment jsdom
// The storefront widget against a fake Ajax Cart API: what it adds, swaps
// and removes, and that it does each in one request.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildLadder, quote, type ProtectionConfig } from "../shared/pricing";

const PROTECTION = 7;
const rules = {
  mode: "PERCENT" as const,
  fixedFee: 0,
  percent: 3,
  tiers: [],
  minFee: 0.5,
  maxFee: 100,
  minSubtotal: 0,
};
const baseCfg: ProtectionConfig = {
  v: 1,
  enabled: true,
  rules,
  currency: "EUR",
  decimals: 2,
  ladder: buildLadder(rules, 2).map((p, i) => [p, 5000 + i]),
  productId: PROTECTION,
  handle: "shipping-protection",
  defaultOn: true,
  optInCountries: ["DE"],
  copy: { title: "", description: "", learnMoreUrl: "" },
};
const priceOf = (variant: number) => baseCfg.ladder.find(([, v]) => v === variant)?.[0] ?? 0;

interface Item {
  key: string;
  product_id: number;
  variant_id: number;
  quantity: number;
  price: number;
  handle?: string;
  requires_shipping?: boolean;
  gift_card?: boolean;
  product_type?: string;
  vendor?: string;
}

class FakeCart {
  items: Item[] = [];
  attributes: Record<string, string> = {};
  updates: unknown[] = [];
  n = 0;
  /** /products/<handle>.js tags, and how often they were read. */
  tags: Record<string, string[]> = {};
  productReads = 0;

  json() {
    const items = this.items.map((i) => ({
      ...i,
      final_price: i.price,
      final_line_price: i.price * i.quantity,
    }));
    return {
      token: "tok",
      item_count: items.reduce((s, i) => s + i.quantity, 0),
      items,
      attributes: this.attributes,
    };
  }

  setQty(key: string, qty: number) {
    const byKey = this.items.find((i) => i.key === key);
    const byVariant = this.items.find((i) => String(i.variant_id) === key);
    const target = byKey ?? byVariant;
    if (target) {
      if (qty === 0) this.items = this.items.filter((i) => i !== target);
      else target.quantity = qty;
    } else if (qty > 0) {
      const variant = Number(key);
      const product = variant >= 5000 ? PROTECTION : 1;
      this.items.push({
        key: `${variant}:${++this.n}`,
        product_id: product,
        variant_id: variant,
        quantity: qty,
        price: product === PROTECTION ? priceOf(variant) : 0,
      });
    }
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith("/cart.js")) return Response.json(this.json());
    const product = url.match(/\/products\/([^/]+)\.js$/);
    if (product) {
      this.productReads++;
      return Response.json({ tags: this.tags[decodeURIComponent(product[1])] ?? [] });
    }
    if (url.endsWith("/cart/update.js")) {
      this.updates.push(body);
      for (const [k, q] of Object.entries(body.updates ?? {})) this.setQty(k, q as number);
      Object.assign(this.attributes, body.attributes ?? {});
      return Response.json(this.json());
    }
    if (url.endsWith("/cart/change.js")) {
      this.setQty(body.id, body.quantity);
      return Response.json(this.json());
    }
    if (url.endsWith("/cart/add.js")) {
      this.items.push({ key: `1:${++this.n}`, product_id: 1, variant_id: body.id, quantity: 1, price: body.price });
      return Response.json({});
    }
    return new Response("not found", { status: 404 });
  };

  /** A real product line, price in cents. */
  add(cents: number, extra: Partial<Item> = {}) {
    const n = ++this.n;
    this.items.push({ key: `1:${n}`, product_id: 1, variant_id: 1, quantity: 1, price: cents, handle: `p${n}`, ...extra });
  }
  protection() {
    return this.items.filter((i) => i.product_id === PROTECTION);
  }
}

let cart: FakeCart;
const settle = () => new Promise((r) => setTimeout(r, 250));

async function boot(cfg: Partial<ProtectionConfig> = {}, country = "US") {
  const env = {
    country,
    currency: "EUR",
    locale: "en",
    itemCount: cart.json().item_count,
    placement: "auto",
    hideLine: true,
    refresh: "events",
    refreshEvent: "",
    t: { title: "Shipping protection", description: "Cover it.", learnMore: "Learn more", added: "Protected" },
  };
  document.body.innerHTML = `
    <script type="application/json" id="sp-config">${JSON.stringify({ ...baseCfg, ...cfg })}</script>
    <script type="application/json" id="sp-env">${JSON.stringify(env)}</script>
    <form action="/cart"><button name="checkout">Check out</button></form>`;
  vi.resetModules();
  await import("../widget/protection");
  await settle();
}

beforeEach(() => {
  cart = new FakeCart();
  window.fetch = cart.fetch as typeof window.fetch;
  delete window.__shippingProtection;
  sessionStorage.clear();
});
afterEach(() => {
  // A fresh <body>: each test's widget instance observes the body it booted
  // on, so swapping the element retires the previous instance.
  document.documentElement.replaceChild(document.createElement("body"), document.body);
});

describe("widget", () => {
  test("default on: adds the right price variant in one request and renders above checkout", async () => {
    cart.add(10000); // €100
    await boot();
    expect(cart.updates).toHaveLength(1);
    expect(cart.protection()).toHaveLength(1);
    expect(cart.protection()[0].variant_id).toBe(quote(baseCfg, 100)!.variantId);
    const box = document.querySelector("[data-sp-auto] .sp-widget")!;
    expect(box).toBeTruthy();
    expect((box.querySelector(".sp-check") as HTMLInputElement).checked).toBe(true);
    // 3% of €100, at the nearest ladder price.
    const expected = (quote(baseCfg, 100)!.priceMinor / 100).toFixed(2);
    expect(box.querySelector(".sp-price")!.textContent).toContain(expected);
  });

  test("opt-in country: not added, toggle shown unticked", async () => {
    cart.add(10000);
    await boot({}, "DE");
    expect(cart.protection()).toHaveLength(0);
    expect((document.querySelector(".sp-check") as HTMLInputElement).checked).toBe(false);
  });

  test("ticking the toggle adds it and records the choice", async () => {
    cart.add(10000);
    await boot({}, "DE");
    const input = document.querySelector(".sp-check") as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    await settle();
    expect(cart.protection()).toHaveLength(1);
    expect(cart.attributes._shipping_protection).toBe("accepted");
  });

  test("theme adds a product: protection is re-priced with a single swap", async () => {
    cart.add(10000);
    await boot();
    const before = cart.protection()[0].variant_id;
    await window.fetch("/cart/add.js", { method: "POST", body: JSON.stringify({ id: 2, price: 20000 }) });
    await settle();
    expect(cart.protection()).toHaveLength(1);
    expect(cart.protection()[0].variant_id).not.toBe(before);
    expect(cart.protection()[0].variant_id).toBe(quote(baseCfg, 300)!.variantId);
    expect(cart.updates).toHaveLength(2);
  });

  test("removing it with the theme's remove button counts as declining", async () => {
    cart.add(10000);
    await boot();
    const key = cart.protection()[0].key;
    await window.fetch("/cart/change.js", { method: "POST", body: JSON.stringify({ id: key, quantity: 0 }) });
    await settle();
    expect(cart.protection()).toHaveLength(0);
    expect(cart.attributes._shipping_protection).toBe("declined");
  });

  test("a pricing change dropping the line isn't treated as declining", async () => {
    cart.add(10000);
    sessionStorage.setItem("sp-seen:tok", "999"); // a variant no longer on the ladder
    await boot();
    expect(cart.protection()).toHaveLength(1);
    expect(cart.attributes._shipping_protection).toBeUndefined();
  });

  test("duplicates are collapsed to one", async () => {
    cart.add(10000);
    cart.setQty(String(quote(baseCfg, 100)!.variantId), 3);
    await boot();
    expect(cart.protection()).toHaveLength(1);
    expect(cart.protection()[0].quantity).toBe(1);
  });

  test("protection alone in the cart is removed", async () => {
    cart.setQty("5000", 1);
    await boot();
    expect(cart.protection()).toHaveLength(0);
  });

  test("switched off: removes protection still in a cart", async () => {
    cart.add(10000);
    cart.setQty(String(quote(baseCfg, 100)!.variantId), 1);
    await boot({ enabled: false });
    expect(cart.protection()).toHaveLength(0);
    expect(document.querySelector(".sp-widget")).toBeNull();
  });

  test("hides the protection line in the theme's cart list", async () => {
    cart.add(10000);
    await boot();
    const ul = document.createElement("ul");
    ul.innerHTML = `<li class="cart-item"><a href="/products/shipping-protection?variant=1">Shipping protection</a></li>
      <li class="cart-item"><a href="/products/t-shirt">T-shirt</a></li>`;
    document.body.appendChild(ul);
    await settle();
    const [prot, shirt] = ul.querySelectorAll("li");
    expect(prot.classList.contains("sp-hidden-line")).toBe(true);
    expect(shirt.classList.contains("sp-hidden-line")).toBe(false);
  });

  test("digital-only cart: protection isn't offered, and is removed if present", async () => {
    cart.add(10000, { requires_shipping: false });
    cart.setQty(String(baseCfg.ladder[0][1]), 1);
    await boot();
    expect(cart.protection()).toHaveLength(0);
    expect((document.querySelector("[data-sp-auto]") as HTMLElement).hidden).toBe(true);
  });

  test("the fee counts covered products only", async () => {
    cart.add(10000);
    cart.add(50000, { product_id: 2, vendor: "BigCo" });
    await boot({ coverage: { mode: "EXCEPT", tags: [], productTypes: [], vendors: ["bigco"], productIds: [] } });
    expect(cart.protection()[0].variant_id).toBe(quote(baseCfg, 100)!.variantId);
  });

  test("tag rules read each product's tags once", async () => {
    cart.add(10000, { product_id: 3, handle: "vase" });
    cart.tags.vase = ["Fragile"];
    await boot({ coverage: { mode: "ONLY", tags: ["fragile"], productTypes: [], vendors: [], productIds: [] } });
    expect(cart.protection()).toHaveLength(1);
    const reads = cart.productReads;
    await window.fetch("/cart/update.js", { method: "POST", body: JSON.stringify({ updates: {} }) });
    await settle();
    expect(cart.productReads).toBe(reads); // cached for the session
  });

  test("ONLY rules with no matching product: not offered", async () => {
    cart.add(10000, { product_id: 3, handle: "mug" });
    await boot({ coverage: { mode: "ONLY", tags: ["fragile"], productTypes: [], vendors: [], productIds: [] } });
    expect(cart.protection()).toHaveLength(0);
  });
});
