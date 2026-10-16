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
export const FLAG_LABELS: Record<string, string> = {
  NO_PROTECTION: "No protection on this order",
  MARKED_DELIVERED: "Reported lost, but the carrier marked it delivered",
  NOT_MARKED_DELIVERED: "Reported stolen, but the carrier hasn't marked it delivered",
  NO_TRACKING: "No tracking number",
  PRIOR_CLAIMS: "This customer has other claims",
};

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
};

const int = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
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
}

export interface Shipment {
  status: string; // displayStatus: IN_TRANSIT, DELIVERED, …
  shippedAt: string;
  deliveredAt: string | null;
  tracking: { number: string | null; company: string | null; url: string | null }[];
}

export interface ClaimOrder {
  id: string; // numeric
  name: string;
  email: string | null;
  customerId: string | null; // numeric
  createdAt: string;
  cancelled: boolean;
  currency: string; // shop currency
  lines: OrderLine[];
  shipments: Shipment[];
}

/** "#1001", " 1001", "#SL-1001" → comparable form. */
export const normalizeOrderName = (s: string) => s.trim().replace(/^#/, "").replace(/\s+/g, "").toLowerCase();

export const sameEmail = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Lines a customer may claim: real goods, not the protection line itself. */
export const claimableLines = (order: ClaimOrder, protectionProductId: string | null) =>
  order.lines.filter((l) => l.quantity > 0 && (!protectionProductId || l.productId !== protectionProductId));

const DAY = 86_400_000;
const daysBetween = (from: string, to: Date) => (to.getTime() - new Date(from).getTime()) / DAY;

export type Eligibility =
  | { ok: true }
  | { ok: false; reason: string; openClaimId?: string };

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
  if (order.cancelled) return { ok: false, reason: "This order was cancelled, so it can't be claimed." };
  if (settings.requireProtection && !isProtected) {
    return { ok: false, reason: "This order didn't include shipping protection, so it can't be claimed here." };
  }
  const open = prior.find((c) => OPEN_STATUSES.includes(c.status as ClaimStatus));
  if (open) return { ok: false, reason: "There's already an open claim for this order.", openClaimId: open.id };
  const counted = prior.filter((c) => c.status !== "REJECTED").length;
  if (counted >= settings.maxPerOrder) {
    return { ok: false, reason: "This order has already been claimed. Please contact the store." };
  }
  if (!order.shipments.length) {
    return { ok: false, reason: "This order hasn't shipped yet. You can file a claim once it's on its way." };
  }
  const lastShipped = order.shipments.map((s) => s.shippedAt).sort().at(-1)!;
  if (daysBetween(lastShipped, now) > settings.windowDays) {
    return {
      ok: false,
      reason: `Claims must be filed within ${settings.windowDays} days of shipping. Please contact the store.`,
    };
  }
  return { ok: true };
}

/** Type-specific check: lost packages may need some days in transit first. */
export function typeProblem(order: ClaimOrder, type: ClaimType, settings: ClaimSettings, now: Date): string | null {
  if (type !== "LOST" || settings.lostAfterDays <= 0) return null;
  if (order.shipments.some((s) => s.deliveredAt)) return null;
  const firstShipped = order.shipments.map((s) => s.shippedAt).sort()[0];
  if (!firstShipped) return null;
  const from = new Date(new Date(firstShipped).getTime() + settings.lostAfterDays * DAY);
  if (from > now) {
    return `Packages can be reported lost ${settings.lostAfterDays} days after shipping — from ${from
      .toISOString()
      .slice(0, 10)}. It may still be on its way.`;
  }
  return null;
}

/** Hints for the merchant's review. Never a verdict. */
export function claimFlags(order: ClaimOrder, type: ClaimType, isProtected: boolean, otherClaimsByEmail: number) {
  const flags: string[] = [];
  if (!isProtected) flags.push("NO_PROTECTION");
  const delivered = order.shipments.filter((s) => s.deliveredAt || s.status === "DELIVERED").length;
  if (type === "LOST" && order.shipments.length > 0 && delivered === order.shipments.length) flags.push("MARKED_DELIVERED");
  if (type === "STOLEN" && delivered === 0) flags.push("NOT_MARKED_DELIVERED");
  if (!order.shipments.some((s) => s.tracking.some((t) => t.number))) flags.push("NO_TRACKING");
  if (otherClaimsByEmail > 0) flags.push("PRIOR_CLAIMS");
  return flags;
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
