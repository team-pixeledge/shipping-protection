import { describe, expect, test } from "vitest";
import {
  buildClaimItems,
  canTransition,
  claimableLines,
  claimFlags,
  DEFAULT_CLAIM_SETTINGS,
  normalizeOrderName,
  orderEligibility,
  parseClaimSettings,
  pathnameAllowed,
  sameEmail,
  typeProblem,
  type ClaimOrder,
  type ClaimSettings,
  type OrderLine,
} from "../app/lib/claims";
import { signToken, tokenShop, verifyToken } from "../app/lib/claim-token.server";
import { DEFAULT_COVERAGE } from "../shared/pricing";
import { toClaimOrder } from "../app/lib/claims.server";
import { claimFormPage, esc, lookupPage, statusPage } from "../app/lib/portal-pages";

const SHOP = "demo.myshopify.com";
const PROTECTION = "gid://shopify/Product/999";
const now = new Date("2026-10-16T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

const settings: ClaimSettings = { ...DEFAULT_CLAIM_SETTINGS, enabled: true };

function line(p: Partial<OrderLine> & Pick<OrderLine, "id" | "title" | "quantity" | "unitAmount" | "productId">): OrderLine {
  return { variantTitle: null, image: null, variantId: null, requiresShipping: true, giftCard: false, productType: null, vendor: null, tags: [], ...p };
}

const order = (patch: Partial<ClaimOrder> = {}): ClaimOrder => ({
  id: "5001",
  name: "#1001",
  email: "Jane@Example.com",
  customerId: "77",
  createdAt: daysAgo(10),
  cancelled: false,
  currency: "EUR",
  lines: [
    line({ id: "gid://shopify/LineItem/1", title: "Vase", variantTitle: "Blue", quantity: 2, unitAmount: 24.5, productId: "gid://shopify/Product/1", tags: ["Fragile"] }),
    line({ id: "gid://shopify/LineItem/2", title: "Shipping protection", variantTitle: "2.95", quantity: 1, unitAmount: 2.95, productId: PROTECTION }),
    line({ id: "gid://shopify/LineItem/3", title: "Refunded mug", quantity: 0, unitAmount: 9, productId: "gid://shopify/Product/3" }),
    line({ id: "gid://shopify/LineItem/4", title: "E-book", quantity: 1, unitAmount: 5, productId: "gid://shopify/Product/4", requiresShipping: false }),
    line({ id: "gid://shopify/LineItem/5", title: "Gift card", quantity: 1, unitAmount: 25, productId: "gid://shopify/Product/5", giftCard: true }),
    line({ id: "gid://shopify/LineItem/6", title: "Poster", quantity: 1, unitAmount: 10, productId: "gid://shopify/Product/6", productType: "Print", vendor: "Acme" }),
  ],
  shipments: [{ status: "IN_TRANSIT", shippedAt: daysAgo(8), deliveredAt: null, tracking: [{ number: "1Z9", company: "UPS", url: null }] }],
  ...patch,
});

describe("claim settings", () => {
  test("off by default and clamped", () => {
    expect(parseClaimSettings(undefined)).toEqual(DEFAULT_CLAIM_SETTINGS);
    expect(DEFAULT_CLAIM_SETTINGS.enabled).toBe(false);
    const s = parseClaimSettings({ enabled: true, windowDays: 9999, maxPerOrder: 0, notifyEmail: "not-an-email", policy: " x " });
    expect(s).toMatchObject({ enabled: true, windowDays: 365, maxPerOrder: 1, notifyEmail: "", policy: "x" });
    expect(parseClaimSettings({ notifyEmail: "ops@store.com" }).notifyEmail).toBe("ops@store.com");
  });
});

describe("order lookup helpers", () => {
  test("names and emails compare loosely", () => {
    expect(normalizeOrderName(" #1001 ")).toBe(normalizeOrderName("1001"));
    expect(normalizeOrderName("#SL-1001")).toBe("sl-1001");
    expect(sameEmail("jane@example.com ", "JANE@example.com")).toBe(true);
    expect(sameEmail(null, null)).toBe(false);
    expect(sameEmail("", "")).toBe(false);
  });

  test("the protection line, removed lines, digital items and gift cards can't be claimed", () => {
    expect(claimableLines(order(), PROTECTION).map((l) => l.title)).toEqual(["Vase", "Poster"]);
  });

  test("claimable lines follow the store's coverage rules", () => {
    const only = { ...DEFAULT_COVERAGE, mode: "ONLY" as const, tags: ["fragile"] };
    expect(claimableLines(order(), PROTECTION, only).map((l) => l.title)).toEqual(["Vase"]);
    const except = { ...DEFAULT_COVERAGE, mode: "EXCEPT" as const, vendors: ["acme"] };
    expect(claimableLines(order(), PROTECTION, except).map((l) => l.title)).toEqual(["Vase"]);
  });
});

describe("orderEligibility", () => {
  const base = { settings, isProtected: true, prior: [], now };

  test("a shipped, protected order within the window is eligible", () => {
    expect(orderEligibility(order(), base)).toEqual({ ok: true });
  });

  test("refusals", () => {
    expect(orderEligibility(order({ cancelled: true }), base).ok).toBe(false);
    expect(orderEligibility(order(), { ...base, isProtected: false }).ok).toBe(false);
    expect(orderEligibility(order(), { ...base, isProtected: false, settings: { ...settings, requireProtection: false } }).ok).toBe(true);
    expect(orderEligibility(order({ shipments: [] }), base)).toMatchObject({ ok: false, reason: expect.stringMatching(/hasn't shipped/) });
    const old = order({ shipments: [{ ...order().shipments[0], shippedAt: daysAgo(31) }] });
    expect(orderEligibility(old, base)).toMatchObject({ ok: false, reason: expect.stringMatching(/30 days/) });
  });

  test("the window runs from the last shipment", () => {
    const split = order({
      shipments: [
        { ...order().shipments[0], shippedAt: daysAgo(40) },
        { ...order().shipments[0], shippedAt: daysAgo(5) },
      ],
    });
    expect(orderEligibility(split, base).ok).toBe(true);
  });

  test("an open claim blocks, and its id is returned so the customer can be sent to it", () => {
    expect(orderEligibility(order(), { ...base, prior: [{ id: "c1", status: "NEEDS_INFO" }] })).toMatchObject({
      ok: false,
      openClaimId: "c1",
    });
  });

  test("claims per order: rejected ones don't count", () => {
    expect(orderEligibility(order(), { ...base, prior: [{ id: "c1", status: "REJECTED" }] }).ok).toBe(true);
    expect(orderEligibility(order(), { ...base, prior: [{ id: "c1", status: "APPROVED" }] }).ok).toBe(false);
    expect(
      orderEligibility(order(), { ...base, settings: { ...settings, maxPerOrder: 2 }, prior: [{ id: "c1", status: "APPROVED" }] }).ok,
    ).toBe(true);
  });
});

describe("typeProblem", () => {
  const wait = { ...settings, lostAfterDays: 14 };
  test("lost needs the waiting period unless delivered", () => {
    expect(typeProblem(order(), "LOST", wait, now)).toMatch(/14 days after shipping/);
    expect(typeProblem(order(), "DAMAGED", wait, now)).toBeNull();
    expect(typeProblem(order(), "LOST", settings, now)).toBeNull();
    const delivered = order({ shipments: [{ ...order().shipments[0], deliveredAt: daysAgo(1) }] });
    expect(typeProblem(delivered, "LOST", wait, now)).toBeNull();
  });
});

describe("claimFlags", () => {
  test("hints only where the data disagrees with the story", () => {
    expect(claimFlags(order(), "LOST", true, 0)).toEqual([]);
    const delivered = order({ shipments: [{ ...order().shipments[0], status: "DELIVERED", deliveredAt: daysAgo(1) }] });
    expect(claimFlags(delivered, "LOST", true, 0)).toEqual(["MARKED_DELIVERED"]);
    expect(claimFlags(order(), "STOLEN", true, 0)).toEqual(["NOT_MARKED_DELIVERED"]);
    const untracked = order({ shipments: [{ ...order().shipments[0], tracking: [] }] });
    expect(claimFlags(untracked, "DAMAGED", false, 2)).toEqual(["NO_PROTECTION", "NO_TRACKING", "PRIOR_CLAIMS"]);
  });
});

describe("buildClaimItems", () => {
  test("priced from the order, quantities clamped, unknown lines ignored", () => {
    const lines = claimableLines(order(), PROTECTION);
    const r = buildClaimItems(lines, {
      "gid://shopify/LineItem/1": 5,
      "gid://shopify/LineItem/2": 1,
      "gid://shopify/LineItem/42": 3,
    });
    expect(r.items).toEqual([{ lineItemId: "gid://shopify/LineItem/1", title: "Vase — Blue", quantity: 2, amount: 49 }]);
    expect(r.amount).toBe(49);
    expect(buildClaimItems(lines, { "gid://shopify/LineItem/1": -1 }).items).toEqual([]);
  });
});

describe("evidence paths", () => {
  test("only under the order's own prefix", () => {
    expect(pathnameAllowed(`claims/${SHOP}/5001/photo-abc.jpg`, SHOP, "5001")).toBe(true);
    expect(pathnameAllowed(`claims/${SHOP}/5002/photo.jpg`, SHOP, "5001")).toBe(false);
    expect(pathnameAllowed(`claims/other.myshopify.com/5001/photo.jpg`, SHOP, "5001")).toBe(false);
    expect(pathnameAllowed(`claims/${SHOP}/5001/../5002/x.jpg`, SHOP, "5001")).toBe(false);
    expect(pathnameAllowed(`claims/${SHOP}/5001/a b.jpg`, SHOP, "5001")).toBe(false);
  });
});

describe("status transitions", () => {
  test("decided claims can only be reopened", () => {
    expect(canTransition("OPEN", "APPROVED")).toBe(true);
    expect(canTransition("NEEDS_INFO", "REJECTED")).toBe(true);
    expect(canTransition("APPROVED", "REJECTED")).toBe(false);
    expect(canTransition("REJECTED", "OPEN")).toBe(true);
    expect(canTransition("OPEN", "OPEN")).toBe(false);
  });
});

describe("tokens", () => {
  const opts = { secret: "test-secret", now: now.getTime() };

  test("round trip", () => {
    const t = signToken({ p: "order", shop: SHOP, id: "5001", email: "jane@example.com" }, opts);
    expect(verifyToken(t, "order", SHOP, opts)).toMatchObject({ id: "5001", email: "jane@example.com" });
    expect(tokenShop(t)).toBe(SHOP);
  });

  test("bound to purpose, shop, signature and time", () => {
    const t = signToken({ p: "order", shop: SHOP, id: "5001" }, opts);
    expect(verifyToken(t, "claim", SHOP, opts)).toBeNull();
    expect(verifyToken(t, "order", "other.myshopify.com", opts)).toBeNull();
    expect(verifyToken(t, "order", SHOP, { ...opts, secret: "other" })).toBeNull();
    expect(verifyToken(t, "order", SHOP, { ...opts, now: now.getTime() + 3 * 3600_000 })).toBeNull();
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), id: "5002" })).toString("base64url");
    expect(verifyToken(`${forged}.${sig}`, "order", SHOP, opts)).toBeNull();
    expect(verifyToken("garbage", "order", SHOP, opts)).toBeNull();
    expect(verifyToken(null, "order", SHOP, opts)).toBeNull();
  });
});

describe("toClaimOrder", () => {
  test("cancelled fulfillments aren't shipments; ids become numeric", () => {
    const o = toClaimOrder({
      id: "gid://shopify/Order/5001",
      name: "#1001",
      email: null,
      createdAt: daysAgo(3),
      cancelledAt: null,
      currencyCode: "EUR",
      customer: { id: "gid://shopify/Customer/77" },
      lineItems: {
        nodes: [
          {
            id: "gid://shopify/LineItem/1",
            title: "Vase",
            variantTitle: null,
            currentQuantity: 1,
            requiresShipping: true,
            isGiftCard: false,
            product: null,
            discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: "19.90" } },
            image: null,
          },
        ],
      },
      fulfillments: [
        { createdAt: daysAgo(2), displayStatus: "IN_TRANSIT", deliveredAt: null, status: "SUCCESS", trackingInfo: [] },
        { createdAt: daysAgo(2), displayStatus: null, deliveredAt: null, status: "CANCELLED", trackingInfo: [] },
      ],
    });
    expect(o).toMatchObject({ id: "5001", customerId: "77", cancelled: false });
    expect(o.lines[0].unitAmount).toBe(19.9);
    expect(o.shipments).toHaveLength(1);
  });
});

describe("portal pages", () => {
  const opts = { prefix: "/apps/safeship", appUrl: "https://app.example" };
  const liquid = /\{\{|\{%|\{|\}/;

  test("esc neutralises Liquid as well as HTML", () => {
    expect(esc("{{ shop.name }} {% if %} <b>")).toBe("&#123;&#123; shop.name &#125;&#125; &#123;% if %&#125; &lt;b&gt;");
  });

  test("customer text can't inject Liquid or HTML", () => {
    const evil = "{{ customer.email }}<script>alert(1)</script>{% render 'x' %}";
    const html = statusPage({
      ...opts,
      number: 1001,
      orderName: "#1001",
      type: "DAMAGED",
      status: "NEEDS_INFO",
      resolution: null,
      items: [{ lineItemId: "x", title: evil, quantity: 1, amount: 5 }],
      amount: 5,
      currency: "EUR",
      createdAt: now.toISOString(),
      events: [{ at: now.toISOString(), actor: "CUSTOMER", kind: "MESSAGE", status: null, message: evil }],
      token: "t.k",
      claimId: "c1",
      uploads: true,
      uploadPrefix: `claims/${SHOP}/5001/`,
    });
    expect(html).not.toContain("<script>alert");
    // Strip our own <style> and the CSS braces in it; the rest must have no braces at all.
    expect(html.replace(/<style>[\s\S]*?<\/style>/, "")).not.toMatch(liquid);
    expect(html).not.toContain("{{");
    expect(html).not.toContain("{%");
  });

  test("forms post through the proxy prefix", () => {
    const html = lookupPage({ ...opts, policy: "Covered: {{ everything }}", signedIn: false });
    expect(html).toContain('action="/apps/safeship/claims">');
    expect(html).not.toContain("{{");
    const form = claimFormPage({
      ...opts,
      orderName: "#1001",
      email: "jane@example.com",
      token: "tok",
      lines: claimableLines(order(), PROTECTION),
      currency: "EUR",
      uploads: false,
      photosForDamage: true,
      uploadPrefix: "",
    });
    expect(form).toContain('name="qty_1"');
    // liquid() only adds the proxy's trailing slash when action is the last attribute.
    for (const tag of [html, form].join("").match(/<form[^>]*>/g)!) expect(tag).toMatch(/action="[^"]+">$/);
    expect(form).not.toContain("data-sp-upload");
  });
});
