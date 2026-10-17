import { describe, expect, test } from "vitest";
import {
  DEFAULT_TRACKING_SETTINGS,
  normalizeTracking,
  parseTrackingSettings,
  shipmentFlags,
  stageOf,
  trackingNumbersOf,
  type PackageFacts,
} from "../app/lib/tracking";
import { orphanedBlobs } from "../app/lib/blob.server";
import { addressHash } from "../app/lib/claims.server";
import { claimLocale } from "../app/lib/i18n";

const now = new Date("2026-10-17T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const rules = DEFAULT_TRACKING_SETTINGS;
const pkg = (p: Partial<PackageFacts> = {}): PackageFacts => ({
  stage: "IN_TRANSIT",
  shippedAt: daysAgo(3),
  deliveredAt: null,
  estimatedDeliveryAt: null,
  lastEventAt: daysAgo(1),
  tracking: [{ number: "1Z999AA10123456784", company: "UPS", url: null }],
  ...p,
});

describe("stageOf", () => {
  test("maps Shopify statuses; delivery and cancellation win", () => {
    expect(stageOf("LABEL_PRINTED")).toBe("PENDING");
    expect(stageOf("CARRIER_PICKED_UP")).toBe("IN_TRANSIT");
    expect(stageOf("OUT_FOR_DELIVERY")).toBe("OUT_FOR_DELIVERY");
    expect(stageOf("ATTEMPTED_DELIVERY")).toBe("EXCEPTION");
    expect(stageOf("IN_TRANSIT", "SUCCESS", daysAgo(0))).toBe("DELIVERED");
    expect(stageOf("IN_TRANSIT", "CANCELLED")).toBe("CANCELLED");
    expect(stageOf(null)).toBe("PENDING");
    expect(stageOf("SOMETHING_NEW")).toBe("PENDING");
  });
});

describe("shipmentFlags", () => {
  test("a package moving normally has none", () => {
    expect(shipmentFlags(pkg(), rules, now)).toEqual([]);
  });
  test("not picked up, stalled, late, possibly lost", () => {
    expect(shipmentFlags(pkg({ stage: "PENDING", lastEventAt: null, shippedAt: daysAgo(4) }), rules, now)).toEqual(["NOT_SCANNED"]);
    expect(shipmentFlags(pkg({ lastEventAt: daysAgo(6) }), rules, now)).toEqual(["STALLED"]);
    expect(shipmentFlags(pkg({ estimatedDeliveryAt: daysAgo(3) }), rules, now)).toEqual(["LATE"]);
    expect(shipmentFlags(pkg({ shippedAt: daysAgo(22) }), rules, now)).toEqual(["POSSIBLY_LOST"]);
    expect(shipmentFlags(pkg({ stage: "EXCEPTION" }), rules, now)).toEqual(["CARRIER_EXCEPTION"]);
    expect(shipmentFlags(pkg({ tracking: [] }), rules, now)).toEqual(["NO_TRACKING"]);
  });
  test("0 turns a rule off; delivered and cancelled packages are never flagged", () => {
    const off = parseTrackingSettings({ staleDays: 0, lostDays: "0" });
    expect(shipmentFlags(pkg({ lastEventAt: daysAgo(30), shippedAt: daysAgo(30) }), off, now)).toEqual([]);
    expect(shipmentFlags(pkg({ stage: "DELIVERED", tracking: [], shippedAt: daysAgo(90) }), rules, now)).toEqual([]);
    expect(shipmentFlags(pkg({ stage: "CANCELLED", tracking: [] }), rules, now)).toEqual([]);
  });
  test("settings are clamped", () => {
    expect(parseTrackingSettings({ noScanDays: -1, lostDays: 9999, lateDays: "x" })).toEqual({
      ...DEFAULT_TRACKING_SETTINGS,
      noScanDays: 0,
      lostDays: 180,
    });
  });
});

describe("tracking numbers", () => {
  test("normalised and de-duplicated; junk ignored", () => {
    expect(normalizeTracking(" 1z 999-aa1 ")).toBe("1Z999AA1");
    expect(
      trackingNumbersOf([
        { number: "1Z 999 AA1", company: null, url: null },
        { number: "1z999aa1", company: null, url: null },
        { number: "12", company: null, url: null },
        { number: null, company: null, url: null },
      ]),
    ).toEqual(["1Z999AA1"]);
  });
});

describe("housekeeping helpers", () => {
  test("orphaned uploads: unattached and older than a day", () => {
    const t = now.getTime();
    const blobs = [
      { pathname: "claims/s/1/a.jpg", uploadedAt: new Date(t - 2 * 86_400_000) },
      { pathname: "claims/s/1/b.jpg", uploadedAt: new Date(t - 2 * 86_400_000) },
      { pathname: "claims/s/1/c.jpg", uploadedAt: new Date(t - 3600_000) },
    ];
    expect(orphanedBlobs(blobs, new Set(["claims/s/1/a.jpg"]), t)).toEqual(["claims/s/1/b.jpg"]);
  });

  test("address hash: same place however it's typed, never the address itself", () => {
    const a = addressHash({ address1: "12 Main St.", address2: null, zip: "10115", countryCodeV2: "DE" }, "secret");
    const b = addressHash({ address1: " 12 main st ", address2: "", zip: "10115", countryCodeV2: "de" }, "secret");
    const c = addressHash({ address1: "14 Main St", address2: null, zip: "10115", countryCodeV2: "DE" }, "secret");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("main");
    expect(addressHash(null, "secret")).toBeNull();
  });

  test("customer locale → a language we have", () => {
    expect(claimLocale("fr-CA")).toBe("fr");
    expect(claimLocale("pt-BR")).toBe("en");
    expect(claimLocale(null)).toBe("en");
    expect(claimLocale("NL")).toBe("nl");
  });
});

describe("translations", async () => {
  const { DICTS, LOCALES, fill, fromAcceptLanguage } = await import("../app/lib/i18n");
  const { lookupPage, statusPage, claimFormPage } = await import("../app/lib/portal-pages");
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  const flat = (o: unknown, prefix = ""): [string, string][] =>
    Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
      typeof v === "string" ? [[prefix + k, v] as [string, string]] : flat(v, `${prefix}${k}.`),
    );
  const en = new Map(flat(DICTS.en));

  test("every language has every string, with the same placeholders", () => {
    for (const l of LOCALES) {
      const strings = new Map(flat(DICTS[l]));
      expect([...strings.keys()].sort(), l).toEqual([...en.keys()].sort());
      for (const [k, v] of strings) {
        expect(v.trim(), `${l}.${k}`).not.toBe("");
        expect(placeholders(v), `${l}.${k}`).toBe(placeholders(en.get(k)!));
      }
    }
  });

  test("fill and Accept-Language", () => {
    expect(fill("Order {order} · {x}", { order: "#1" })).toBe("Order #1 · {x}");
    expect(fromAcceptLanguage("pt-BR,de;q=0.8,en;q=0.5")).toBe("de");
    expect(fromAcceptLanguage("en-GB,de")).toBe("en");
    expect(fromAcceptLanguage("pt-BR")).toBeNull();
    expect(fromAcceptLanguage(null)).toBeNull();
  });

  test("pages render in the chosen language and stay Liquid-safe", () => {
    const opts = { prefix: "/apps/safeship", appUrl: "https://app.example" };
    for (const lang of LOCALES) {
      const html =
        lookupPage({ ...opts, lang, policy: "{{ x }}", signedIn: false }) +
        claimFormPage({
          ...opts,
          lang,
          orderName: "#1",
          email: "a@b.c",
          token: "t",
          lines: [],
          currency: "EUR",
          uploads: true,
          photosForDamage: true,
          evidenceForAll: true,
          uploadPrefix: "claims/x/1/",
        }) +
        statusPage({
          ...opts,
          lang,
          number: 1001,
          orderName: "#1",
          type: "LOST",
          status: "APPROVED",
          resolution: "REFUND",
          items: [],
          amount: 5,
          currency: "EUR",
          createdAt: new Date().toISOString(),
          events: [{ at: new Date().toISOString(), actor: "MERCHANT", kind: "SUBMITTED", status: null, message: null }],
          token: "t",
          claimId: "c",
          uploads: false,
          uploadPrefix: "",
        });
      expect(html).toContain(DICTS[lang].lookupTitle.replace(/'/g, "&#39;"));
      expect(html).toContain(`name="lang" value="${lang}"`);
      expect(html, lang).not.toMatch(/\{\{|\{%/);
    }
  });

  test("only the detect script carries Liquid, and only when asked", () => {
    const opts = { prefix: "/apps/safeship", appUrl: "https://app.example", lang: "en" as const };
    expect(lookupPage({ ...opts, policy: "", signedIn: false })).not.toContain("request.locale");
    const html = lookupPage({ ...opts, detectLang: true, policy: "", signedIn: false });
    expect(html.match(/\{\{/g)).toHaveLength(1);
    expect(html).toContain("{{ request.locale.iso_code }}");
    expect(html).not.toContain("{%");
  });
});
