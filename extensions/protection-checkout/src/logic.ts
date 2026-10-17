// What the checkout toggle should show and do, with no checkout APIs — so it
// can be unit-tested (test/checkout.test.ts). Same rules as the storefront
// widget: shared/pricing.ts, copied here as ./pricing.ts by
// `npm run sync:shared`.
import {
  lineCovered,
  quote,
  usesTags,
  type CartLine,
  type ProtectionConfig,
  type Quote,
} from "./pricing";

export interface CheckoutLine {
  id: string;
  /** gid://shopify/ProductVariant/… */
  merchandiseId: string;
  /** gid://shopify/Product/… */
  productId: string | null;
  quantity: number;
  /** Line total, presentment currency. */
  amount: number;
  requiresShipping?: boolean;
  productType?: string | null;
  vendor?: string | null;
}

const numericId = (gid: string | null | undefined) => {
  const n = Number(gid?.split("/").pop());
  return Number.isFinite(n) ? n : null;
};

export interface CheckoutState {
  /** Protection can be offered on this checkout. */
  offered: boolean;
  quote: Quote | null;
  /** The protection lines already in checkout. */
  protection: CheckoutLine[];
  /** Why it isn't offered (for nothing but debugging). */
  reason?: string;
}

/**
 * `rate` = presentment currency per unit of shop currency, or null when it
 * couldn't be worked out (then nothing is offered rather than a wrong price).
 */
export function checkoutState(
  cfg: ProtectionConfig | null,
  lines: CheckoutLine[],
  rate: number | null,
  country: string | null,
): CheckoutState {
  const none = (reason: string): CheckoutState => ({ offered: false, quote: null, protection: [], reason });
  if (!cfg?.enabled || !cfg.productId) return none("off");
  // Tags aren't visible in checkout, so tag-based coverage can't be priced here.
  if (usesTags(cfg.coverage)) return none("tags");
  if (!rate) return none("rate");
  const isProtection = (l: CheckoutLine) => numericId(l.productId) === cfg.productId;
  const protection = lines.filter(isProtection);
  const covered = lines.filter((l) => {
    if (isProtection(l)) return false;
    const line: CartLine = {
      variantId: numericId(l.merchandiseId),
      productId: numericId(l.productId),
      quantity: l.quantity,
      subtotal: l.amount,
      requiresShipping: l.requiresShipping,
      productType: l.productType,
      vendor: l.vendor,
    };
    return lineCovered(cfg.coverage, line);
  });
  if (!covered.length) return { offered: false, quote: null, protection, reason: "nothing covered" };
  const subtotal = covered.reduce((s, l) => s + l.amount, 0) / rate;
  const q = quote(cfg, subtotal, country);
  return { offered: !!q, quote: q, protection, ...(q ? {} : { reason: "not offered" }) };
}

/** The price to show, in the buyer's currency. */
export function displayPrice(cfg: ProtectionConfig, q: Quote, rate: number): { amount: number; currency: string | null } {
  if (q.fixed) return { amount: q.fixed.amount, currency: q.fixed.currency };
  const shop = cfg.exact ? q.fee : q.priceMinor / 10 ** cfg.decimals;
  return { amount: Math.round(shop * rate * 100) / 100, currency: null };
}

/** The variant whose presentment price gives the exchange rate: the dearest ladder price. */
export const rateProbe = (cfg: ProtectionConfig) => cfg.ladder.at(-1) ?? null;
