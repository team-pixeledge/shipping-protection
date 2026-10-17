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
- **Phase 2, resolutions (added 2026-10-16):**
  - **Approving vs carrying out.** Approving records `Claim.resolution`;
    carrying out goes through `resolveClaim` and creates a
    `ClaimResolution` row.
  - **Each claim is resolved at most once:**
    - `lock` is a conditional update of `Claim.resolutionLock` inside a
      transaction, so a double click or two staff members can't both
      resolve it.
    - `refundCreate` carries `@idempotent(key: claim-refund-<row id>)`,
      which Shopify **requires** as of 2026-04.
    - On success the row becomes DONE and `Claim.resolvedAt` is set. On
      failure it becomes FAILED and the lock is released.
    - An attempt stuck in PROCESSING for more than 5 minutes can be
      cleared by staff after checking Shopify (`clearStuck`). It's never
      retried automatically: a new attempt gets a new idempotency key.
  - **Resolved claims can't be reopened.** The action and the UI both
    check `resolvedAt`.
  - **Refund:** `suggestedRefund` for the claimed lines with NO_RESTOCK,
    split across payments by `allocateRefund`. A custom amount is money
    only (no `refundLineItems`). The recorded cost is Shopify's
    `totalRefundedSet.shopMoney`.
  - **Replacement:** `draftOrderCreateFromOrder` → `draftOrderUpdate`
    (claimed variants, 100% discount, shipping at 0, tagged) →
    `draftOrderComplete`. The merchant enters the cost.
  - **Store credit:** `storeCreditAccountCredit` on the order's customer,
    in the shop currency.
  - **Optional scopes** (`optional_scopes` in toml, NOT in the `SCOPES`
    env) are requested from the claim page through App Bridge
    `shopify.scopes.request`.
  - **The customer sees only what they got.** There's a public RESOLVED
    event and an email. The cost note is an internal event.
  - **Program results** (`program.server.ts`) are fees from OrderRecord
    minus DONE resolution amounts, all in the shop currency. The page
    labels them "not profit". The CSV (`/app/claims/export`) is fetched
    by script (App Bridge adds the token) and has a formula-injection
    guard.
  - **DB tests** (`test/resolutions.db.test.ts`) need `TEST_DATABASE_URL`.
    They passed on 2026-10-16 against PGlite (pglite-server,
    `connection_limit=1`) because Docker was down, so the "simultaneous"
    case ran serially there. Re-run on real Postgres.
- Verified over HTTP against a local build (signed proxy requests, a fake
  offline session): pages render, Liquid is neutralised, internal notes are
  hidden, forged or wrong-purpose tokens get 404, the reply flow works,
  email failures are logged, and redaction by email works. **Not run on the
  real store yet:** the proxy itself, Blob client uploads through it
  (CORS), Resend delivery, and Level 2 email access.

## Tracking and risk (claims phase 3, added 2026-10-17)

- **Shipment rows** (`Shipment`, one per fulfillment) only for orders worth
  following: protection bought (`OrderRecord.protected`) or a claim filed
  (`shouldTrack`). All writes go through `storeShipments` /
  `refreshOrderShipments` (`app/lib/tracking.server.ts`), from:
  `fulfillments/*` + `fulfillment_events/create` webhooks (need
  `read_fulfillments` — a required scope, so existing installs re-consent),
  claim filing, the admin Refresh buttons and the daily job.
- **Daily job** = Vercel Cron → `/api/cron/daily` (Bearer `CRON_SECRET`,
  06:00 UTC, `maxDuration` 300; Hobby allows daily only). Per shop
  (least-recently synced first): re-read open packages not checked for 12 h,
  backfill protected orders with no rows (`OrderRecord.trackedAt` marks
  "looked", ≤60 days), recompute time-based flags. Then orphan uploads
  (unattached blobs > 24 h; tokens live ≤2 h so that's safe) and expired
  `RateLimit` rows. Everything time-boxed; leftovers carry over.
- **Stages/flags are pure** (`app/lib/tracking.ts`): `stageOf` maps
  `displayStatus` (deliveredAt wins); flags NO_TRACKING, NOT_SCANNED,
  STALLED (needs carrier events), LATE (needs an ETA), POSSIBLY_LOST,
  CARRIER_EXCEPTION. Thresholds in `Settings.tracking`; 0 = off. Packages
  stop being followed when delivered/cancelled or `FOLLOW_DAYS` (120) old.
- **Claim flags** (`claimFlags(RiskInput)`) use only the packages holding the
  claimed lines (`claimedShipments`, via `fulfillmentLineItems`). WARNING
  flags vs SUPPORT flags (`CARRIER_*`, carrier data backing the story).
  `reviewPriority` (Routine / Check details / Review carefully) ignores
  support and dismissed flags. Dismissing needs a note (internal event);
  never word anything as "fraud". `assessClaim` (claims.server.ts) is shared
  by the claims page and staff-created claims — keep it the only place.
- **Repeat address** uses `Claim.addressHash`: HMAC (app secret) of
  street/zip/country, never the address. Reading the address needs protected
  customer data (address); without it the query fails quietly → null → the
  check is skipped.
- **Limits** (`limitProblem`) block online filing only; staff can still
  create the claim (`/app/claims/new`), which then needs a note and gets
  OUTSIDE_POLICY. Window can start at delivery (`windowFrom`); undelivered
  packages keep it open up to FOLLOW_DAYS.

## Claims page languages + rate limits (added 2026-10-17)

- `app/lib/i18n.ts`: en, de, fr, es, it, nl, hi — page, refusal reasons,
  upload script messages (passed as `data-sp-text`), customer emails and the
  customer-visible resolution notes. A test checks every language has every
  key with the same `{placeholders}`. Admin/merchant text stays English.
- Claim rules return **refusal codes** (`Refusal`), not sentences;
  `refusalText(r, lang)` renders them (English `reason` kept for the admin).
- Language: `?lang` → form `lang` field → Accept-Language → en. On a GET
  without `?lang`, a tiny script with the page's only Liquid tag
  (`{{ request.locale.iso_code }}`) reloads with the storefront's language.
  `Claim.locale` = language it was filed in (staff claims: the order's
  `customerLocale`); status links carry `&lang=`.
- Lookup rate limits: Postgres fixed windows (`rate-limit.server.ts`), per
  order number (8/15 min), per shopper IP from X-Forwarded-For if present
  (20), per shop (600).

## Billing (added 2026-10-17)

- One usage plan (`app/lib/plan.ts` — the only place prices live): first 50
  protected orders per 30-day cycle free, then $0.05, cap $299 (the
  subscription's `cappedAmount`). Billing API, so **Managed Pricing must be
  off** in the Partner Dashboard.
- `app.tsx` loader: no active plan → redirect to `/app/plan` (the only page
  open without one). `Shop.billingTest` (dev store or `BILLING_TEST=true`,
  set in afterAuth) drives `isTest`.
- `orders/create` → `billProtectedOrder`: one `UsageCharge` row per order
  (FREE / CHARGED / CAPPED / NO_PLAN / FAILED); the free allowance is counted
  under a per-shop `pg_advisory_xact_lock`. Usage records use the **raw**
  `appUsageRecordCreate` with `idempotencyKey: sp-order-<id>` — the library's
  `createUsageRecord` silently drops the key. FAILED rows retry on the next
  webhook delivery; billing never fails the webhook.

## Market prices, exact pricing, checkout toggle (added 2026-10-17)

- **Market prices** (`Settings.marketPrices`, `markets.server.ts`): one
  extra variant per distinct price, option value `"2.99 EUR"`, base price =
  the amount; the market's catalog price list fixes it
  (`priceListFixedPricesAdd`, needs only write_products). Listing markets
  needs optional `read_markets`. A market whose catalog has no price list
  gets one (0% adjustment); a market with **no catalog** is an error telling
  the merchant to set up its pricing — we don't create catalogs (that would
  change what the market sells). `ProtectionConfig.markets` carries the
  countries; `marketFor(cfg, country)` is the one rule: in a market, `quote`
  returns its variant and `acceptedVariants` accepts only it. The functions
  use `localization.country` (`localization.market` is deprecated).
- **Exact pricing** (Plus/dev stores): `extensions/protection-transform`
  `lineUpdate`s the protection line to `fee × presentmentCurrencyRate`.
  Registered via `cartTransformCreate(functionHandle)` (optional
  `write_cart_transforms`); its config is the same JSON in its own `$app`
  metafields; `Shop.cartTransformId`. The widget still adds the ladder
  variant, so the validation is unchanged; `cfg.exact` only changes the
  displayed price.
- **Checkout toggle** (`extensions/protection-checkout`, Preact, target
  `purchase.checkout.block.render` — Plus only, merchant places it in the
  checkout editor). Checkout can't read app-installation metafields, so
  `setInstallationConfig` also writes the config as a `$app:shipping-protection`
  **shop** metafield. Pure logic in `src/logic.ts` (tested); the rate comes
  from a Storefront API `@inContext` price of the dearest ladder variant;
  hidden when coverage uses tags or the rate is unknown.
- `shared/pricing.ts` is copied into all three extensions
  (`scripts/sync-shared.mjs`, `test/shared-copy.test.ts`).
- The CLI build writes `extensions/protection-checkout/shopify.d.ts`; it's
  git-ignored and excluded from the root tsconfig (its Preact JSX types
  clash with the admin's Polaris types).

## Staging (added 2026-10-17)

`shopify.app.staging.toml` = app "SafeShip (staging)", placeholders
`REPLACE_ME` until the app exists; proxy subpath `safeship-staging`. Host on
the same Vercel project's Preview env (`staging` branch) with its own env
vars and Neon branch — the user wants one Vercel project per app.

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

## Verified 2026-10-17 (local only)

- 120 vitest tests + 8 DB tests (resolutions, billing incl. three concurrent
  orders for the last free slot) on real Postgres (docker `safeship-db`).
- `shopify app build`: all five extensions build; the transform wasm run on a
  sample cart returns the exact fee in presentment currency.
- Admin GraphQL shapes for markets, price lists, catalogs, cart transforms
  and usage records validated against the 2026-10 direct proxy (schema only —
  access was denied there, so no data).
- **Not run on a real store:** fulfillment webhooks, the cron job, billing
  approval/usage records, market price lists, the cart transform, the
  checkout block, the language switch's `request.locale` in proxy Liquid, and
  whether Shopify forwards X-Forwarded-For / Accept-Language through the proxy.

## Open / next

- Claims phase 4: A/B testing, widget impressions/opt-in analytics, charts.
- Create the staging app and fill `shopify.app.staging.toml`.
- Excluded products: done via coverage EXCEPT (excluded lines are left out of
  the fee subtotal) — nothing separate to build.
