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

## Coverage: which products are protected (added 2026-10-16)

- `Coverage` (shared/pricing.ts) has three modes: ALL, ONLY (match) and
  EXCEPT (match). A match is a tag, product type, vendor or product ID.
  `lineCovered` is the one rule, used by the widget, the function and
  claims. Lines with `requiresShipping === false` or gift cards are **never**
  covered. Unknown facts (undefined) count as covered, so old inputs behave
  as before.
- The fee and every check (`cartProblems`) use covered lines only. ALONE
  now means "nothing covered in the cart". The ALONE messages were reworded
  in all six languages.
- **Tags** aren't in `/cart.js`. The widget reads `/products/<handle>.js`
  (cached in sessionStorage per product) only when `usesTags`. The
  function uses `product.hasAnyTag(tags: $coverTags)`. `$coverTags` is an
  input variable read from the validation's `$app:shipping-protection.vars`
  metafield (`{"coverTags": [...]}`, written by `syncProtection`), declared
  in the function toml under `[extensions.input.variables]`. Its query
  default `[]` covers validations saved before this existed.
- Collections aren't supported: neither the cart nor the function input can
  cheaply say which collections a product is in. Tags are the workaround.
- Matching ignores case on our side. **Assumption:** Shopify's
  `hasAnyTag` is case-insensitive too. If it isn't, a tag typed in a
  different case would make the widget and checkout disagree. Unverified.

## Claims (phase 1, added 2026-10-16)

The merchant's 54-item checklist was split into four phases: 1 claims core
(built), 2 resolutions and money (refund, replacement, store credit through
the API; net profit), 3 tracking and risk, 4 analytics and A/B testing.
Phase 1 records a resolution but doesn't carry it out.

- **Storefront page = app proxy** (`[app_proxy]` in shopify.app.toml,
  subpath `safeship` → `/proxy/*`). Responses are `liquid()` inside the
  theme, so **every dynamic value goes through `esc()`
  (`app/lib/portal-pages.ts`), which also escapes `{` and `}`**. Customer
  text would otherwise run as Liquid. A test checks this.
- **Forms through the proxy:** `liquid()` adds the trailing slash a proxied
  POST needs, but only when `action` is the form tag's **last** attribute,
  with no slash of its own. The script-driven upload endpoint carries its own
  slash.
- **No cookies through proxies**, so state travels in HMAC tokens
  (`claim-token.server.ts`, app secret, bound to the shop):
  - `order` (2 h, carries the verified email) between lookup and submit.
  - `claim` (180 days) for the status-page link in emails.
  - `file` (15 min) for evidence links in the admin, because `<img>` can't
    send the session token.
- **Order ownership** is proven by order number plus the order's email, or
  by `logged_in_customer_id` matching the order's customer. Reading
  `Order.email` needs **Level 2 protected customer data**. The form
  re-reads the order on submit (`getOrder`); items and prices come from
  Shopify, never the request. `read_orders` only sees 60 days.
- **Evidence:** a private Vercel Blob store (`safeship-claims`, connected to
  the project). The browser uploads directly with a client token from
  `/proxy/upload`, which only accepts paths under
  `claims/<shop>/<orderId>/`. On submit each pathname is re-checked with
  `head()`; the size and type recorded come from Blob, not the browser.
  Files are served only through `claim-files.$id` (nosniff, sandbox CSP).
- **Status machine** `canTransition`: OPEN ↔ NEEDS_INFO → APPROVED/REJECTED,
  and decided → OPEN (reopen; needs an internal note). Updates are
  conditional on the status the merchant saw. A customer reply to
  NEEDS_INFO moves the claim back to OPEN.
- **Emails** (Resend; `RESEND_API_KEY` + `CLAIMS_EMAIL_FROM`) run after
  the save, through `afterSave`. A failure (Shopify, Resend or config) is a
  history entry, never an error the user sees. Every send is logged as an
  internal `EMAIL` event.
- **Flags are hints, never verdicts** (`claimFlags`). Nothing is
  auto-approved, per the merchant's own brief.
- **GDPR:** claims hold customer data (email, description, files).
  `customers/redact` deletes matching claims by order ID **or email**,
  plus their blobs and any orphan uploads for those orders. `shop/redact`
  deletes the shop's whole blob prefix.
- `Shop.portalPath` is learnt from each proxy request (`path_prefix`), so
  links stay right if the merchant renames the subpath.
- Verified over HTTP against a local build (signed proxy requests, a fake
  offline session): pages render, Liquid is neutralised, internal notes are
  hidden, forged or wrong-purpose tokens get 404, the reply flow works,
  email failures are logged, and redaction by email works. **Not run on the
  real store yet:** the proxy itself, Blob client uploads through it
  (CORS), Resend delivery, and Level 2 email access.

## Verified so far (2026-10-16)

- 47 vitest tests (pricing, function logic, order parsing, embed
  detection, settings sanitising, widget against a fake Ajax cart in jsdom).
- `shopify app function build` compiles; `function run` on a sample
  checkout returns DUPLICATE + PRICE in French; 2.7M of 11M instructions.
- Admin GraphQL inputs checked by introspecting 2026-10
  (`shopify.dev/admin-graphql-direct-proxy/2026-10`): ProductStatus
  UNLISTED, ValidationCreate/UpdateInput, ProductVariantsBulkInput, etc.
- **First dev-store run (2026-10-16)** found that the Online Store
  publication's catalog title is "Channel Catalog <id>", not "Online
  Store". `findOnlineStorePublication` matches the `online_store` app
  handle instead. Still unverified: the `write_validations` scope name,
  Liquid `app.metafields` access, the Horizon `cart:update` redraw, and
  every non-Dawn theme.

## Open / next

- Billing (Managed Pricing or usage) — not built; decide plans.
- Plus stores: optional Cart Transform `lineUpdate` for exact % pricing.
- Excluded products (not counted in the subtotal), per-market fixed prices,
  checkout UI extension toggle (Plus-only steps).
- Claims phases 2–4 (see the Claims section). Also: a translated claims
  page, cleanup of orphan uploads, and lookup rate limiting.
- Staging app + `shopify.app.staging.toml` before launch.
