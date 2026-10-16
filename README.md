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
- **Per-market default:** pre-ticked or not, and always unticked in the
  EU/EEA/UK/CH by default.
- **On the order:** the `shipping_protection.details` metafield, the
  "Shipping protection" tag, the `_shipping_protection` note attribute, and a
  dashboard showing attach rate and revenue.
- **Claims:** customers report a lost, stolen or damaged package on the
  store's own domain (`/apps/safeship/claims`), with photos. The merchant
  reviews it in the app (approve with a resolution, reject, or ask for more
  information), and both sides get emails at each step.

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
- Approving records a resolution: refund, replacement, store credit or
  other. The merchant still carries it out in Shopify.

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

`npm run dev` and `npm run deploy` first run `prepare:extensions`, which copies
`shared/pricing.ts` into the function and bundles the widget. Never run a bare
`shopify app deploy`.

## Deploy

- **Vercel:** add the Neon integration (it sets `DATABASE_URL` and
  `DATABASE_URL_UNPOOLED`), plus `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
  `SHOPIFY_APP_URL` and `SCOPES`. Builds use `npm run vercel-build`, which runs
  the migrations.
- **AWS (later):** the `Dockerfile` builds a plain Node server
  (`npm run docker-start`). Point both database URLs at RDS.
- **Extensions and app config:** `npm run deploy`. This also registers the
  app proxy. A store that installed the app before the proxy existed must
  **uninstall and reinstall** the app to get it.

## Status (2026-10-16)

- App **SafeShip: Shipping Protection** is linked in `shopify.app.toml` and
  hosted at https://safeship-app.vercel.app (Neon database).
- Version `safeship-shipping-protection-3` is released (extensions + config).
- There is only a production app so far. There is no staging app yet.
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
npm test              # 69 tests: pricing, function, orders, embed detection, widget (jsdom), claims
npm run typecheck
npm run lint
cd extensions/protection-validation && npx shopify app function build
```

## Limitations

- **Percentage fees snap to the nearest price point.** With the default floor
  and cap that's about ±1.5%. A Plus-only Cart Transform could give exact
  prices; it isn't built.
- **Express checkout skips the cart.** "Buy it now", Shop Pay, Apple Pay and
  Google Pay on product pages bypass the widget, so those orders have no
  protection.
- **There's no toggle inside checkout.** Checkout UI extensions on the
  information, shipping and payment steps are Plus-only.
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
- **Claims page is English only.** The emails are English too.
- **Order lookup sees only the last 60 days of orders.** Older orders need the
  `read_all_orders` scope, which Shopify approves separately.
- **Resolutions aren't carried out by the app.** Approving records "refund",
  "replacement" and so on; the merchant issues it in Shopify. That's phase 2.
- **No rate limit on order lookups.** Guessing needs both the order number
  and its email.
- **Uploads that are never submitted stay in Blob storage.** They're deleted
  on customer or shop redaction, but there's no other cleanup yet.
- **Not built yet:** billing, excluded products, per-market fixed prices,
  tracking sync and fraud rules (phase 3), claim analytics and CSV export
  (phase 4).
