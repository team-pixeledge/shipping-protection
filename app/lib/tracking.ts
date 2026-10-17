// Shipment tracking: where each package is, and which ones look late or
// lost. Pure rules with no I/O, shared by the sync (tracking.server.ts), the
// admin pages and the claim risk flags, so nothing server-only goes here.
//
// Delivery scans alone can't prove a package was lost or stolen. Every flag
// here is a hint for the merchant's review. Nothing is approved, rejected
// or charged because of one.

/** Where a package is, simplified from Shopify's FulfillmentDisplayStatus. */
export type Stage = "PENDING" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED" | "EXCEPTION" | "CANCELLED";

export const STAGE_LABELS: Record<Stage, string> = {
  PENDING: "Waiting for the carrier",
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  EXCEPTION: "Carrier problem",
  CANCELLED: "Cancelled",
};

export const STAGE_TONE: Record<Stage, "neutral" | "info" | "success" | "critical" | "warning"> = {
  PENDING: "neutral",
  IN_TRANSIT: "info",
  OUT_FOR_DELIVERY: "info",
  DELIVERED: "success",
  EXCEPTION: "critical",
  CANCELLED: "neutral",
};

const STAGE_OF: Record<string, Stage> = {
  // Fulfilled, but no carrier scan yet.
  SUBMITTED: "PENDING",
  CONFIRMED: "PENDING",
  LABEL_PRINTED: "PENDING",
  LABEL_PURCHASED: "PENDING",
  FULFILLED: "PENDING",
  MARKED_AS_FULFILLED: "PENDING",
  // Moving.
  PICKED_UP: "IN_TRANSIT",
  IN_TRANSIT: "IN_TRANSIT",
  CARRIER_PICKED_UP: "IN_TRANSIT",
  READY_FOR_PICKUP: "OUT_FOR_DELIVERY",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
  PICKED_UP_BY_CUSTOMER: "DELIVERED",
  // The carrier reports a problem.
  ATTEMPTED_DELIVERY: "EXCEPTION",
  DELAYED: "EXCEPTION",
  FAILURE: "EXCEPTION",
  NOT_DELIVERED: "EXCEPTION",
  // Gone.
  CANCELED: "CANCELLED",
  CANCELLED: "CANCELLED",
  LABEL_VOIDED: "CANCELLED",
  ERROR: "CANCELLED",
};

/** Stage from Shopify's statuses. deliveredAt wins: some carriers set it without a final display status. */
export function stageOf(displayStatus: string | null | undefined, status?: string | null, deliveredAt?: string | null): Stage {
  if (status && ["CANCELLED", "ERROR", "FAILURE"].includes(status)) return "CANCELLED";
  if (deliveredAt) return "DELIVERED";
  return STAGE_OF[(displayStatus ?? "").toUpperCase()] ?? "PENDING";
}

export const isOpenStage = (s: Stage) => s !== "DELIVERED" && s !== "CANCELLED";

// ---- Rules (Settings → Tracking) ----

export interface TrackingSettings {
  /** Days after fulfilment with no carrier scan before "not picked up" (0 = off). */
  noScanDays: number;
  /** Days without a carrier update while in transit before "stalled" (0 = off). */
  staleDays: number;
  /** Days past the carrier's estimated delivery before "late" (0 = off). */
  lateDays: number;
  /** Days after shipping without delivery before "possibly lost" (0 = off). */
  lostDays: number;
}

export const DEFAULT_TRACKING_SETTINGS: TrackingSettings = {
  noScanDays: 3,
  staleDays: 5,
  lateDays: 2,
  lostDays: 21,
};

const int = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

export function parseTrackingSettings(raw: unknown): TrackingSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_TRACKING_SETTINGS;
  return {
    noScanDays: int(o.noScanDays, d.noScanDays, 0, 60),
    staleDays: int(o.staleDays, d.staleDays, 0, 60),
    lateDays: int(o.lateDays, d.lateDays, 0, 60),
    lostDays: int(o.lostDays, d.lostDays, 0, 180),
  };
}

/** Stop checking a package this long after it shipped, delivered or not. */
export const FOLLOW_DAYS = 120;

// ---- One package ----

export interface TrackingNumber {
  number: string | null;
  company: string | null;
  url: string | null;
}

/** A package as the rules see it (a Shopify fulfillment). */
export interface PackageFacts {
  stage: Stage;
  shippedAt: string;
  deliveredAt: string | null;
  estimatedDeliveryAt: string | null;
  /** The carrier's latest event, if the carrier reports events at all. */
  lastEventAt: string | null;
  tracking: TrackingNumber[];
}

export const SHIPMENT_FLAGS = ["NO_TRACKING", "NOT_SCANNED", "STALLED", "LATE", "POSSIBLY_LOST", "CARRIER_EXCEPTION"] as const;
export type ShipmentFlag = (typeof SHIPMENT_FLAGS)[number];

export const SHIPMENT_FLAG_LABELS: Record<ShipmentFlag, string> = {
  NO_TRACKING: "No tracking number",
  NOT_SCANNED: "No carrier scan since it was fulfilled",
  STALLED: "No tracking update for a while",
  LATE: "Past the carrier's estimated delivery",
  POSSIBLY_LOST: "Not delivered long after shipping — possibly lost",
  CARRIER_EXCEPTION: "The carrier reports a problem",
};

const DAY = 86_400_000;
const ageDays = (iso: string, now: Date) => (now.getTime() - new Date(iso).getTime()) / DAY;

/** Hints about one package. Delivered or cancelled packages never get any. */
export function shipmentFlags(p: PackageFacts, rules: TrackingSettings, now: Date): ShipmentFlag[] {
  if (!isOpenStage(p.stage)) return [];
  const flags: ShipmentFlag[] = [];
  const hasTracking = p.tracking.some((t) => t.number);
  if (!hasTracking) flags.push("NO_TRACKING");
  if (p.stage === "EXCEPTION") flags.push("CARRIER_EXCEPTION");
  if (hasTracking && p.stage === "PENDING" && rules.noScanDays > 0 && ageDays(p.shippedAt, now) > rules.noScanDays) {
    flags.push("NOT_SCANNED");
  }
  // Stalled needs carrier events to measure from; without any, NOT_SCANNED
  // (or POSSIBLY_LOST) already says it.
  if (
    rules.staleDays > 0 &&
    p.lastEventAt &&
    (p.stage === "IN_TRANSIT" || p.stage === "OUT_FOR_DELIVERY" || p.stage === "EXCEPTION") &&
    ageDays(p.lastEventAt, now) > rules.staleDays
  ) {
    flags.push("STALLED");
  }
  if (rules.lateDays > 0 && p.estimatedDeliveryAt && ageDays(p.estimatedDeliveryAt, now) > rules.lateDays) {
    flags.push("LATE");
  }
  if (rules.lostDays > 0 && ageDays(p.shippedAt, now) > rules.lostDays) flags.push("POSSIBLY_LOST");
  return flags;
}

/** Tracking numbers compared across orders: no spaces, upper case. */
export const normalizeTracking = (n: string | null | undefined) => (n ?? "").replace(/[\s-]+/g, "").toUpperCase();

export const trackingNumbersOf = (tracking: TrackingNumber[]) =>
  [...new Set(tracking.map((t) => normalizeTracking(t.number)).filter((n) => n.length >= 5))];
