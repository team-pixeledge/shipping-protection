// SafeShip's plans — prices, limits and features — live here and only here:
// the billing config (shopify.server.ts), the usage charges
// (billing.server.ts), every feature gate and the Plan & pricing page all
// read PLANS. All plans are usage-based (no monthly fee): each cycle's first
// protected orders are free, then a price per protected order, up to a cap.
// Higher plans cost more per order and add features.
//
// Proposed 2026-10-17, for the user to review before launch. Changing a
// price changes it for NEW approvals only: merchants keep the terms they
// approved until they switch plans.

export type PlanId = "STARTER" | "GROWTH" | "PRO";

/** Features that some plans don't have. Everything else is on every plan. */
export type FeatureKey =
  | "tracking" // Shipments page, late/stalled/lost flags, carrier data on claims
  | "risk" // claim risk signals, review priority, dismissing flags
  | "claimRules" // value limits, evidence for lost/stolen, window from delivery
  | "staffClaims" // creating claims in the admin
  | "languages" // claims page + customer emails in 7 languages (else English)
  | "marketPrices" // fixed fees per Shopify market
  | "exactPricing" // exact % fee via cart transform (Shopify Plus stores)
  | "checkoutToggle"; // protection toggle inside checkout (Shopify Plus stores)

export interface Plan {
  id: PlanId;
  name: string;
  /** Billing API subscription name — how a subscription maps back to a plan. Don't rename. */
  billingName: string;
  currency: "USD";
  /** Protected orders per 30-day cycle that cost nothing. */
  freeOrders: number;
  /** Charged per protected order after the free ones. */
  pricePerOrder: number;
  /** The most charged in one cycle (the subscription's capped amount). */
  cap: number;
  features: FeatureKey[];
  tagline: string;
  highlight?: string;
}

const GROWTH_FEATURES: FeatureKey[] = ["tracking", "risk", "claimRules", "staffClaims", "languages"];

export const PLANS: Record<PlanId, Plan> = {
  STARTER: {
    id: "STARTER",
    name: "Starter",
    billingName: "SafeShip Starter",
    currency: "USD",
    freeOrders: 50,
    pricePerOrder: 0.03,
    cap: 149,
    features: [],
    tagline: "Protection in the cart and a claims page — everything to get started.",
  },
  GROWTH: {
    id: "GROWTH",
    name: "Growth",
    billingName: "SafeShip Growth",
    currency: "USD",
    freeOrders: 50,
    pricePerOrder: 0.05,
    cap: 299,
    features: GROWTH_FEATURES,
    tagline: "Shipment tracking and smarter claim reviews for stores shipping every day.",
    highlight: "Most popular",
  },
  PRO: {
    id: "PRO",
    name: "Pro",
    billingName: "SafeShip Pro",
    currency: "USD",
    freeOrders: 50,
    pricePerOrder: 0.08,
    cap: 499,
    features: [...GROWTH_FEATURES, "marketPrices", "exactPricing", "checkoutToggle"],
    tagline: "Market prices and Shopify Plus checkout features for international brands.",
  },
};

export const PLAN_ORDER: PlanId[] = ["STARTER", "GROWTH", "PRO"];

/** The plan before tiers existed ("SafeShip Usage", $0.05 after 50, $299 cap) = Growth. */
const LEGACY_NAMES: Record<string, PlanId> = { "SafeShip Usage": "GROWTH" };

export function planFromBillingName(name: string | null | undefined): PlanId | null {
  if (!name) return null;
  return PLAN_ORDER.find((id) => PLANS[id].billingName === name) ?? LEGACY_NAMES[name] ?? null;
}

export const isPlanId = (v: unknown): v is PlanId => PLAN_ORDER.includes(v as PlanId);

/** Does a plan include a feature? No plan (null) has none of the gated ones. */
export const hasFeature = (plan: PlanId | null | undefined, f: FeatureKey) =>
  !!plan && PLANS[plan].features.includes(f);

/** The cheapest plan with a feature, for "Available on Growth" badges. */
export const lowestPlanWith = (f: FeatureKey): Plan => PLANS[PLAN_ORDER.find((id) => hasFeature(id, f)) ?? "PRO"];

export const planTerms = (p: Plan) =>
  `First ${p.freeOrders} protected orders each 30-day cycle free, then $${p.pricePerOrder.toFixed(
    2,
  )} per protected order. Never more than $${p.cap} per cycle.`;

/** Free or charged, given how many protected orders the cycle already counted. */
export const decideCharge = (plan: Plan, usedThisCycle: number): "FREE" | "CHARGE" =>
  usedThisCycle < plan.freeOrders ? "FREE" : "CHARGE";

/** What a cycle with this many protected orders costs on a plan. */
export const cycleCost = (plan: Plan, protectedOrders: number) =>
  Math.min(plan.cap, Math.round(Math.max(0, protectedOrders - plan.freeOrders) * plan.pricePerOrder * 100) / 100);

// ---- The Plan & pricing page ----

/** The short list on each plan card; ✕ where the plan doesn't have it. */
export const CARD_FEATURES: { text: string; on: "all" | FeatureKey }[] = [
  { text: "Protection toggle in the cart drawer and cart page", on: "all" },
  { text: "Fixed, percentage or tiered pricing; choose covered products", on: "all" },
  { text: "Checkout rule against duplicates and wrong prices", on: "all" },
  { text: "Claims page with photo uploads", on: "all" },
  { text: "Refunds, replacements and store credit in one click", on: "all" },
  { text: "Fees, claim costs and net results", on: "all" },
  { text: "Shipment tracking with late and lost-package flags", on: "tracking" },
  { text: "Claim risk signals and review priority", on: "risk" },
  { text: "Claim limits, evidence rules, staff-created claims", on: "claimRules" },
  { text: "Claims page and emails in 7 languages", on: "languages" },
  { text: "Prices by market", on: "marketPrices" },
  { text: "Exact pricing and checkout toggle (Shopify Plus)", on: "checkoutToggle" },
];

// ---- The comparison table on the Plan & pricing page ----

export interface ComparisonRow {
  label: string;
  /** Plans that include it. "all" = every plan. */
  on: "all" | FeatureKey;
  hint?: string;
}

export const COMPARISON: { group: string; rows: ComparisonRow[] }[] = [
  {
    group: "Protection in the cart",
    rows: [
      { label: "Toggle in the cart drawer and cart page, no page reload", on: "all" },
      { label: "Fixed fee, percentage of the cart or price tiers", on: "all" },
      { label: "Minimum and maximum fee, minimum cart value", on: "all" },
      { label: "Choose which products are covered (tags, types, vendors, products)", on: "all" },
      { label: "Pre-ticked or not, always unticked in the EU, EEA, UK and Switzerland", on: "all" },
      { label: "Your own title, description and “learn more” link", on: "all" },
      { label: "Widget in 7 languages and every currency", on: "all" },
      { label: "Checkout rule: no duplicates, no wrong prices", on: "all" },
      { label: "Prices by market (e.g. €2.99 in Europe)", on: "marketPrices" },
      { label: "Exact percentage fee instead of the nearest price point", on: "exactPricing", hint: "Shopify Plus stores" },
      { label: "Protection toggle inside checkout", on: "checkoutToggle", hint: "Shopify Plus stores" },
    ],
  },
  {
    group: "Claims",
    rows: [
      { label: "Branded claims page on your store, with photo uploads", on: "all" },
      { label: "Customers verify with order number and email", on: "all" },
      { label: "Approve, reject or ask for more information; full history", on: "all" },
      { label: "Customer emails at every step, and alerts to you", on: "all" },
      { label: "Refund, free replacement order or store credit in one click", on: "all" },
      { label: "Claim window, claims per order, protection required", on: "all" },
      { label: "Claims page and customer emails in 7 languages", on: "languages", hint: "English on Starter" },
      { label: "Risk signals: repeat customers or addresses, duplicate tracking, high value", on: "risk" },
      { label: "Review priority, and dismissing a flag with a note", on: "risk" },
      { label: "Limits per order and per customer, documents for lost or stolen claims", on: "claimRules" },
      { label: "Claim window from delivery instead of shipping", on: "claimRules" },
      { label: "Create claims for customers who contact you", on: "staffClaims" },
    ],
  },
  {
    group: "Tracking",
    rows: [
      { label: "Every protected package with its carrier status", on: "tracking" },
      { label: "Flags for not picked up, stalled, late and possibly lost", on: "tracking" },
      { label: "Carrier data that supports or questions a claim", on: "tracking" },
    ],
  },
  {
    group: "Reports",
    rows: [
      { label: "Fees collected, claim costs and net result", on: "all" },
      { label: "Attach rate and recent protected orders", on: "all" },
      { label: "CSV export of claims", on: "all" },
    ],
  },
];

export const planHasRow = (plan: PlanId, row: ComparisonRow) => row.on === "all" || hasFeature(plan, row.on);
