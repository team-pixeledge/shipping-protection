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
- **Extensions and app config:** `npm run deploy`.

## Checks

```bash
npm test              # 47 tests: pricing, function, orders, embed detection, widget (jsdom)
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
- **Not built yet:** billing, excluded products, per-market fixed prices, a
  claims portal.
