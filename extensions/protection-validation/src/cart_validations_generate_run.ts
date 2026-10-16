// Checkout guard for shipping protection. The storefront widget keeps the
// cart right while the shopper is on the store; this is what can't be
// bypassed — a hand-edited AJAX request, a stale tab, an app that adds to
// the cart behind the widget's back.
//
// Checks only from checkout on (not CART_INTERACTION): the widget swaps the
// protection variant with an add-then-remove, and a cart-step error would
// reject those requests half way.
//
// pricing.ts is a generated copy of shared/pricing.ts (npm run sync:shared).
// Input types are declared here rather than imported from generated/api so
// the root typecheck works without running `shopify app function typegen`;
// they mirror cart_validations_generate_run.graphql.
import { cartProblems, type CartLine, type Problem, type ProtectionConfig } from "./pricing";

interface Input {
  buyerJourney: { step?: string | null };
  presentmentCurrencyRate: string | number;
  localization: { language: { isoCode: string } };
  cart: {
    lines: {
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
  validation: { metafield?: { jsonValue: unknown } | null };
}

interface Result {
  operations: { validationAdd: { errors: { message: string; target: string }[] } }[];
}

const MESSAGES: Record<string, Record<Problem, string>> = {
  EN: {
    DUPLICATE: "Shipping protection can only be added once. Please return to your cart.",
    ALONE: "Shipping protection only covers products that are shipped. Please remove it in your cart, or add a product.",
    UNAVAILABLE: "Shipping protection isn't available for this order. Please remove it in your cart.",
    PRICE: "The shipping protection price has changed. Please return to your cart to update it.",
  },
  DE: {
    DUPLICATE: "Der Versandschutz kann nur einmal hinzugefügt werden. Bitte kehre zum Warenkorb zurück.",
    ALONE: "Der Versandschutz gilt nur für versendete Produkte. Bitte entferne ihn im Warenkorb oder lege ein Produkt hinein.",
    UNAVAILABLE: "Für diese Bestellung ist kein Versandschutz verfügbar. Bitte entferne ihn im Warenkorb.",
    PRICE: "Der Preis des Versandschutzes hat sich geändert. Bitte aktualisiere ihn im Warenkorb.",
  },
  FR: {
    DUPLICATE: "La protection d'expédition ne peut être ajoutée qu'une fois. Veuillez revenir au panier.",
    ALONE: "La protection d'expédition ne couvre que les produits expédiés. Retirez-la du panier ou ajoutez un produit.",
    UNAVAILABLE: "La protection d'expédition n'est pas disponible pour cette commande. Retirez-la du panier.",
    PRICE: "Le prix de la protection d'expédition a changé. Veuillez le mettre à jour dans le panier.",
  },
  ES: {
    DUPLICATE: "La protección de envío solo se puede añadir una vez. Vuelve a tu carrito.",
    ALONE: "La protección de envío solo cubre productos que se envían. Quítala en tu carrito o añade un producto.",
    UNAVAILABLE: "La protección de envío no está disponible para este pedido. Quítala en tu carrito.",
    PRICE: "El precio de la protección de envío ha cambiado. Actualízalo en tu carrito.",
  },
  IT: {
    DUPLICATE: "La protezione della spedizione può essere aggiunta una sola volta. Torna al carrello.",
    ALONE: "La protezione della spedizione copre solo i prodotti spediti. Rimuovila dal carrello o aggiungi un prodotto.",
    UNAVAILABLE: "La protezione della spedizione non è disponibile per questo ordine. Rimuovila dal carrello.",
    PRICE: "Il prezzo della protezione della spedizione è cambiato. Aggiornalo nel carrello.",
  },
  NL: {
    DUPLICATE: "Verzendbescherming kan maar één keer worden toegevoegd. Ga terug naar je winkelwagen.",
    ALONE: "Verzendbescherming geldt alleen voor producten die worden verzonden. Verwijder deze in je winkelwagen of voeg een product toe.",
    UNAVAILABLE: "Verzendbescherming is niet beschikbaar voor deze bestelling. Verwijder deze in je winkelwagen.",
    PRICE: "De prijs van de verzendbescherming is gewijzigd. Werk deze bij in je winkelwagen.",
  },
};

const numericId = (gid: string | undefined) => {
  const n = Number(gid?.split("/").pop());
  return Number.isFinite(n) ? n : null;
};

const NO_ERRORS: Result = { operations: [{ validationAdd: { errors: [] } }] };

export function cartValidationsGenerateRun(input: Input): Result {
  if (input.buyerJourney.step === "CART_INTERACTION") return NO_ERRORS;
  const cfg = input.validation.metafield?.jsonValue as ProtectionConfig | undefined;
  // Protection switched off after this cart was built: let the order through
  // rather than strand the shopper — the widget removes it on the next visit.
  if (!cfg || !cfg.productId || !cfg.enabled) return NO_ERRORS;

  const lines: CartLine[] = input.cart.lines.map((l) => ({
    variantId: numericId(l.merchandise.id),
    productId: numericId(l.merchandise.product?.id),
    quantity: l.quantity,
    subtotal: Number(l.cost.subtotalAmount.amount),
    requiresShipping: l.merchandise.requiresShipping,
    giftCard: l.merchandise.product?.isGiftCard,
    productType: l.merchandise.product?.productType,
    vendor: l.merchandise.product?.vendor,
    tagMatch: l.merchandise.product?.hasAnyTag,
  }));
  const rate = Number(input.presentmentCurrencyRate) || 1;
  const problems = cartProblems(cfg, lines, rate);
  const lang = input.localization.language.isoCode.split("_")[0];
  const text = MESSAGES[lang] ?? MESSAGES.EN;
  return {
    operations: [
      { validationAdd: { errors: problems.map((p) => ({ message: text[p], target: "$.cart" })) } },
    ],
  };
}
