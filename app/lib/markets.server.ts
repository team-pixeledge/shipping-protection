// Fixed protection prices per market (Shopify Markets). The protection
// product gets one extra variant per distinct price ("2.99 EUR"); each
// market's price list fixes that variant at the amount, in the price list's
// currency. The widget and the checkout rule pick the market's variant from
// the shopper's country (shared/pricing.ts marketFor).
//
// Reading markets needs the optional read_markets scope (asked for on the
// settings page). Price-list writes need write_products, which we have.
// A market without a catalog isn't set up for its own prices in Shopify:
// we say so instead of creating a catalog (that would change what the
// market sells).
import type { MarketPrice } from "../../shared/pricing";
import type { AdminGraphql } from "./setup.server";

type UserError = { field?: string[] | null; message: string; code?: string | null };

async function gql<T>(admin: AdminGraphql, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data as T;
}

export interface MarketInfo {
  id: number;
  name: string;
  /** The currency fixed prices must be in: the price list's, else the market's base currency. */
  currency: string;
  countries: string[];
  catalogId: string | null;
  priceListId: string | null;
}

const numericId = (gid: string) => Number(gid.split("/").pop());

/** The shop's active region markets. Throws if read_markets hasn't been granted. */
export async function listMarkets(admin: AdminGraphql): Promise<MarketInfo[]> {
  const data = await gql<{
    markets: {
      nodes: {
        id: string;
        name: string;
        status: string;
        currencySettings: { baseCurrency: { currencyCode: string } } | null;
        conditions: { regionsCondition: { regions: { nodes: { code?: string }[] } } | null } | null;
        catalogs: { nodes: { id: string; priceList: { id: string; currency: string } | null }[] };
      }[];
    };
  }>(
    admin,
    `#graphql
    query SpMarkets {
      markets(first: 50, type: REGION) {
        nodes {
          id name status
          currencySettings { baseCurrency { currencyCode } }
          conditions { regionsCondition { regions(first: 250) { nodes { ... on MarketRegionCountry { code } } } } }
          catalogs(first: 5) { nodes { id priceList { id currency } } }
        }
      }
    }`,
  );
  return data.markets.nodes
    .filter((m) => m.status === "ACTIVE")
    .map((m) => {
      const withList = m.catalogs.nodes.find((c) => c.priceList) ?? null;
      const catalog = withList ?? m.catalogs.nodes[0] ?? null;
      return {
        id: numericId(m.id),
        name: m.name,
        currency: withList?.priceList?.currency ?? m.currencySettings?.baseCurrency.currencyCode ?? "",
        countries: (m.conditions?.regionsCondition?.regions.nodes ?? []).flatMap((r) => (r.code ? [r.code] : [])),
        catalogId: catalog?.id ?? null,
        priceListId: withList?.priceList?.id ?? null,
      };
    })
    .filter((m) => m.countries.length > 0 && m.currency);
}

/** Variant label for a market price: the amount and currency ("2.99 EUR"). */
export const marketLabel = (amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`;

/** A price list for the market's catalog, created (0% adjustment) when it has none. */
async function ensurePriceList(admin: AdminGraphql, m: MarketInfo): Promise<string> {
  if (m.priceListId) return m.priceListId;
  if (!m.catalogId) {
    throw new Error(
      `The market “${m.name}” has no catalog, so it can't have its own prices. In Shopify, open Markets → ${m.name} and set up its product pricing first.`,
    );
  }
  const res = await gql<{ priceListCreate: { priceList: { id: string } | null; userErrors: UserError[] } }>(
    admin,
    `#graphql
    mutation SpPriceList($input: PriceListCreateInput!) {
      priceListCreate(input: $input) { priceList { id } userErrors { field message code } }
    }`,
    {
      input: {
        name: `${m.name} prices`,
        currency: m.currency,
        catalogId: m.catalogId,
        // No change to any other product's price.
        parent: { adjustment: { type: "PERCENTAGE_DECREASE", value: 0 } },
      },
    },
  );
  const errs = res.priceListCreate.userErrors;
  if (errs.length || !res.priceListCreate.priceList) {
    throw new Error(`Couldn't create prices for “${m.name}”: ${errs.map((e) => e.message).join("; ")}`);
  }
  return res.priceListCreate.priceList.id;
}

export interface PlannedMarketPrice {
  market: MarketInfo;
  amount: number;
  /** The protection variant's option value for this price. */
  label: string;
}

/**
 * Pure: the merchant's list (market ID → amount) against the shop's current
 * markets. Markets that are gone or inactive are dropped with a warning
 * rather than failing the save.
 */
export function planMarketPrices(markets: MarketInfo[], wanted: { marketId: number; amount: number }[]) {
  const all = new Map(markets.map((m) => [m.id, m]));
  const planned: PlannedMarketPrice[] = [];
  const warnings: string[] = [];
  for (const w of wanted) {
    const m = all.get(w.marketId);
    if (!m) {
      warnings.push(`A market you set a price for (ID ${w.marketId}) no longer exists or isn't active; its price was skipped.`);
      continue;
    }
    planned.push({ market: m, amount: w.amount, label: marketLabel(w.amount, m.currency) });
  }
  return { planned, warnings };
}

/** Fixes each planned price on its variant in the market's price list. */
export async function applyMarketPrices(
  admin: AdminGraphql,
  planned: PlannedMarketPrice[],
  variantIds: Map<string, number>,
): Promise<MarketPrice[]> {
  const out: MarketPrice[] = [];
  for (const p of planned) {
    const m = p.market;
    const variantId = variantIds.get(p.label);
    if (!variantId) throw new Error(`No protection variant for ${p.label}.`);
    const priceListId = await ensurePriceList(admin, m);
    const res = await gql<{ priceListFixedPricesAdd: { userErrors: UserError[] } }>(
      admin,
      `#graphql
      mutation SpMarketPrice($id: ID!, $prices: [PriceListPriceInput!]!) {
        priceListFixedPricesAdd(priceListId: $id, prices: $prices) { userErrors { field message code } }
      }`,
      {
        id: priceListId,
        prices: [
          {
            variantId: `gid://shopify/ProductVariant/${variantId}`,
            price: { amount: p.amount.toFixed(2), currencyCode: m.currency },
          },
        ],
      },
    );
    const errs = res.priceListFixedPricesAdd.userErrors;
    if (errs.length) throw new Error(`Setting the price for “${m.name}”: ${errs.map((e) => e.message).join("; ")}`);
    out.push({ marketId: m.id, name: m.name, countries: m.countries, amount: p.amount, currency: m.currency, variantId });
  }
  return out;
}
