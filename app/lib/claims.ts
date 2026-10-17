import { lineCovered, matchesTags, type Coverage } from "../../shared/pricing";
import {
  FOLLOW_DAYS,
  isOpenStage,
  shipmentFlags,
  stageOf,
  trackingNumbersOf,
  type TrackingNumber,
  type TrackingSettings,
} from "./tracking";
import { refusalText, type Refusal } from "./i18n";

// Claims: the rules, with no I/O. Shared by the storefront claims page
// (app/routes/proxy.*), the admin (app/routes/app.claims*) and the settings
// page, so nothing server-only may be imported here.

export const CLAIM_TYPES = ["LOST", "STOLEN", "DAMAGED"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const CLAIM_STATUSES = ["OPEN", "NEEDS_INFO", "APPROVED", "REJECTED"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
/** Statuses that block a second claim on the same order. */
export const OPEN_STATUSES: ClaimStatus[] = ["OPEN", "NEEDS_INFO"];

export const RESOLUTIONS = ["REFUND", "REPLACEMENT", "STORE_CREDIT", "OTHER"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const TYPE_LABELS: Record<ClaimType, string> = {
  LOST: "Lost in transit",
  STOLEN: "Stolen after delivery",
  DAMAGED: "Arrived damaged",
};
export const STATUS_LABELS: Record<ClaimStatus, string> = {
  OPEN: "In review",
  NEEDS_INFO: "Needs more information",
  APPROVED: "Approved",
  REJECTED: "Not approved",
};
/** Admin badge tones. */
export const STATUS_TONE: Record<ClaimStatus, "info" | "warning" | "success" | "critical"> = {
  OPEN: "info",
  NEEDS_INFO: "warning",
  APPROVED: "success",
  REJECTED: "critical",
};
export const RESOLUTION_LABELS: Record<Resolution, string> = {
  REFUND: "Refund",
  REPLACEMENT: "Replacement",
  STORE_CREDIT: "Store credit",
  OTHER: "Other",
};
/**
 * Review hints on a claim. WARNING flags are reasons to look closer;
 * SUPPORT flags are carrier data that backs the customer's story. Neither
 * is a verdict, and a customer is never labelled fraudulent by them.
 */
export const FLAG_LABELS: Record<string, string> = {
  NO_PROTECTION: "No protection on this order",
  MARKED_DELIVERED: "Reported lost, but the carrier marked it delivered",
  NOT_MARKED_DELIVERED: "Reported stolen, but the carrier hasn't marked it delivered",
  NO_TRACKING: "No tracking number",
  PRIOR_CLAIMS: "This customer has filed other claims in the last 12 months",
  REPEAT_ADDRESS: "Other claims were filed for the same shipping address in the last 12 months",
  DUPLICATE_TRACKING: "The same tracking number is on a claim for another order",
  HIGH_VALUE: "High claim value",
  EARLY_LOST: "Reported lost while the carrier still shows it moving",
  CARRIER_EXCEPTION: "Carrier reports a delivery problem",
  CARRIER_LATE: "Carrier is past its estimated delivery date",
  CARRIER_STALLED: "No carrier update for a while",
  CARRIER_POSSIBLY_LOST: "Not delivered long after shipping",
  OUTSIDE_POLICY: "Created by staff outside the online claim rules",
};
export const SUPPORT_FLAGS = ["CARRIER_EXCEPTION", "CARRIER_LATE", "CARRIER_STALLED", "CARRIER_POSSIBLY_LOST"];
export const isSupportFlag = (f: string) => SUPPORT_FLAGS.includes(f);

export type ReviewPriority = "LOW" | "MEDIUM" | "HIGH";
export const PRIORITY_LABELS: Record<ReviewPriority, string> = {
  LOW: "Routine",
  MEDIUM: "Check details",
  HIGH: "Review carefully",
};
const STRONG_FLAGS = ["DUPLICATE_TRACKING", "MARKED_DELIVERED"];
/** How closely to look, from the warning flags the merchant hasn't dismissed. */
export function reviewPriority(flags: string[], dismissed: string[] = []): ReviewPriority {
  const active = flags.filter((f) => !isSupportFlag(f) && !dismissed.includes(f));
  if (active.some((f) => STRONG_FLAGS.includes(f)) || active.length >= 2) return "HIGH";
  return active.length ? "MEDIUM" : "LOW";
}

/** Which status changes the merchant may make. Reopening needs a reason. */
const TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  OPEN: ["NEEDS_INFO", "APPROVED", "REJECTED"],
  NEEDS_INFO: ["OPEN", "APPROVED", "REJECTED"],
  APPROVED: ["OPEN"],
  REJECTED: ["OPEN"],
};
export const canTransition = (from: ClaimStatus, to: ClaimStatus) => TRANSITIONS[from]?.includes(to) ?? false;

export const isClaimStatus = (s: unknown): s is ClaimStatus => CLAIM_STATUSES.includes(s as ClaimStatus);
export const isClaimType = (s: unknown): s is ClaimType => CLAIM_TYPES.includes(s as ClaimType);
export const isResolution = (s: unknown): s is Resolution => RESOLUTIONS.includes(s as Resolution);

export const formatClaimNumber = (n: number) => `C-${n}`;

// ---- Settings ----

export interface ClaimSettings {
  /** Off: the claims page says claims aren't available. */
  enabled: boolean;
  /** Days after the (last) shipment that a claim may be filed. */
  windowDays: number;
  /** A package can be reported lost only this many days after shipping (0 = any time). */
  lostAfterDays: number;
  /** Only orders that bought protection can be claimed. */
  requireProtection: boolean;
  /** Damage claims need at least one photo (when uploads are set up). */
  photosForDamage: boolean;
  /** Claims per order, not counting rejected ones. */
  maxPerOrder: number;
  /** Where new-claim emails go. Empty = the store's email. */
  notifyEmail: string;
  /** Shown on the claims page above the form. Plain text. */
  policy: string;
  /** The claim window counts from shipping, or from delivery once delivered. */
  windowFrom: "SHIPPED" | "DELIVERED";
  /** Lost and stolen claims need at least one file (e.g. a police report). */
  evidenceForLostStolen: boolean;
  /** Most that can be claimed online per order, all claims together (0 = no limit). */
  maxValuePerOrder: number;
  /** Most one customer (email) can claim online in 12 months (0 = no limit). */
  maxValuePerCustomer: number;
  /** Flag a customer or address with this many claims in 12 months, this one included. */
  repeatThreshold: number;
  /** Flag claims worth at least this much (0 = off). */
  highValue: number;
}

export const DEFAULT_CLAIM_SETTINGS: ClaimSettings = {
  // Off until the merchant turns it on — installing changes nothing.
  enabled: false,
  windowDays: 30,
  lostAfterDays: 0,
  requireProtection: true,
  photosForDamage: true,
  maxPerOrder: 1,
  notifyEmail: "",
  policy: "",
  windowFrom: "SHIPPED",
  evidenceForLostStolen: false,
  maxValuePerOrder: 0,
  maxValuePerCustomer: 0,
  repeatThreshold: 2,
  highValue: 0,
};

const int = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const money = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(1e9, Math.round(n * 100) / 100) : 0;
};
const EMAIL_RE = /^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/;
export const isEmail = (s: string) => s.length <= 254 && EMAIL_RE.test(s);

/** Whitelists and coerces untrusted input. */
export function parseClaimSettings(raw: unknown): ClaimSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_CLAIM_SETTINGS;
  const email = typeof o.notifyEmail === "string" ? o.notifyEmail.trim().slice(0, 254) : "";
  return {
    enabled: o.enabled === true,
    windowDays: int(o.windowDays, d.windowDays, 1, 365),
    lostAfterDays: int(o.lostAfterDays, d.lostAfterDays, 0, 90),
    requireProtection: o.requireProtection === undefined ? d.requireProtection : o.requireProtection === true,
    photosForDamage: o.photosForDamage === undefined ? d.photosForDamage : o.photosForDamage === true,
    maxPerOrder: int(o.maxPerOrder, d.maxPerOrder, 1, 10),
    notifyEmail: isEmail(email) ? email : "",
    policy: typeof o.policy === "string" ? o.policy.trim().slice(0, 2000) : "",
    windowFrom: o.windowFrom === "DELIVERED" ? "DELIVERED" : "SHIPPED",
    evidenceForLostStolen: o.evidenceForLostStolen === true,
    maxValuePerOrder: money(o.maxValuePerOrder),
    maxValuePerCustomer: money(o.maxValuePerCustomer),
    repeatThreshold: int(o.repeatThreshold, d.repeatThreshold, 2, 20),
    highValue: money(o.highValue),
  };
}

// ---- The order, as the claims flow sees it ----

export interface OrderLine {
  id: string; // gid://shopify/LineItem/…
  title: string;
  variantTitle: string | null;
  /** Current quantity (after removals and refunds). */
  quantity: number;
  /** Per unit after all discounts, shop currency. */
  unitAmount: number;
  image: string | null;
  productId: string | null; // gid://shopify/Product/…
  variantId: string | null; // gid://shopify/ProductVariant/… (null if deleted)
  requiresShipping: boolean;
  giftCard: boolean;
  productType: string | null;
  vendor: string | null;
  tags: string[];
}

export interface Shipment {
  status: string; // displayStatus: IN_TRANSIT, DELIVERED, …
  shippedAt: string;
  deliveredAt: string | null;
  tracking: TrackingNumber[];
  // Added with tracking (phase 3); missing on claims filed before it.
  /** Numeric fulfillment ID. */
  id?: string;
  estimatedDeliveryAt?: string | null;
  /** The carrier's latest event (null when the carrier reports none). */
  lastEventAt?: string | null;
  /** The order lines in this package (gid://shopify/LineItem/…). */
  lineItemIds?: string[];
}

export interface ClaimOrder {
  id: string; // numeric
  name: string;
  email: string | null;
  customerId: string | null; // numeric
  createdAt: string;
  cancelled: boolean;
  currency: string; // shop currency
  /** The language the customer shopped in (e.g. "fr", "pt-BR"), if known. */
  locale?: string | null;
  lines: OrderLine[];
  shipments: Shipment[];
  /** Raw fulfillments, to store as tracked packages (claims.server.ts). */
  fulfillments?: unknown[];
}

/** "#1001", " 1001", "#SL-1001" → comparable form. */
export const normalizeOrderName = (s: string) => s.trim().replace(/^#/, "").replace(/\s+/g, "").toLowerCase();

export const sameEmail = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Lines a customer may claim: goods the protection covers (the store's
 * current coverage rules — no digital items, gift cards or excluded
 * products), never the protection line itself.
 */
export const claimableLines = (order: ClaimOrder, protectionProductId: string | null, coverage?: Coverage) =>
  order.lines.filter(
    (l) =>
      l.quantity > 0 &&
      (!protectionProductId || l.productId !== protectionProductId) &&
      lineCovered(coverage, {
        variantId: null,
        productId: l.productId ? Number(l.productId.split("/").pop()) : null,
        quantity: l.quantity,
        subtotal: 0,
        requiresShipping: l.requiresShipping,
        giftCard: l.giftCard,
        productType: l.productType,
        vendor: l.vendor,
        tagMatch: coverage ? matchesTags(coverage, l.tags) : false,
      }),
  );

const DAY = 86_400_000;
const daysBetween = (from: string, to: Date) => (to.getTime() - new Date(from).getTime()) / DAY;

export type Eligibility =
  | { ok: true }
  | { ok: false; refusal: Refusal; /** English, for the admin. */ reason: string; openClaimId?: string };

const refuse = (code: Refusal["code"], vars?: Refusal["vars"], openClaimId?: string): Eligibility => {
  const refusal: Refusal = { code, ...(vars ? { vars } : {}) };
  return { ok: false, refusal, reason: refusalText(refusal), ...(openClaimId ? { openClaimId } : {}) };
};

export interface PriorClaim {
  id: string;
  status: string;
}

/** Can this order be claimed at all? (The claim type is checked separately.) */
export function orderEligibility(
  order: ClaimOrder,
  opts: { settings: ClaimSettings; isProtected: boolean; prior: PriorClaim[]; now: Date },
): Eligibility {
  const { settings, isProtected, prior, now } = opts;
  if (order.cancelled) return refuse("CANCELLED");
  if (settings.requireProtection && !isProtected) return refuse("NO_PROTECTION");
  const open = prior.find((c) => OPEN_STATUSES.includes(c.status as ClaimStatus));
  if (open) return refuse("OPEN_CLAIM", undefined, open.id);
  const counted = prior.filter((c) => c.status !== "REJECTED").length;
  if (counted >= settings.maxPerOrder) return refuse("ALREADY_CLAIMED");
  if (!order.shipments.length) return refuse("NOT_SHIPPED");
  const start = windowStart(order, settings, now);
  if (daysBetween(start, now) > settings.windowDays) {
    return refuse(settings.windowFrom === "DELIVERED" ? "WINDOW_DELIVERED" : "WINDOW_SHIPPED", { days: settings.windowDays });
  }
  return { ok: true };
}

/**
 * Where the claim window starts: the last shipment's date, or with
 * windowFrom DELIVERED the last delivery once every package has arrived.
 */
export function windowStart(order: ClaimOrder, settings: ClaimSettings, now: Date): string {
  const lastShipped = order.shipments.map((s) => s.shippedAt).sort().at(-1)!;
  if (settings.windowFrom !== "DELIVERED") return lastShipped;
  // Not everything arrived: open while a package could still be lost, up to
  // FOLLOW_DAYS after shipping.
  if (order.shipments.some((s) => !s.deliveredAt)) {
    return daysBetween(lastShipped, now) <= FOLLOW_DAYS ? now.toISOString() : lastShipped;
  }
  return order.shipments.map((s) => s.deliveredAt!).sort().at(-1)!;
}

/** Type-specific check: lost packages may need some days in transit first. */
export function typeProblem(order: ClaimOrder, type: ClaimType, settings: ClaimSettings, now: Date): Refusal | null {
  if (type !== "LOST" || settings.lostAfterDays <= 0) return null;
  if (order.shipments.some((s) => s.deliveredAt)) return null;
  const firstShipped = order.shipments.map((s) => s.shippedAt).sort()[0];
  if (!firstShipped) return null;
  const from = new Date(new Date(firstShipped).getTime() + settings.lostAfterDays * DAY);
  if (from > now) {
    return { code: "LOST_TOO_EARLY", vars: { days: settings.lostAfterDays, date: from.toISOString().slice(0, 10) } };
  }
  return null;
}

/** The packages a claim is about: those holding a claimed line, else all of them. */
export function claimedShipments(order: ClaimOrder, lineItemIds: string[]): Shipment[] {
  const known = order.shipments.filter((s) => s.lineItemIds?.length);
  if (!known.length || !lineItemIds.length) return order.shipments;
  const hit = known.filter((s) => s.lineItemIds!.some((id) => lineItemIds.includes(id)));
  return hit.length ? hit : order.shipments;
}

export interface RiskInput {
  order: ClaimOrder;
  type: ClaimType;
  isProtected: boolean;
  /** The claimed lines, to pick the packages that matter. */
  lineItemIds: string[];
  amount: number;
  settings: ClaimSettings;
  tracking: TrackingSettings;
  /** This customer's other claims (by email) in the last 12 months. */
  otherClaimsByEmail: number;
  /** Other claims for the same shipping address in the last 12 months. */
  otherClaimsByAddress: number;
  /** Another order's claim has one of these tracking numbers. */
  duplicateTracking: boolean;
  now: Date;
}

/** Hints for the merchant's review. Never a verdict. */
export function claimFlags(r: RiskInput): string[] {
  const flags: string[] = [];
  const pkgs = claimedShipments(r.order, r.lineItemIds);
  const delivered = pkgs.filter((s) => s.deliveredAt || stageOf(s.status) === "DELIVERED").length;
  if (!r.isProtected) flags.push("NO_PROTECTION");
  if (r.type === "LOST" && pkgs.length > 0 && delivered === pkgs.length) flags.push("MARKED_DELIVERED");
  if (r.type === "STOLEN" && delivered === 0) flags.push("NOT_MARKED_DELIVERED");
  if (!pkgs.some((s) => s.tracking.some((t) => t.number))) flags.push("NO_TRACKING");
  if (r.otherClaimsByEmail + 1 >= r.settings.repeatThreshold && r.otherClaimsByEmail > 0) flags.push("PRIOR_CLAIMS");
  if (r.otherClaimsByAddress + 1 >= r.settings.repeatThreshold && r.otherClaimsByAddress > 0) flags.push("REPEAT_ADDRESS");
  if (r.duplicateTracking) flags.push("DUPLICATE_TRACKING");
  if (r.settings.highValue > 0 && r.amount >= r.settings.highValue) flags.push("HIGH_VALUE");

  // What the carrier says about the packages still on their way.
  const carrier = new Set<string>();
  for (const s of pkgs) {
    const stage = stageOf(s.status, null, s.deliveredAt);
    if (!isOpenStage(stage)) continue;
    const f = shipmentFlags(
      {
        stage,
        shippedAt: s.shippedAt,
        deliveredAt: s.deliveredAt,
        estimatedDeliveryAt: s.estimatedDeliveryAt ?? null,
        lastEventAt: s.lastEventAt ?? null,
        tracking: s.tracking,
      },
      r.tracking,
      r.now,
    );
    if (f.includes("CARRIER_EXCEPTION")) carrier.add("CARRIER_EXCEPTION");
    if (f.includes("LATE")) carrier.add("CARRIER_LATE");
    if (f.includes("STALLED") || f.includes("NOT_SCANNED")) carrier.add("CARRIER_STALLED");
    if (f.includes("POSSIBLY_LOST")) carrier.add("CARRIER_POSSIBLY_LOST");
  }
  // Lost, but the carrier still shows normal movement: maybe just slow.
  const moving = pkgs.some((s) => {
    const stage = stageOf(s.status, null, s.deliveredAt);
    return stage === "IN_TRANSIT" || stage === "OUT_FOR_DELIVERY";
  });
  if (r.type === "LOST" && moving && carrier.size === 0) flags.push("EARLY_LOST");
  flags.push(...carrier);
  return flags;
}

/** Tracking numbers on the claimed packages, normalised for matching across orders. */
export const claimTrackingNumbers = (order: ClaimOrder, lineItemIds: string[]) =>
  trackingNumbersOf(claimedShipments(order, lineItemIds).flatMap((s) => s.tracking));

/**
 * The merchant's value limits. Claimed amounts are what customers asked
 * for in claims that weren't rejected. null = within the limits.
 */
export function limitProblem(
  amount: number,
  claimedOnOrder: number,
  claimedByCustomer: number,
  settings: ClaimSettings,
): Refusal | null {
  if (settings.maxValuePerOrder > 0 && claimedOnOrder + amount > settings.maxValuePerOrder + 0.005) {
    return { code: "OVER_ORDER_LIMIT" };
  }
  if (settings.maxValuePerCustomer > 0 && claimedByCustomer + amount > settings.maxValuePerCustomer + 0.005) {
    return { code: "OVER_CUSTOMER_LIMIT" };
  }
  return null;
}

export interface ClaimItem {
  lineItemId: string;
  title: string;
  quantity: number;
  amount: number;
}

/**
 * The lines the customer picked, priced from the order — never from the
 * request. Quantities are clamped to what was ordered.
 */
export function buildClaimItems(
  lines: OrderLine[],
  picked: Record<string, number>,
): { items: ClaimItem[]; amount: number } {
  const items: ClaimItem[] = [];
  for (const l of lines) {
    const q = Math.min(l.quantity, Math.max(0, Math.floor(picked[l.id] ?? 0)));
    if (q <= 0) continue;
    items.push({
      lineItemId: l.id,
      title: l.variantTitle ? `${l.title} — ${l.variantTitle}` : l.title,
      quantity: q,
      amount: Math.round(l.unitAmount * q * 100) / 100,
    });
  }
  const amount = Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
  return { items, amount };
}

// ---- Evidence uploads ----

export const UPLOAD_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"];
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 8;

/** Blob path prefix for one order's evidence. */
export const evidencePrefix = (shop: string, orderId: string) => `claims/${shop}/${orderId}/`;

/** A client-supplied pathname is ours to attach only if it sits under the order's prefix. */
export const pathnameAllowed = (pathname: string, shop: string, orderId: string) =>
  pathname.startsWith(evidencePrefix(shop, orderId)) &&
  !pathname.includes("..") &&
  /^[\w./@-]+$/.test(pathname) &&
  pathname.length < 300;

// ---- Carrying out a resolution (phase 2) ----

export const RESOLUTION_KINDS = ["REFUND", "REPLACEMENT", "STORE_CREDIT", "MANUAL"] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];
export const isResolutionKind = (s: unknown): s is ResolutionKind => RESOLUTION_KINDS.includes(s as ResolutionKind);

export const RESOLUTION_KIND_LABELS: Record<ResolutionKind, string> = {
  REFUND: "Refund to the original payment",
  REPLACEMENT: "Replacement order (free)",
  STORE_CREDIT: "Store credit",
  MANUAL: "Handled outside the app (record the cost)",
};

/** The approval's resolution → the action offered first. */
export const defaultKind = (r: Resolution | null): ResolutionKind =>
  r === "REFUND" ? "REFUND" : r === "REPLACEMENT" ? "REPLACEMENT" : r === "STORE_CREDIT" ? "STORE_CREDIT" : "MANUAL";

/** Optional scopes each action needs (granted on first use). */
export const KIND_SCOPES: Record<ResolutionKind, string[]> = {
  REFUND: [],
  REPLACEMENT: ["write_draft_orders"],
  STORE_CREDIT: ["write_store_credit_account_transactions"],
  MANUAL: [],
};

export interface RefundSource {
  parentId: string;
  gateway: string;
  /** Presentment currency, major units. */
  max: number;
}

/**
 * Split a refund over the order's payments, in the order Shopify suggests,
 * never more than each can take. null if the amount is more than they hold.
 * Amounts are rounded to cents per transaction; the last one takes the rest.
 */
export function allocateRefund(sources: RefundSource[], amount: number): { parentId: string; gateway: string; amount: number }[] | null {
  const cents = Math.round(amount * 100);
  if (!(cents > 0)) return null;
  const total = sources.reduce((s, t) => s + Math.round(t.max * 100), 0);
  if (cents > total) return null;
  const out: { parentId: string; gateway: string; amount: number }[] = [];
  let left = cents;
  for (const t of sources) {
    if (left <= 0) break;
    const take = Math.min(left, Math.round(t.max * 100));
    if (take <= 0) continue;
    out.push({ parentId: t.parentId, gateway: t.gateway, amount: take / 100 });
    left -= take;
  }
  return out;
}
