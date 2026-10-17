// Shipping protection toggle in checkout (Plus). Same pricing rules as the
// storefront widget (./logic.ts); the checkout validation still checks the
// result. Choice is recorded in the _shipping_protection cart attribute.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { checkoutState, displayPrice, rateProbe } from "./logic";

export default async () => {
  render(<Extension />, document.body);
};

const ATTR = "_shipping_protection";

function readConfig() {
  const entry = shopify.appMetafields.value.find(
    (m) => m.target.type === "shop" && m.metafield.namespace === "$app:shipping-protection" && m.metafield.key === "config",
  );
  if (!entry?.metafield?.value) return null;
  try {
    return typeof entry.metafield.value === "string" ? JSON.parse(entry.metafield.value) : entry.metafield.value;
  } catch {
    return null;
  }
}

function toLines(lines) {
  return lines.map((l) => ({
    id: l.id,
    merchandiseId: l.merchandise?.id ?? "",
    productId: l.merchandise?.product?.id ?? null,
    quantity: l.quantity,
    amount: Number(l.cost?.totalAmount?.amount ?? 0),
    requiresShipping: l.merchandise?.requiresShipping,
    productType: l.merchandise?.product?.productType ?? null,
    vendor: l.merchandise?.product?.vendor ?? null,
  }));
}

/** Presentment currency per unit of shop currency (1 when they match). */
function useRate(cfg) {
  const currency = shopify.localization.currency.value?.isoCode;
  const country = shopify.localization.country.value?.isoCode;
  const [rate, setRate] = useState(null);
  useEffect(() => {
    if (!cfg) return;
    if (!currency || currency === cfg.currency) return setRate(1);
    const probe = rateProbe(cfg);
    if (!probe) return setRate(null);
    const [priceMinor, variantId] = probe;
    shopify
      .query(
        `query ($id: ID!, $country: CountryCode) @inContext(country: $country) {
          node(id: $id) { ... on ProductVariant { price { amount currencyCode } } }
        }`,
        { variables: { id: `gid://shopify/ProductVariant/${variantId}`, country } },
      )
      .then(({ data }) => {
        const p = data?.node?.price;
        const shop = priceMinor / 10 ** cfg.decimals;
        setRate(p && p.currencyCode === currency && shop > 0 ? Number(p.amount) / shop : null);
      })
      .catch(() => setRate(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the config version
  }, [cfg?.v, currency, country]);
  return rate;
}

function Extension() {
  const cfg = readConfig();
  const rate = useRate(cfg);
  const country = shopify.localization.country.value?.isoCode ?? null;
  const lines = toLines(shopify.lines.value);
  const state = checkoutState(cfg, lines, rate, country);
  const can = shopify.instructions.value.lines;
  const [busy, setBusy] = useState(false);

  // Keep a protection line on the right variant when the order changes
  // (a discount code, a removed item) — or remove it if no longer offered.
  const want = state.quote?.variantId ?? null;
  const have = state.protection.map((l) => `${l.merchandiseId}:${l.quantity}`).join(",");
  useEffect(() => {
    if (busy || !cfg || rate === null || !state.protection.length) return;
    const first = state.protection[0];
    const rightVariant = want && first.merchandiseId === `gid://shopify/ProductVariant/${want}`;
    if (state.protection.length === 1 && first.quantity === 1 && rightVariant) return;
    (async () => {
      setBusy(true);
      try {
        for (const extra of state.protection.slice(1)) {
          if (can.canRemoveCartLine) await shopify.applyCartLinesChange({ type: "removeCartLine", id: extra.id, quantity: extra.quantity });
        }
        if (!want) {
          if (can.canRemoveCartLine) await shopify.applyCartLinesChange({ type: "removeCartLine", id: first.id, quantity: first.quantity });
        } else if (can.canUpdateCartLine) {
          await shopify.applyCartLinesChange({
            type: "updateCartLine",
            id: first.id,
            merchandiseId: `gid://shopify/ProductVariant/${want}`,
            quantity: 1,
          });
        }
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what decides the line
  }, [want, have, rate]);

  if (!cfg || !state.offered || !state.quote || rate === null || !can.canAddCartLine) return null;

  const on = state.protection.length > 0;
  const price = displayPrice(cfg, state.quote, rate);
  const currency = price.currency ?? shopify.localization.currency.value?.isoCode;
  const priceText = currency ? shopify.i18n.formatCurrency(price.amount, { currencyCode: currency }) : String(price.amount);
  const title = cfg.copy?.title || shopify.i18n.translate("title");
  const description = cfg.copy?.description || shopify.i18n.translate("description");

  async function toggle(event) {
    const checked = event.target.checked;
    setBusy(true);
    try {
      if (checked) {
        await shopify.applyCartLinesChange({
          type: "addCartLine",
          merchandiseId: `gid://shopify/ProductVariant/${state.quote.variantId}`,
          quantity: 1,
        });
      } else {
        for (const l of state.protection) {
          await shopify.applyCartLinesChange({ type: "removeCartLine", id: l.id, quantity: l.quantity });
        }
      }
      if (shopify.instructions.value.attributes?.canUpdateAttributes) {
        await shopify.applyAttributeChange({ type: "updateAttribute", key: ATTR, value: checked ? "accepted" : "declined" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-checkbox
          checked={on}
          disabled={busy || (on && !can.canRemoveCartLine)}
          label={`${title} (${priceText})`}
          onChange={toggle}
        />
        <s-text color="subdued">{description}</s-text>
        {cfg.copy?.learnMoreUrl ? (
          <s-link href={cfg.copy.learnMoreUrl} target="_blank">
            {shopify.i18n.translate("learnMore")}
          </s-link>
        ) : null}
      </s-stack>
    </s-box>
  );
}
