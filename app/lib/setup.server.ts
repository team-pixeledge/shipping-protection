// Pushes the merchant's saved settings into Shopify. Everything the
// storefront and checkout need lives in Shopify after this, so neither ever
// calls our server:
//   1. the "Shipping protection" product (UNLISTED: buyable, but not in
//      search, collections or recommendations), published to the Online
//      Store, with one variant per ladder price — non-Plus stores can't
//      override a cart line's price, so the price IS the variant;
//   2. the config as an app-installation metafield (the theme extension
//      reads it in Liquid);
//   3. the same config on the checkout validation (the function reads it);
//   4. an order metafield definition so the per-order details show up on
//      the order page.
// Idempotent: run it again and it converges. Saving settings runs it.
import prisma from "../db.server";
import { buildLadder, toMinor, type ProtectionConfig } from "../../shared/pricing";
import { currencyDecimals, parseSettings } from "./settings";
import { applyMarketPrices, listMarkets, planMarketPrices, type PlannedMarketPrice } from "./markets.server";
import { setTransformConfig, syncCartTransform } from "./cart-transform.server";

export interface AdminGraphql {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

export const OPTION_NAME = "Fee";
export const FUNCTION_HANDLE = "protection-validation";
export const CONFIG_NAMESPACE = "shipping_protection"; // app-installation metafield (Liquid)
export const VALIDATION_NAMESPACE = "$app:shipping-protection"; // must match the function's input query
export const CHECKOUT_NAMESPACE = "$app:shipping-protection"; // shop metafield, read by extensions/protection-checkout
export const ORDER_NAMESPACE = "shipping_protection";
export const ORDER_KEY = "details";
const BATCH = 100;

type UserError = { field?: string[] | null; message: string; code?: string | null };

async function gql<T>(admin: AdminGraphql, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data as T;
}

function check(errors: UserError[] | undefined, what: string) {
  if (errors?.length) throw new Error(`${what}: ${errors.map((e) => e.message).join("; ")}`);
}

const label = (minor: number, decimals: number) => (minor / 10 ** decimals).toFixed(decimals);
const numericId = (gid: string) => Number(gid.split("/").pop());

// ---- Product ----

interface ProductRef {
  id: string;
  handle: string;
}

async function ensureProduct(
  admin: AdminGraphql,
  productId: string | null,
  firstLabel: string,
): Promise<ProductRef> {
  if (productId) {
    const data = await gql<{ product: { id: string; handle: string; status: string } | null }>(
      admin,
      `#graphql
      query SpProduct($id: ID!) { product(id: $id) { id handle status } }`,
      { id: productId },
    );
    const p = data.product;
    if (p) {
      if (p.status !== "UNLISTED") {
        // Archived or set to draft/active by hand: put it back, or carts break.
        const upd = await gql<{ productUpdate: { userErrors: UserError[] } }>(
          admin,
          `#graphql
          mutation SpProductStatus($product: ProductUpdateInput!) {
            productUpdate(product: $product) { userErrors { field message } }
          }`,
          { product: { id: p.id, status: "UNLISTED" } },
        );
        check(upd.productUpdate.userErrors, "Restoring the protection product");
      }
      return { id: p.id, handle: p.handle };
    }
    // Deleted by the merchant: make a new one below.
  }

  const appUrl = process.env.SHOPIFY_APP_URL;
  const created = await gql<{
    productCreate: { product: { id: string; handle: string } | null; userErrors: UserError[] };
  }>(
    admin,
    `#graphql
    mutation SpProductCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product { id handle }
        userErrors { field message }
      }
    }`,
    {
      product: {
        // No handle: Shopify derives "shipping-protection" from the title,
        // or adds a suffix when the merchant already has that handle.
        title: "Shipping protection",
        status: "UNLISTED",
        productType: "Shipping protection",
        tags: ["shipping-protection-app"],
        descriptionHtml:
          "<p>Optional protection for your order against loss, theft or damage in transit. " +
          "Added from the cart. Managed by the Shipping Protection app — please don't edit or delete.</p>",
        productOptions: [{ name: OPTION_NAME, values: [{ name: firstLabel }] }],
        seo: { title: "Shipping protection", description: "Optional shipping protection." },
      },
      media: appUrl
        ? [{ originalSource: `${appUrl}/protection-product.png`, mediaContentType: "IMAGE", alt: "Shipping protection" }]
        : [],
    },
  );
  check(created.productCreate.userErrors, "Creating the protection product");
  return created.productCreate.product!;
}

interface VariantRow {
  id: string;
  price: string;
  taxable: boolean;
  inventoryPolicy: string;
  selectedOptions: { name: string; value: string }[];
  inventoryItem: { tracked: boolean; requiresShipping: boolean };
}

async function listVariants(admin: AdminGraphql, productId: string): Promise<VariantRow[]> {
  const out: VariantRow[] = [];
  let after: string | null = null;
  for (;;) {
    const data: {
      product: {
        variants: { nodes: VariantRow[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
      };
    } = await gql(
      admin,
      `#graphql
      query SpVariants($id: ID!, $after: String) {
        product(id: $id) {
          variants(first: 250, after: $after) {
            nodes {
              id price taxable inventoryPolicy
              selectedOptions { name value }
              inventoryItem { tracked requiresShipping }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: productId, after },
    );
    out.push(...data.product.variants.nodes);
    if (!data.product.variants.pageInfo.hasNextPage) return out;
    after = data.product.variants.pageInfo.endCursor;
  }
}

/** An extra variant beside the ladder: a market's fixed price ("2.99 EUR"). */
export interface ExtraVariant {
  label: string;
  /** Base price (shop currency); the market's price list overrides it. */
  price: string;
}

/**
 * Makes the product's variants exactly the ladder (plus `extras`): keeps
 * variants whose price is still on it (so carts holding them stay valid),
 * creates the missing ones, deletes the rest. Returns [price minor, variant
 * ID] pairs for the ladder and label → variant ID for the extras.
 */
async function syncVariants(
  admin: AdminGraphql,
  productId: string,
  ladder: number[],
  decimals: number,
  taxable: boolean,
  extras: ExtraVariant[] = [],
): Promise<{ pairs: [number, number][]; extraIds: Map<string, number> }> {
  const ladderLabels = new Map(ladder.map((p) => [label(p, decimals), p]));
  // label → price string, for every variant the product should have.
  const wanted = new Map<string, string>([
    ...[...ladderLabels.keys()].map((l) => [l, l] as [string, string]),
    ...extras.map((e) => [e.label, e.price] as [string, string]),
  ]);
  const existing = await listVariants(admin, productId);
  const kept = new Map<string, VariantRow>();
  const toDelete: string[] = [];
  for (const v of existing) {
    const value = v.selectedOptions.find((o) => o.name === OPTION_NAME)?.value ?? "";
    if (wanted.has(value) && !kept.has(value)) kept.set(value, v);
    else toDelete.push(v.id);
  }

  const common = {
    taxable,
    inventoryPolicy: "CONTINUE",
    inventoryItem: { tracked: false, requiresShipping: false },
  };
  const toUpdate = [...kept.entries()]
    .filter(
      ([value, v]) =>
        Number(v.price) !== Number(wanted.get(value)) ||
        v.taxable !== taxable ||
        v.inventoryPolicy !== "CONTINUE" ||
        v.inventoryItem.tracked ||
        v.inventoryItem.requiresShipping,
    )
    .map(([value, v]) => ({ id: v.id, price: wanted.get(value)!, ...common }));
  const toCreate = [...wanted.keys()]
    .filter((value) => !kept.has(value))
    .map((value) => ({ price: wanted.get(value)!, optionValues: [{ optionName: OPTION_NAME, name: value }], ...common }));

  // Create before deleting: a product can't be left with zero variants.
  for (let i = 0; i < toCreate.length; i += BATCH) {
    const data = await gql<{ productVariantsBulkCreate: { userErrors: UserError[] } }>(
      admin,
      `#graphql
      mutation SpVariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }`,
      { productId, variants: toCreate.slice(i, i + BATCH) },
    );
    check(data.productVariantsBulkCreate.userErrors, "Creating price variants");
  }
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const data = await gql<{ productVariantsBulkDelete: { userErrors: UserError[] } }>(
      admin,
      `#graphql
      mutation SpVariantsDelete($productId: ID!, $variantsIds: [ID!]!) {
        productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
          userErrors { field message }
        }
      }`,
      { productId, variantsIds: toDelete.slice(i, i + BATCH) },
    );
    check(data.productVariantsBulkDelete.userErrors, "Removing old price variants");
  }
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const data = await gql<{ productVariantsBulkUpdate: { userErrors: UserError[] } }>(
      admin,
      `#graphql
      mutation SpVariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }`,
      { productId, variants: toUpdate.slice(i, i + BATCH) },
    );
    check(data.productVariantsBulkUpdate.userErrors, "Updating price variants");
  }

  const final = await listVariants(admin, productId);
  const byValue = new Map(
    final.map((v) => [v.selectedOptions.find((o) => o.name === OPTION_NAME)?.value ?? "", numericId(v.id)]),
  );
  const pairs: [number, number][] = [];
  for (const [value, minor] of ladderLabels) {
    const id = byValue.get(value);
    if (!id) throw new Error(`Price variant ${value} is missing after sync`);
    pairs.push([minor, id]);
  }
  const extraIds = new Map<string, number>();
  for (const e of extras) {
    const id = byValue.get(e.label);
    if (!id) throw new Error(`Market variant ${e.label} is missing after sync`);
    extraIds.set(e.label, id);
  }
  return { pairs: pairs.sort((a, b) => a[0] - b[0]), extraIds };
}

export type PublicationNode = {
  id: string;
  catalog: { title: string; apps?: { nodes: { handle: string }[] } } | null;
};

// Match on the Online Store app's handle: the catalog title is localised
// ("Onlineshop", "Boutique en ligne") and merchants can rename it. The
// English title is only a fallback.
export function findOnlineStorePublication(nodes: PublicationNode[]) {
  return (
    nodes.find((p) => p.catalog?.apps?.nodes.some((a) => a.handle === "online_store")) ??
    nodes.find((p) => p.catalog?.title.trim().toLowerCase() === "online store")
  );
}

async function publishToOnlineStore(admin: AdminGraphql, productId: string) {
  const data = await gql<{ publications: { nodes: PublicationNode[] } }>(
    admin,
    `#graphql
    query SpPublications {
      publications(first: 50) {
        nodes { id catalog { title ... on AppCatalog { apps(first: 5) { nodes { handle } } } } }
      }
    }`,
  );
  const online = findOnlineStorePublication(data.publications.nodes);
  if (!online) {
    const seen = data.publications.nodes
      .map((p) => `${p.catalog?.title ?? "(no catalog)"} [${p.catalog?.apps?.nodes.map((a) => a.handle).join(",") ?? ""}]`)
      .join("; ");
    throw new Error(`The Online Store sales channel wasn't found — is it installed? Publications seen: ${seen || "none"}`);
  }
  const res = await gql<{ publishablePublish: { userErrors: UserError[] } }>(
    admin,
    `#graphql
    mutation SpPublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { field message } }
    }`,
    { id: productId, input: [{ publicationId: online.id }] },
  );
  check(res.publishablePublish.userErrors, "Publishing to the Online Store");
}

// ---- Metafields + validation ----

/**
 * The config where each surface can read it: an app-installation metafield
 * for Liquid, and the same JSON as a $app shop metafield for the checkout
 * UI extension (checkout can't read app-installation metafields).
 */
async function setInstallationConfig(admin: AdminGraphql, value: string, shopGid: string) {
  const data = await gql<{
    currentAppInstallation: { id: string };
  }>(admin, `#graphql
    query SpInstallation { currentAppInstallation { id } }`);
  const res = await gql<{ metafieldsSet: { userErrors: UserError[] } }>(
    admin,
    `#graphql
    mutation SpConfigSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    {
      metafields: [
        {
          ownerId: data.currentAppInstallation.id,
          namespace: CONFIG_NAMESPACE,
          key: "config",
          type: "json",
          value,
        },
        { ownerId: shopGid, namespace: CHECKOUT_NAMESPACE, key: "config", type: "json", value },
      ],
    },
  );
  check(res.metafieldsSet.userErrors, "Saving the storefront config");
}

async function ensureValidation(admin: AdminGraphql, validationId: string | null, value: string, vars: string) {
  const metafields = [
    { namespace: VALIDATION_NAMESPACE, key: "config", type: "json", value },
    { namespace: VALIDATION_NAMESPACE, key: "vars", type: "json", value: vars },
  ];
  // blockOnFailure false: if the function itself fails (timeout, bug), let
  // the order through rather than block every checkout in the store.
  const base = { enable: true, blockOnFailure: false, title: "Shipping protection", metafields };
  if (validationId) {
    const res = await gql<{ validationUpdate: { validation: { id: string } | null; userErrors: UserError[] } }>(
      admin,
      `#graphql
      mutation SpValidationUpdate($id: ID!, $validation: ValidationUpdateInput!) {
        validationUpdate(id: $id, validation: $validation) {
          validation { id }
          userErrors { field message code }
        }
      }`,
      { id: validationId, validation: base },
    );
    if (res.validationUpdate.validation) return res.validationUpdate.validation.id;
    // Removed by the merchant (Settings → Checkout): create it again.
  }
  const res = await gql<{ validationCreate: { validation: { id: string } | null; userErrors: UserError[] } }>(
    admin,
    `#graphql
    mutation SpValidationCreate($validation: ValidationCreateInput!) {
      validationCreate(validation: $validation) {
        validation { id }
        userErrors { field message code }
      }
    }`,
    { validation: { ...base, functionHandle: FUNCTION_HANDLE } },
  );
  check(res.validationCreate.userErrors, "Turning on the checkout rule");
  return res.validationCreate.validation!.id;
}

/** Best effort: shows our details on the order page. "Already exists" is fine. */
async function ensureOrderMetafieldDefinition(admin: AdminGraphql) {
  try {
    await gql(
      admin,
      `#graphql
      mutation SpOrderDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) { userErrors { message code } }
      }`,
      {
        definition: {
          name: "Shipping protection",
          namespace: ORDER_NAMESPACE,
          key: ORDER_KEY,
          type: "json",
          ownerType: "ORDER",
          pin: true,
          description: "Whether the customer bought shipping protection, the fee and the pricing rule used.",
        },
      },
    );
  } catch (err) {
    console.warn("[setup] order metafield definition:", err instanceof Error ? err.message : err);
  }
}

// ---- Entry point ----

/**
 * Push the shop's saved settings to Shopify. Records success (syncedVersion)
 * or the failure (syncError) on the shop row; rethrows so the caller can
 * show it.
 */
export async function syncProtection(admin: AdminGraphql, shop: string) {
  const row = await prisma.shop.findUniqueOrThrow({ where: { shop } });
  const settings = parseSettings(row.settings);
  try {
    const info = await gql<{ shop: { id: string; currencyCode: string } }>(
      admin,
      `#graphql
      query SpShop { shop { id currencyCode } }`,
    );
    const currency = info.shop.currencyCode;
    const decimals = currencyDecimals(currency);
    const prices = buildLadder(settings.rules, decimals);
    if (!prices.length) throw new Error("These pricing settings don't produce any fee — check the amounts.");

    // Market prices need the markets' currencies before the variants exist.
    let planned: PlannedMarketPrice[] = [];
    const warnings: string[] = [];
    if (settings.marketPrices.length) {
      let markets;
      try {
        markets = await listMarkets(admin);
      } catch (err) {
        throw new Error(
          `Market prices need access to your markets — click “Allow access” under Prices by market, then save again. (${err instanceof Error ? err.message : err})`,
        );
      }
      const plan = planMarketPrices(markets, settings.marketPrices);
      planned = plan.planned;
      warnings.push(...plan.warnings);
    }
    const extras = [...new Map(planned.map((p) => [p.label, { label: p.label, price: label(Math.max(1, toMinor(p.amount, decimals)), decimals) }])).values()];

    const product = await ensureProduct(admin, row.productId, label(prices[0], decimals));
    const { pairs: ladder, extraIds } = await syncVariants(admin, product.id, prices, decimals, settings.taxable, extras);
    await publishToOnlineStore(admin, product.id);
    const markets = await applyMarketPrices(admin, planned, extraIds);
    const exact = await syncCartTransform(admin, settings.exactPricing, row.cartTransformId);

    const config: ProtectionConfig = {
      v: row.version,
      enabled: settings.enabled,
      rules: settings.rules,
      currency,
      decimals,
      ladder,
      productId: numericId(product.id),
      handle: product.handle,
      defaultOn: settings.defaultOn,
      optInCountries: settings.optInCountries,
      copy: settings.copy,
      coverage: settings.coverage,
      ...(markets.length ? { markets } : {}),
      ...(exact.active ? { exact: true } : {}),
    };
    const value = JSON.stringify(config);
    await setInstallationConfig(admin, value, info.shop.id);
    // The function's input variables: hasAnyTag needs the tags as a query
    // variable, which Shopify reads from this metafield on the validation.
    const vars = JSON.stringify({ coverTags: settings.coverage.mode === "ALL" ? [] : settings.coverage.tags });
    const validationId = await ensureValidation(admin, row.validationId, value, vars);
    if (exact.active && exact.id) await setTransformConfig(admin, exact.id, value, vars);
    await ensureOrderMetafieldDefinition(admin);

    await prisma.shop.update({
      where: { shop },
      data: {
        currency,
        productId: product.id,
        productHandle: product.handle,
        validationId,
        cartTransformId: exact.id,
        syncedVersion: row.version,
        syncError: null,
      },
    });
    return { config, warnings: [...warnings, ...exact.warnings] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.shop.update({ where: { shop }, data: { syncError: message.slice(0, 500) } });
    throw err;
  }
}
