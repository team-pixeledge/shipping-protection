# Shipping Protection

A public Shopify app that lets merchants offer optional shipping protection in
the cart, on every Shopify plan.

- **Pricing:** a fixed fee, a percentage of the cart (with a floor and cap), or
  tiers by cart value (each tier fixed or %).
- **Cart drawer and cart page:** a toggle placed automatically above the
  checkout button, or an app block you position yourself. Add, update and remove
  happen with no page reload.
- **Right price, once:** the protection is re-priced when the cart changes and
  collapsed if it was added twice. A checkout rule blocks duplicates,
  protection on its own and wrong prices.
- **Which products are covered:** every product that ships (the default),
  only products matching some rules, or all except them. Rules can use tags,
  product types, vendors or specific products. Digital products, services
  and gift cards are never covered. The fee is calculated on covered items
  only, and a cart with none isn't offered protection.
- **Per-market default:** pre-ticked or not, and always unticked in the
  EU/EEA/UK/CH by default.
- **On the order:** the `shipping_protection.details` metafield, the
  "Shipping protection" tag, the `_shipping_protection` note attribute, and a
  dashboard showing attach rate and revenue.
- **Claims:** customers report a lost, stolen or damaged package on the
  store's own domain (`/apps/safeship/claims`), with photos. The merchant
  reviews it in the app (approve with a resolution, reject, or ask for more
  information), and both sides get emails at each step.
- **Resolving claims from the app:** an approved claim can be refunded to
  the original payment, replaced with a free order, paid as store credit,
  or recorded as handled outside the app. Each claim is resolved at most
  once.
- **Program results:** on Home, fees collected against claim costs (net and
  loss ratio) for 30 days, 90 days, 12 months or all time, plus a CSV export
  of claims.
- **Shipment tracking (phase 3):** every package of a protected or claimed
  order on a Shipments page, with flags for "not picked up", "stalled",
  "late" and "possibly lost" (thresholds in Settings → Tracking). Merchants
  can create a claim for any order from there.
- **Claim risk signals (phase 3):** repeat claims from a customer or a
  shipping address, the same tracking number on another order's claim, high
  value, "lost" while the carrier still shows movement — plus carrier data
  that supports the claim. Shown as a review priority; flags can be
  dismissed with a note. Limits per order and per customer, a claim window
  from shipping or delivery, and required evidence for lost/stolen claims.
- **Seven languages** on the claims page and in customer emails (en, de, fr,
  es, it, nl, hi). Order lookups are rate-limited.
- **Prices by market:** a fixed fee in a market's own currency (e.g. €2.99
  in Europe), set in that market's price list.
- **Shopify Plus:** exact percentage fees (a cart transform) and a
  protection toggle inside checkout (a checkout UI block).
- **Plans:** three usage-based plans, no monthly fee — Starter ($0.03),
  Growth ($0.05) and Pro ($0.08) per protected order after 50 free each
  30 days, capped at $149 / $299 / $499. Plan & pricing has plan cards, a
  full feature comparison, costs by volume and an FAQ. Tracking, risk
  signals, claim rules, staff claims and languages are on Growth; market
  prices and the Plus checkout features on Pro.

## How it works

```
Admin (this app, Vercel)            Shopify (runs without us)
─────────────────────────           ─────────────────────────────────────────
Settings → Save ──syncProtection──► Product "Shipping protection" (UNLISTED)
                                      └─ one variant per price point
                                    App metafield shipping_protection.config ──► Theme app embed / cart block
                                    Validation metafield (same JSON)        ──► Checkout validation function
orders/create webhook ◄──────────── Order placed
  └─► order metafield + tag + OrderRecord
```

Only Shopify Plus stores can override a cart line's price, so the price comes
from the variant: `shared/pricing.ts` builds a "ladder" of price points, and the
widget adds whichever variant matches the fee.

| Path | What |
|---|---|
| `shared/pricing.ts` | Fee, ladder, snapping, cart checks. Shared by all three parts. |
| `widget/protection.ts` | Storefront script, bundled into `extensions/protection-widget/assets/protection.js` |
| `extensions/protection-widget/` | Theme app extension: app embed, cart block, CSS, translations |
| `extensions/protection-validation/` | Cart and checkout validation function |
| `app/lib/setup.server.ts` | Pushes settings into Shopify |
| `app/lib/orders.server.ts` | Order webhook |
| `app/routes/app._index.tsx` / `app.settings.tsx` | Home (setup and stats) and Settings |
| `app/lib/claims.ts` | Claim rules: eligibility, flags, item pricing, statuses, settings |
| `app/lib/claims.server.ts` | Order lookup, filing, status changes, emails |
| `app/routes/proxy.*` + `app/lib/portal-pages.ts` | Storefront claims page (app proxy, rendered as Liquid in the theme) |
| `portal/claims-portal.ts` | Claims page script (uploads), bundled into `public/claims-portal.js` |
| `app/routes/app.claims*` | Admin: claims list and review page |
| `app/routes/claim-files.$id.tsx` | Evidence files, through short-lived signed links |
| `app/lib/tracking.ts` / `tracking.server.ts` | Package stages and flags / sync from Shopify fulfillments |
| `app/routes/app.shipments._index.tsx` | Admin: Shipments page |
| `app/routes/app.claims.new.tsx` | Admin: staff-created claims |
| `app/lib/daily.server.ts` + `app/routes/api.cron.daily.tsx` | Daily job (Vercel Cron): tracking, orphan uploads, rate-limit rows |
| `app/lib/i18n.ts` | Claims page and customer email translations |
| `app/lib/plan.ts` / `gates.ts` / `billing.server.ts` / `app/routes/app.plan.tsx` | Plans and features, feature gates, usage charges, Plan & pricing page |
| `app/lib/markets.server.ts` | Prices by market (price lists) |
| `extensions/protection-transform/` + `app/lib/cart-transform.server.ts` | Exact pricing cart transform (Plus) |
| `extensions/protection-checkout/` | Checkout toggle (Plus), Preact checkout UI extension |

### Claims

```
Customer on the store                  This app (Vercel)                Shopify / services
──────────────────────                 ─────────────────                ──────────────────
/apps/safeship/claims ──app proxy────► proxy.claims  ── order lookup ─► Admin API (read_orders)
  order number + email                   signed "order" token (2 h)
  pick items, describe, upload ───────► proxy.upload  ── client token ─► Vercel Blob (private)
  submit ─────────────────────────────► Claim + history ── emails ─────► Resend
/apps/safeship/claims/<id>?t=… ◄──────── status page (link in emails, 180-day token)
Admin → Claims ──────────────────────► approve / reject / ask for info ► email to the customer
```

- The customer proves the order is theirs with its number plus its email,
  or by being signed in as its customer. The claim form re-reads the order
  from Shopify, so items and prices never come from the browser.
- Checks: the order isn't cancelled, has shipped, is within the claim
  window, bought protection (unless that's turned off), has no open claim,
  and is under the claims-per-order limit. A damage claim needs a photo.
- Flags such as "marked delivered but reported lost" are hints for the
  merchant. A claim is never approved or rejected automatically.
- **Approving and carrying out are separate steps.** Approving records the
  intended resolution. Carrying it out (`app/lib/resolutions.server.ts`)
  then does one of these:
  - Refunds the claimed items through `refundCreate` (no restock, carrying
    an idempotency key), or a custom amount as money only.
  - Creates a free order for the claimed items, from the original order.
  - Issues store credit.
  - Records a cost for something handled outside the app.
- **Replacements and store credit need optional permissions**
  (`write_draft_orders`, `write_store_credit_account_transactions`). The
  merchant grants them the first time they use the feature.
- **A resolved claim can't be reopened.**

## Setup

1. Create the app in the Shopify Dev Dashboard, then link it:
   `npm run config:link`. This fills `client_id`; run `git diff` on
   `shopify.app.toml` and restore the webhooks and comments it drops.
2. In the Partner Dashboard, go to API access → Protected customer data and
   request **Level 1** (order data). We read no name, email, phone or address
   fields, and store none.
3. Start a database: `docker run -d -p 55451:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=shipping_protection postgres:16`
4. Copy `.env.example` to `.env` and fill in the keys.
5. Run `npm install`, then `npx prisma migrate deploy`, then `npm run dev`.
6. For claims:
   - **Protected customer data, Level 2.** Request access to the
     **email** field. The claims page checks the order's email, and the app
     emails the customer. Dev stores work as soon as the field is selected;
     the App Store needs a review.
   - **Resend.** Verify a sending domain, then set `RESEND_API_KEY` and
     `CLAIMS_EMAIL_FROM`. Without them claims still work, with no emails.
   - **Vercel Blob.** Use a **private** store; `BLOB_READ_WRITE_TOKEN` is set
     when it's connected. The production store `safeship-claims` already
     exists. Without the token, uploads are hidden.

7. For tracking: the app needs `read_fulfillments` (in `scopes`), and the
   daily job needs `CRON_SECRET` set on Vercel (Vercel Cron sends it).
8. For billing: in the Partner Dashboard, keep **Managed Pricing off** (the
   app uses the Billing API). Dev stores get test charges automatically;
   `BILLING_TEST=true` forces test charges anywhere (staging).

`npm run dev` and `npm run deploy` first run `prepare:extensions`, which copies
`shared/pricing.ts` into the three extensions that use it (validation,
transform, checkout) and bundles the widget. Never run a bare
`shopify app deploy`.

## Deploy

- **Vercel:** add the Neon integration (it sets `DATABASE_URL` and
  `DATABASE_URL_UNPOOLED`), plus `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
  `SHOPIFY_APP_URL`, `SCOPES` (must match `scopes` in the toml — now
  including `read_fulfillments`) and `CRON_SECRET`. Builds use
  `npm run vercel-build`, which runs the migrations. `vercel.json` schedules
  `/api/cron/daily` at 06:00 UTC.
- **AWS (later):** the `Dockerfile` builds a plain Node server
  (`npm run docker-start`). Point both database URLs at RDS.
- **Extensions and app config:** `npm run deploy`. This also registers the
  app proxy. A store that installed the app before the proxy existed must
  **uninstall and reinstall** the app to get it.

## Staging

`shopify.app.staging.toml` is a second app, **SafeShip (staging)**, for
trying changes on a dev store before merchants get them. It needs:

1. A new app in the Dev Dashboard; put its client ID and URL in place of
   every `REPLACE_ME` in `shopify.app.staging.toml`.
2. Hosting: the same Vercel project's **Preview** environment for a
   `staging` branch (one Vercel project per app — don't create another), with
   a stable branch domain and its own env vars: this app's
   `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`,
   `CRON_SECRET`, `BILLING_TEST=true`, and a separate database (a Neon
   branch). Never point staging at the production `DATABASE_URL`.
3. Deploy its config and extensions with
   `npm run prepare:extensions && npx shopify app deploy --config staging`.

The proxy subpath is `safeship-staging`, so both apps can sit on one dev
store.

## Status (2026-10-16)

- App **SafeShip: Shipping Protection** is linked in `shopify.app.toml` and
  hosted at https://safeship-app.vercel.app (Neon database).
- Version `safeship-shipping-protection-3` is released (extensions + config).
- A staging config exists (`shopify.app.staging.toml`) but the staging app
  itself hasn't been created yet.
- It has not been tested on a real store yet. See the unverified list in
  `CLAUDE.md`.

## Testing on a dev store

1. **Create a dev store.** In the Partner Dashboard, go to Stores → Add store
   → Development store. Use a Dawn or Horizon theme and add a few products.
2. **Install the app.** In the Dev Dashboard, open the app and go to Test on
   development store, or run `npm run dev` and choose the store. The admin
   loads from Vercel. `automatically_update_urls_on_dev = false` keeps the
   production URL from being swapped for a tunnel.
3. **Save the settings.** Open the app, then go to Settings, pick a pricing
   model and click Save. This creates the hidden product, its variants and the
   checkout rule. Before the first save, nothing in the store changes.
4. **Turn on the theme embed.** Go to Online Store → Themes → Customize → App
   embeds and turn on Shipping protection. Home shows a warning while it's
   off.
5. **Test the storefront.**
   - Add a product. The toggle appears above the checkout button in the cart
     drawer and on `/cart`.
   - Turn the toggle off and on. The line is removed and added with no page
     reload.
   - Change the quantities. The fee is re-priced. With % pricing, the fee
     changes in steps.
   - Remove the protection line with the theme's own remove button. It should
     stay off, because that counts as a decline.
   - Use a country in the EU, UK or CH (from the country selector). The toggle
     starts unticked.
6. **Test the checkout rule.** Use the cart API in the browser console to
   force a bad cart, then go to checkout. Each case should be blocked:
   - Protection with quantity 2.
   - Protection alone in the cart.
   - The wrong price variant.
7. **Test an order.** Turn on the Bogus gateway (Settings → Payments → test
   mode) and pay with card `1`. Then check:
   - The order has the tag "Shipping protection".
   - The order has the metafield `shipping_protection.details`.
   - The order has the note attribute `_shipping_protection`.
   - The order appears in the stats on Home.

   The order webhook needs Level 1 protected customer data approval. Without
   it, there is no order record.
8. **Test a claim.** In Settings → Claims, turn on "Let customers file
   claims on my store" and save. Then:
   - Open `https://<store>/apps/safeship/claims` and enter the order number
     and the email from step 7.
   - Pick "Arrived damaged" and an item, and add a photo. Submit.
   - Check that the confirmation email arrives with a link to the claim page.
   - In the app, open Claims, then the claim. Choose "Ask the customer for
     more information" and write a message.
   - In the email, follow the link, reply and add another photo. The claim
     goes back to "In review".
   - Approve it with a resolution. The customer gets an email, and Home
     shows the counts.
   - Also try these. Each should be refused:
     - An unshipped order.
     - The wrong email.
     - A second claim on the same order.
9. **Clean up.** Go to Settings → "Remove from store", then uninstall the app.

Warning: `.env` points at the real Neon database. Before running the server
locally (`react-router-serve`, Prisma), point `DATABASE_URL` and
`DATABASE_URL_UNPOOLED` at the local Docker database.

## Checks

```bash
npm test              # 120 tests (+10 database tests, skipped without TEST_DATABASE_URL)
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55451/shipping_protection npx vitest run test/*.db.test.ts
npm run typecheck
npm run lint
npx shopify app build --skip-dependencies-installation   # all extensions
```

## Limitations

- **Percentage fees snap to the nearest price point** (about ±1.5%) except
  on Plus stores with exact pricing on.
- **Express checkout skips the cart.** "Buy it now", Shop Pay, Apple Pay and
  Google Pay on product pages bypass the widget, so those orders have no
  protection.
- **The checkout toggle is Plus-only** (Shopify's rule for checkout blocks),
  and it hides itself when coverage uses tags or the exchange rate can't be
  read.
- **Theme coverage varies.** Dawn-family and Horizon redraw in place. Maestrooo
  and Archetype themes get their refresh events. Other themes may need the
  custom refresh event, the cart block, or a reload on the cart page. Some
  themes still count the hidden line in the cart badge.
- **Headless and Hydrogen stores aren't covered** by the theme extension.
- **Discounts:** "entire order" discount codes also discount the fee unless the
  product is excluded in the discount.
- **Fulfilment:** the protection line needs no shipping, but some 3PLs or ERPs
  still see it and need it mapped.
- **Uninstalling leaves the product behind.** Use Settings → "Remove from store"
  first.
- **Legal:** this isn't insurance; the merchant handles claims. Tax treatment
  is the merchant's call. Pre-ticking is off in the EU/EEA/UK/CH by default.
- **Coverage can't use collections.** The cart and checkout don't say which
  collections a product is in, so tag the products instead. Tag rules make
  the widget read `/products/<handle>.js` once per product per session.
  Coverage changes take effect for new carts; claims follow the current
  rules.
- **Seven languages only** on the claims page and in emails; others get
  English. The merchant's own policy text isn't translated.
- **Order lookup sees only the last 60 days of orders.** Older orders need the
  `read_all_orders` scope, which Shopify approves separately.
- **Program results aren't profit.** Payment fees, app charges and tax on
  the fee aren't included. A replacement's cost is whatever the merchant
  enters, defaulting to the items' sale value.
- **A refund made directly in Shopify isn't picked up.** Use "handled
  outside the app" to record its cost.
- **A replacement order ships to the original address.** To change it, edit
  the new order in Shopify.
- **Tracking depends on the carrier reporting to Shopify.** Without carrier
  events, only "not picked up" and "possibly lost" can be worked out.
  Delivery scans alone never decide a claim.
- **Repeat-address checks need the address field** (protected customer data).
  Without it, they're skipped.
- **Usage charges count orders when placed;** cancellations aren't refunded.
- **Plan prices are a proposal** in `app/lib/plan.ts`, to be confirmed before
  launch.
- **Not built yet:** A/B tests, widget analytics and charts (phase 4).
