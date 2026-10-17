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
