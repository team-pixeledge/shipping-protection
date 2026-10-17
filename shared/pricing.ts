// The one source of truth for what protection costs. Used by:
//   - the admin (settings preview, building the price ladder),
//   - the storefront widget (which variant to put in the cart),
//   - the checkout validation function (is the protection line right).
// Pure TypeScript, no imports, no Node/DOM APIs — it is bundled into all
// three, and `npm run sync:shared` copies it into the function extension
// (the function build only bundles files inside its own folder).
//
// Money: every amount in the rules is in the SHOP's currency (what the
// merchant types in the admin). Carts may be in another (presentment)
// currency — callers divide by the presentment rate first. Ladder prices are
// integers in the shop currency's minor unit (cents).

export type FeeMode = "FIXED" | "PERCENT" | "TIERED";
export type TierType = "FIXED" | "PERCENT";

export interface Tier {
  /** The tier applies to subtotals at or above this amount. */
  from: number;
  type: TierType;
  /** A fixed fee, or a percentage (3 = 3%). */
  value: number;
}

export interface PricingRules {
  mode: FeeMode;
  fixedFee: number;
  /** PERCENT mode: 3 = 3% of the subtotal. */
  percent: number;
  tiers: Tier[];
  /** Floor and cap for every percentage-based fee (PERCENT mode, percent tiers). */
  minFee: number;
  maxFee: number;
  /** Don't offer protection below this subtotal (0 = always offer). */
  minSubtotal: number;
}

// ---- Which products are covered ----

/**
 * ALL    — every product that ships.
 * ONLY   — only products matching a rule below.
 * EXCEPT — every product that ships, except those matching a rule.
 * Products that don't need shipping (digital, services) and gift cards are
 * never covered, whatever the mode.
 */
export type CoverageMode = "ALL" | "ONLY" | "EXCEPT";

export interface Coverage {
  mode: CoverageMode;
  /** Product tags, as typed in Shopify. Matching ignores case. */
  tags: string[];
  productTypes: string[];
  vendors: string[];
  productIds: number[];
}

export const DEFAULT_COVERAGE: Coverage = { mode: "ALL", tags: [], productTypes: [], vendors: [], productIds: [] };

/** Rules lists are kept short: the config rides on every storefront page. */
export const COVERAGE_LIMITS = { tags: 50, productTypes: 50, vendors: 50, productIds: 250 };

/** Does the coverage depend on tags (which the cart API doesn't return)? */
export const usesTags = (c: Coverage | undefined) => !!c && c.mode !== "ALL" && c.tags.length > 0;

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Does any of these tags appear on the product? Case-insensitive. */
export const matchesTags = (c: Coverage, productTags: string[]) => {
  const want = new Set(c.tags.map(norm));
  return productTags.some((t) => want.has(norm(t)));
};

/** Is this cart/order line covered by protection (and counted in the fee)? */
export function lineCovered(c: Coverage | undefined, l: CartLine): boolean {
  if (l.requiresShipping === false || l.giftCard === true) return false;
  const cov = c ?? DEFAULT_COVERAGE;
  if (cov.mode === "ALL") return true;
  const type = norm(l.productType);
  const vendor = norm(l.vendor);
  const match =
    (l.productId !== null && cov.productIds.includes(l.productId)) ||
    (type !== "" && cov.productTypes.some((t) => norm(t) === type)) ||
    (vendor !== "" && cov.vendors.some((v) => norm(v) === vendor)) ||
    l.tagMatch === true;
  return cov.mode === "ONLY" ? match : !match;
}

// ---- Fixed prices per market ----

/**
 * A market where protection costs a fixed amount in the market's own
 * currency, whatever the pricing mode. Charged through a dedicated variant
 * whose price the market's price list fixes (app/lib/markets.server.ts).
 */
export interface MarketPrice {
  /** Numeric Shopify market ID. */
  marketId: number;
  name: string;
  /** Countries in the market, ISO codes, upper case. */
  countries: string[];
  /** The fee, in `currency` (the market's price list currency). */
  amount: number;
  currency: string;
  /** The protection variant this market's price list prices at `amount`. */
  variantId: number;
}

/** The market price for a shopper's country, if the merchant set one. */
export function marketFor(cfg: Pick<ProtectionConfig, "markets">, country: string | null | undefined): MarketPrice | null {
  const c = (country ?? "").toUpperCase();
  if (!c || !cfg.markets?.length) return null;
  return cfg.markets.find((m) => m.countries.includes(c)) ?? null;
}

/** What the storefront and the validation function read (a metafield). */
export interface ProtectionConfig {
  /** Bumped on every save; the widget re-checks the cart when it changes. */
  v: number;
  enabled: boolean;
  rules: PricingRules;
  /** Shop currency, ISO 4217, and its number of decimals. */
  currency: string;
  decimals: number;
  /** [price in minor units, variant ID], ascending by price. */
  ladder: [number, number][];
  productId: number;
  handle: string;
  /** Start with protection added — except in optInCountries. */
  defaultOn: boolean;
  /** ISO country codes where protection always starts unticked. */
  optInCountries: string[];
  copy: { title: string; description: string; learnMoreUrl: string };
  /** Which products are covered. Missing in configs saved before it existed = ALL. */
  coverage?: Coverage;
  /** Fixed prices per market. Missing = none. */
  markets?: MarketPrice[];
  /**
   * Plus stores with exact pricing on: a cart transform sets the protection
   * line to the exact fee, so the variant only needs to be close.
   */
  exact?: boolean;
}

/**
 * Product variants per protection product. Shopify allows 2,048, but the
 * ladder rides in a metafield that every storefront page loads, so keep it
 * small: 250 price points is ~1.5% resolution from 1 to 1,000.
 */
export const MAX_LADDER = 250;

/**
 * Countries where a paid add-on must not be pre-ticked: EU (Consumer Rights
 * Directive art. 22), EEA, the UK (CCR 2013 reg. 40) and Switzerland.
 * Merchants can edit the list, but the admin warns before removing one.
 */
export const OPT_IN_REQUIRED_COUNTRIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE", "IS", "LI", "NO", "GB", "CH",
];

export const DEFAULT_RULES: PricingRules = {
  mode: "PERCENT",
  fixedFee: 2.95,
  percent: 3,
  tiers: [
    { from: 0, type: "FIXED", value: 1.95 },
    { from: 50, type: "FIXED", value: 2.95 },
    { from: 150, type: "PERCENT", value: 2 },
  ],
  minFee: 0.95,
  maxFee: 50,
  minSubtotal: 0,
};

export const toMinor = (amount: number, decimals: number) =>
  Math.round(amount * 10 ** decimals);

export const fromMinor = (minor: number, decimals: number) =>
  minor / 10 ** decimals;

const clamp = (fee: number, r: PricingRules) =>
  Math.min(r.maxFee, Math.max(r.minFee, fee));

const sortedTiers = (r: PricingRules) =>
  [...r.tiers].sort((a, b) => a.from - b.from);

/**
 * The fee for a subtotal (shop currency), before snapping to the ladder.
 * null = protection isn't offered for this cart.
 */
export function computeFee(r: PricingRules, subtotal: number): number | null {
  if (!(subtotal > 0) || subtotal < r.minSubtotal) return null;
  let fee: number;
  switch (r.mode) {
    case "FIXED":
      fee = r.fixedFee;
      break;
    case "PERCENT":
      fee = clamp((subtotal * r.percent) / 100, r);
      break;
    case "TIERED": {
      const tier = sortedTiers(r)
        .filter((t) => t.from <= subtotal)
        .pop();
      if (!tier) return null;
      fee = tier.type === "FIXED" ? tier.value : clamp((subtotal * tier.value) / 100, r);
      break;
    }
    default:
      return null;
  }
  return fee > 0 ? fee : null;
}

/**
 * Every price the protection product needs a variant for, in minor units.
 * Fixed fees get an exact variant. A percentage can produce any amount
 * between the floor and cap, so that range is covered by evenly spaced
 * points — every cent if they fit, otherwise geometric (same relative
 * step everywhere, ~1.5% at the default 250).
 */
export function buildLadder(r: PricingRules, decimals: number, max = MAX_LADDER): number[] {
  const exact = new Set<number>();
  let lo = Infinity;
  let hi = -Infinity;
  const addRange = (a: number, b: number) => {
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
  };

  if (r.mode === "FIXED") exact.add(toMinor(r.fixedFee, decimals));
  if (r.mode === "PERCENT") addRange(r.minFee, r.maxFee);
  if (r.mode === "TIERED") {
    const tiers = sortedTiers(r);
    tiers.forEach((t, i) => {
      if (t.type === "FIXED") {
        exact.add(toMinor(t.value, decimals));
        return;
      }
      // A percent tier spans [from, next tier's from) of subtotal.
      const next = tiers[i + 1]?.from;
      const a = clamp((Math.max(t.from, r.minSubtotal) * t.value) / 100, r);
      const b = next === undefined ? r.maxFee : clamp((next * t.value) / 100, r);
      addRange(a, b);
    });
  }

  const points = new Set([...exact].filter((p) => p > 0));
  if (lo <= hi) {
    const a = Math.max(1, toMinor(lo, decimals));
    const b = Math.max(a, toMinor(hi, decimals));
    points.add(a);
    points.add(b);
    const budget = max - points.size;
    if (b - a - 1 <= budget) {
      for (let p = a + 1; p < b; p++) points.add(p);
    } else if (budget > 0) {
      const ratio = (b / a) ** (1 / (budget + 1));
      for (let i = 1; i <= budget; i++) points.add(Math.round(a * ratio ** i));
    }
  }
  return [...points].sort((x, y) => x - y).slice(0, max);
}

/** Index of the ladder price nearest to `minor` (ties go up). */
export function snapIndex(prices: number[], minor: number): number {
  if (!prices.length) return -1;
  let lo = 0;
  let hi = prices.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prices[mid] < minor) lo = mid + 1;
    else hi = mid;
  }
  // prices[lo] is the first >= minor; compare with the one below.
  if (lo > 0 && minor - prices[lo - 1] < prices[lo] - minor) return lo - 1;
  return lo;
}

export interface Quote {
  /** The fee before snapping, shop currency. */
  fee: number;
  /** The ladder price actually charged, shop currency minor units. */
  priceMinor: number;
  variantId: number;
  /** In a market with a fixed price: what the shopper pays, in that market's currency. */
  fixed?: { amount: number; currency: string };
}

/**
 * The variant to add for a subtotal in shop currency, or null if not
 * offered. In a market with a fixed price, that market's variant — still
 * only when protection is offered for the cart at all.
 */
export function quote(cfg: ProtectionConfig, subtotal: number, country?: string | null): Quote | null {
  if (!cfg.enabled || !cfg.ladder.length) return null;
  const fee = computeFee(cfg.rules, subtotal);
  if (fee === null) return null;
  const market = marketFor(cfg, country);
  if (market) {
    return {
      fee,
      priceMinor: toMinor(market.amount, cfg.decimals),
      variantId: market.variantId,
      fixed: { amount: market.amount, currency: market.currency },
    };
  }
  const prices = cfg.ladder.map(([p]) => p);
  const [priceMinor, variantId] = cfg.ladder[snapIndex(prices, toMinor(fee, cfg.decimals))];
  return { fee, priceMinor, variantId };
}

/** Does this shopper start with protection added? */
export function startsOn(cfg: ProtectionConfig, country: string | null | undefined) {
  if (!cfg.defaultOn) return false;
  return !cfg.optInCountries.includes((country || "").toUpperCase());
}

// ---- Cart checks (validation function; the widget uses them too) ----

export interface CartLine {
  variantId: number | null;
  productId: number | null;
  quantity: number;
  /** Line subtotal in the presentment currency (major units). */
  subtotal: number;
  // What decides coverage (lineCovered). Unknown (undefined) = covered, as
  // before coverage rules existed.
  requiresShipping?: boolean;
  giftCard?: boolean;
  productType?: string | null;
  vendor?: string | null;
  /** The product has one of the coverage tags. */
  tagMatch?: boolean;
}

export type Problem = "DUPLICATE" | "ALONE" | "UNAVAILABLE" | "PRICE";

/**
 * The variants accepted for a subtotal. Generous on purpose: the widget and
 * the function compute the subtotal from slightly different numbers
 * (rounding, currency conversion, automatic discounts landing a moment
 * later), and blocking a real customer's checkout costs more than a few
 * cents of drift. ±3% of the fee, plus one ladder step either side.
 */
export function acceptedVariants(cfg: ProtectionConfig, subtotal: number, country?: string | null): Set<number> {
  const out = new Set<number>();
  const fee = computeFee(cfg.rules, subtotal);
  if (fee === null || !cfg.ladder.length) return out;
  // A market with a fixed price accepts only its own variant.
  const market = marketFor(cfg, country);
  if (market) return out.add(market.variantId);
  const prices = cfg.ladder.map(([p]) => p);
  const from = Math.max(0, snapIndex(prices, toMinor(fee * 0.97, cfg.decimals)) - 1);
  const to = Math.min(prices.length - 1, snapIndex(prices, toMinor(fee * 1.03, cfg.decimals)) + 1);
  for (let i = from; i <= to; i++) out.add(cfg.ladder[i][1]);
  return out;
}

/**
 * What's wrong with the protection in this cart, if anything.
 * `rate` = presentment currency per unit of shop currency (1 when equal);
 * `country` = the buyer's country (market prices).
 */
export function cartProblems(cfg: ProtectionConfig, lines: CartLine[], rate: number, country?: string | null): Problem[] {
  const isProtection = (l: CartLine) => l.productId === cfg.productId;
  const prot = lines.filter(isProtection);
  if (!prot.length) return [];
  // Only covered products count: alone = nothing in the cart it protects.
  const covered = lines.filter((l) => !isProtection(l) && lineCovered(cfg.coverage, l));
  const problems: Problem[] = [];

  const qty = prot.reduce((n, l) => n + l.quantity, 0);
  if (qty > 1) problems.push("DUPLICATE");
  if (!covered.length) {
    problems.push("ALONE");
    return problems;
  }
  const subtotal = covered.reduce((s, l) => s + l.subtotal, 0) / (rate > 0 ? rate : 1);
  const accepted = acceptedVariants(cfg, subtotal, country);
  if (!accepted.size) problems.push("UNAVAILABLE");
  else if (prot.some((l) => l.variantId === null || !accepted.has(l.variantId))) problems.push("PRICE");
  return problems;
}

// ---- Admin form checks ----

export function rulesErrors(r: PricingRules): string[] {
  const errs: string[] = [];
  const num = (v: number) => Number.isFinite(v) && v >= 0;
  if (!num(r.minSubtotal)) errs.push("Minimum order value can't be negative.");
  if (r.mode === "FIXED" && !(r.fixedFee > 0)) errs.push("Enter a fixed fee above 0.");
  const usesPercent =
    r.mode === "PERCENT" || (r.mode === "TIERED" && r.tiers.some((t) => t.type === "PERCENT"));
  if (r.mode === "PERCENT" && !(r.percent > 0 && r.percent <= 100))
    errs.push("Enter a percentage between 0 and 100.");
  if (usesPercent) {
    if (!num(r.minFee)) errs.push("Minimum fee can't be negative.");
    if (!(r.maxFee > 0)) errs.push("Enter a maximum fee above 0 — a percentage needs a cap.");
    if (r.maxFee < r.minFee) errs.push("Maximum fee must be at least the minimum fee.");
  }
  if (r.mode === "TIERED") {
    if (!r.tiers.length) errs.push("Add at least one tier.");
    const froms = r.tiers.map((t) => t.from);
    if (new Set(froms).size !== froms.length) errs.push("Two tiers start at the same order value.");
    r.tiers.forEach((t, i) => {
      if (!num(t.from)) errs.push(`Tier ${i + 1}: the order value can't be negative.`);
      if (!(t.value > 0)) errs.push(`Tier ${i + 1}: enter a fee above 0.`);
      if (t.type === "PERCENT" && t.value > 100) errs.push(`Tier ${i + 1}: a percentage can't exceed 100.`);
    });
  }
  return errs;
}
