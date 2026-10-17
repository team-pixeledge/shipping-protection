// Exact pricing for Plus stores. The storefront widget still adds the
// nearest price variant (that's what non-Plus stores are charged); this
// function then sets that line to the exact fee, in the shopper's currency.
// The checkout validation keeps checking the variant, which is unchanged.
//
// Nothing happens when: exact pricing is off, the shopper's market has a
// fixed price (its variant is already exact), protection isn't offered for
// the cart, or the store can't use lineUpdate (Shopify ignores it).
//
// pricing.ts is a generated copy of shared/pricing.ts (npm run sync:shared).
import { computeFee, lineCovered, marketFor, type CartLine, type ProtectionConfig } from "./pricing";

interface Input {
  presentmentCurrencyRate: string | number;
  localization: { country: { isoCode: string } };
  cart: {
    lines: {
      id: string;
      quantity: number;
      cost: { subtotalAmount: { amount: string | number } };
      merchandise: {
        __typename: string;
        id?: string;
        requiresShipping?: boolean;
        product?: { id: string; isGiftCard?: boolean; productType?: string | null; vendor?: string | null; hasAnyTag?: boolean };
      };
    }[];
  };
  cartTransform: { metafield?: { jsonValue: unknown } | null };
}

interface Result {
  operations: { lineUpdate: { cartLineId: string; price: { adjustment: { fixedPricePerUnit: { amount: string } } } } }[];
}

const NO_CHANGES: Result = { operations: [] };

const numericId = (gid: string | undefined) => {
  const n = Number(gid?.split("/").pop());
  return Number.isFinite(n) ? n : null;
};

export function cartTransformRun(input: Input): Result {
  const cfg = input.cartTransform.metafield?.jsonValue as ProtectionConfig | undefined;
  if (!cfg?.enabled || !cfg.exact || !cfg.productId) return NO_CHANGES;
  if (marketFor(cfg, input.localization.country.isoCode)) return NO_CHANGES;

  const lines = input.cart.lines.map((l) => ({
    id: l.id,
    line: {
      variantId: numericId(l.merchandise.id),
      productId: numericId(l.merchandise.product?.id),
      quantity: l.quantity,
      subtotal: Number(l.cost.subtotalAmount.amount),
      requiresShipping: l.merchandise.requiresShipping,
      giftCard: l.merchandise.product?.isGiftCard,
      productType: l.merchandise.product?.productType,
      vendor: l.merchandise.product?.vendor,
      tagMatch: l.merchandise.product?.hasAnyTag,
    } as CartLine,
  }));
  const protection = lines.filter((l) => l.line.productId === cfg.productId);
  // One protection line only; duplicates are the validation's job.
  if (protection.length !== 1 || protection[0].line.quantity !== 1) return NO_CHANGES;

  const rate = Number(input.presentmentCurrencyRate) || 1;
  const covered = lines.filter((l) => l.line.productId !== cfg.productId && lineCovered(cfg.coverage, l.line));
  if (!covered.length) return NO_CHANGES;
  const subtotal = covered.reduce((s, l) => s + l.line.subtotal, 0) / rate;
  const fee = computeFee(cfg.rules, subtotal);
  if (fee === null) return NO_CHANGES;

  return {
    operations: [
      {
        lineUpdate: {
          cartLineId: protection[0].id,
          price: { adjustment: { fixedPricePerUnit: { amount: (Math.round(fee * rate * 100) / 100).toFixed(2) } } },
        },
      },
    ],
  };
}
