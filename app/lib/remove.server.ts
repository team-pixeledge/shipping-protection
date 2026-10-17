// "Remove from store": undoes everything setup created, for a clean
// uninstall (after uninstall there's no token left to do it).
import prisma from "../db.server";
import { CHECKOUT_NAMESPACE, CONFIG_NAMESPACE, type AdminGraphql } from "./setup.server";

export async function removeFromStore(admin: AdminGraphql, shop: string) {
  const row = await prisma.shop.findUniqueOrThrow({ where: { shop } });
  const problems: string[] = [];
  const run = async (what: string, query: string, variables: Record<string, unknown>) => {
    try {
      const res = await admin.graphql(query, { variables });
      const json = (await res.json()) as { data?: Record<string, { userErrors?: { message: string }[] }> };
      const errs = Object.values(json.data ?? {}).flatMap((v) => v?.userErrors ?? []);
      if (errs.length) problems.push(`${what}: ${errs.map((e) => e.message).join("; ")}`);
    } catch (err) {
      problems.push(`${what}: ${err instanceof Error ? err.message : err}`);
    }
  };

  if (row.validationId) {
    await run(
      "Checkout rule",
      `#graphql
      mutation SpValidationDelete($id: ID!) { validationDelete(id: $id) { userErrors { message } } }`,
      { id: row.validationId },
    );
  }
  if (row.cartTransformId) {
    await run(
      "Exact pricing",
      `#graphql
      mutation SpTransformDelete($id: ID!) { cartTransformDelete(id: $id) { userErrors { message } } }`,
      { id: row.cartTransformId },
    );
  }
  // Deleting the product also removes its market prices from price lists.
  if (row.productId) {
    await run(
      "Protection product",
      `#graphql
      mutation SpProductDelete($input: ProductDeleteInput!) { productDelete(input: $input) { userErrors { message } } }`,
      { input: { id: row.productId } },
    );
  }
  const inst = await admin.graphql(`#graphql
    query SpInstallationId { currentAppInstallation { id } shop { id } }`);
  const ids = ((await inst.json()) as { data?: { currentAppInstallation: { id: string }; shop: { id: string } } }).data;
  if (ids) {
    await run(
      "Storefront config",
      `#graphql
      mutation SpConfigDelete($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) { userErrors { message } }
      }`,
      {
        metafields: [
          { ownerId: ids.currentAppInstallation.id, namespace: CONFIG_NAMESPACE, key: "config" },
          { ownerId: ids.shop.id, namespace: CHECKOUT_NAMESPACE, key: "config" },
        ],
      },
    );
  }

  await prisma.shop.update({
    where: { shop },
    data: {
      productId: null,
      productHandle: null,
      validationId: null,
      cartTransformId: null,
      syncedVersion: 0,
      syncError: null,
    },
  });
  return problems;
}
