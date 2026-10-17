// Exact pricing for Plus stores: registers the protection-transform
// function (extensions/protection-transform), which sets the protection
// line to the exact fee instead of the nearest price variant. Shopify only
// runs lineUpdate on Plus (and development) stores, so it's offered there
// only. Needs the optional write_cart_transforms scope (asked for on the
// settings page). One cart transform per app per store.
import type { AdminGraphql } from "./setup.server";

export const TRANSFORM_HANDLE = "protection-transform";

type UserError = { field?: string[] | null; message: string; code?: string | null };

async function gql<T>(admin: AdminGraphql, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data as T;
}

/** Can this store use exact pricing at all (Plus or a development store)? */
export async function exactPricingAvailable(admin: AdminGraphql): Promise<boolean> {
  try {
    const data = await gql<{ shop: { plan: { shopifyPlus: boolean; partnerDevelopment: boolean } } }>(
      admin,
      `#graphql
      query SpPlusCheck { shop { plan { shopifyPlus partnerDevelopment } } }`,
    );
    return data.shop.plan.shopifyPlus || data.shop.plan.partnerDevelopment;
  } catch {
    return false;
  }
}

/**
 * Turns the transform on or off to match the setting. Returns its ID (null
 * when off) and whether it's active. Turning off never fails the save.
 */
export async function syncCartTransform(
  admin: AdminGraphql,
  want: boolean,
  existingId: string | null,
): Promise<{ id: string | null; active: boolean; warnings: string[] }> {
  if (!want) {
    if (existingId) {
      try {
        await gql(
          admin,
          `#graphql
          mutation SpTransformDelete($id: ID!) { cartTransformDelete(id: $id) { deletedId userErrors { message } } }`,
          { id: existingId },
        );
      } catch (err) {
        return { id: existingId, active: false, warnings: [`Exact pricing couldn't be switched off: ${err instanceof Error ? err.message : err}`] };
      }
    }
    return { id: null, active: false, warnings: [] };
  }
  if (!(await exactPricingAvailable(admin))) {
    return { id: existingId, active: false, warnings: ["Exact pricing needs Shopify Plus, so it wasn't turned on."] };
  }
  if (existingId) return { id: existingId, active: true, warnings: [] };

  let res: { cartTransformCreate: { cartTransform: { id: string } | null; userErrors: UserError[] } };
  try {
    res = await gql(
      admin,
      `#graphql
      mutation SpTransformCreate($handle: String!) {
        cartTransformCreate(functionHandle: $handle, blockOnFailure: false) {
          cartTransform { id }
          userErrors { field message code }
        }
      }`,
      { handle: TRANSFORM_HANDLE },
    );
  } catch (err) {
    throw new Error(
      `Exact pricing needs permission to adjust cart prices — click “Allow” next to Exact pricing, then save again. (${err instanceof Error ? err.message : err})`,
    );
  }
  const errs = res.cartTransformCreate.userErrors;
  if (errs.length || !res.cartTransformCreate.cartTransform) {
    throw new Error(`Turning on exact pricing: ${errs.map((e) => e.message).join("; ")}`);
  }
  return { id: res.cartTransformCreate.cartTransform.id, active: true, warnings: [] };
}

/** The config and coverage tags the transform reads (same JSON as the validation's). */
export async function setTransformConfig(admin: AdminGraphql, id: string, value: string, vars: string) {
  const res = await gql<{ metafieldsSet: { userErrors: UserError[] } }>(
    admin,
    `#graphql
    mutation SpTransformConfig($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    {
      metafields: [
        { ownerId: id, namespace: "$app:shipping-protection", key: "config", type: "json", value },
        { ownerId: id, namespace: "$app:shipping-protection", key: "vars", type: "json", value: vars },
      ],
    },
  );
  const errs = res.metafieldsSet.userErrors;
  if (errs.length) throw new Error(`Saving the exact-pricing config: ${errs.map((e) => e.message).join("; ")}`);
}
