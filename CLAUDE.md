@AGENTS.md

# Shipping Protection — project notes

Read before exploring. Update when something architecturally significant
changes; don't let it drift.

## What this is

Shopify **public** embedded app (all plans, not only Plus): merchants offer
optional shipping protection in the cart — fixed fee, % of cart, or tiers —
toggled from the cart drawer / cart page without a reload, enforced at
checkout, recorded on the order. Scaffolded 2026-10-16 from the sibling
`../weather-slip` (React Router 7, Prisma/Postgres, Polaris web
components). Hosting: Vercel now, AWS later (`react-router.config.ts` only
applies the Vercel preset when `VERCEL=1`; `Dockerfile` for a container).

## Core design — the rules that matter

- **The storefront and checkout never call our server.** Settings save →
  `syncProtection` (`app/lib/setup.server.ts`) pushes everything into
  Shopify: product + variants, an app-installation metafield
  (`shipping_protection.config`, read by Liquid) and the same JSON on the
  validation (`$app:shipping-protection.config`, read by the function).
  If our server is down, protection keeps working.
- **Price = variant (the "ladder").** Overriding a cart line's price
  (Cart Transform `lineUpdate`) is **Plus-only** — checked in the 2026-07
  function schema. So the hidden `UNLISTED` product has one variant per
  price point: exact for fixed fees, up to `MAX_LADDER` (250) points across
  [minFee, maxFee] for percentages (every cent if it fits, else geometric,
  ~±1.5%). Variants are synced by option value ("Fee" = "2.95"); unchanged
  prices keep their variant so live carts stay valid.
- **`shared/pricing.ts` is the single source of truth** for fee, ladder,
  snapping and cart checks. Used by the admin (preview), the widget
  (bundled by esbuild) and the function (copied by `npm run sync:shared`
  — the function build only bundles its own folder; `test/shared-copy`
  fails on drift). Never edit `extensions/protection-validation/src/pricing.ts`
  or `extensions/protection-widget/assets/protection.js` — both generated;
  `npm run dev`/`deploy` regenerate them.
- **Money:** rules are in the shop currency. Carts in another currency are
  divided by the presentment rate (`Shopify.currency.rate` in the widget,
  `presentmentCurrencyRate` in the function). Markets converts variant
  prices, so a foreign shopper pays the converted ladder price.
- **Validation is a guard, not the UX.** Runs only from
  CHECKOUT_INTERACTION on (never CART_INTERACTION — the widget's swap would
  be rejected half way). Blocks: qty > 1 (DUPLICATE), protection alone
  (ALONE), not offered for this subtotal (UNAVAILABLE), variant outside
  ±3% / ±1 ladder step of the expected fee (PRICE). `blockOnFailure: false`
  so a function crash never blocks every checkout. Disabled config → no
  errors. Messages in EN/DE/FR/ES/IT/NL.
- **Widget (`widget/protection.ts`)** intercepts fetch + XHR to
  `/cart/(add|change|update|clear)`, then reconciles in ONE
  `/cart/update.js` (wrong variant/duplicates → 0, right variant → 1).
  Own requests carry `X-Shipping-Protection` so they aren't re-intercepted.
  Choice is cart attribute `_shipping_protection` = accepted | declined
  (reaches the order as a note attribute). Removing the line with the
  theme's own button = declined (sessionStorage remembers the last seen
  variant; a variant no longer on the ladder — merchant changed pricing —
  is not a decline). Theme redraw: Dawn `onCartUpdate()`, Horizon
  `cart:update` event, Maestrooo `cart:refresh`, Archetype `cart:build`, a
  merchant-set custom event, and on /cart (auto mode) a reload only if no
  known handler exists.
- **Default on vs. law:** `defaultOn` pre-ticks except in
  `optInCountries` (default `OPT_IN_REQUIRED_COUNTRIES` = EU, EEA, UK, CH);
  the admin warns if one is removed. Country from Liquid
  `localization.country`.
- **Installing changes nothing.** `Shop.settings` null until the first
  save; only then are product/validation created. Disabled still boots the
  widget (when the cart has items) to strip protection from carts.
- **Orders:** `orders/create` → `OrderRecord` (no customer data; upsert, so
  retries are safe), order metafield `shipping_protection.details` (pinned
  definition) and tag "Shipping protection". Needs Level 1 protected
  customer data approval in the Partner Dashboard.
- **Uninstall leaves the product** (no token after uninstall). Settings →
  "Remove from store" deletes product, validation and config first.

## Verified so far (2026-10-16)

- 47 vitest tests (pricing, function logic, order parsing, embed
  detection, settings sanitising, widget against a fake Ajax cart in jsdom).
- `shopify app function build` compiles; `function run` on a sample
  checkout returns DUPLICATE + PRICE in French; 2.7M of 11M instructions.
- Admin GraphQL inputs checked by introspecting 2026-10
  (`shopify.dev/admin-graphql-direct-proxy/2026-10`): ProductStatus
  UNLISTED, ValidationCreate/UpdateInput, ProductVariantsBulkInput, etc.
- **Not yet run against a real store** — no client_id yet. Unverified:
  `write_validations` scope name, Online Store publication lookup by
  catalog title, Liquid `app.metafields` access, Horizon `cart:update`
  redraw, and every non-Dawn theme.

## Open / next

- Billing (Managed Pricing or usage) — not built; decide plans.
- Plus stores: optional Cart Transform `lineUpdate` for exact % pricing.
- Excluded products (not counted in the subtotal), per-market fixed prices,
  claims portal, checkout UI extension toggle (Plus-only steps).
- Staging app + `shopify.app.staging.toml` before launch.
