// orders/create → record the order for the dashboard and store the
// protection details on the order itself (metafield + tag), so merchants,
// Flow and claim handling can see what the customer bought — or declined.
import prisma from "../db.server";
import { ORDER_KEY, ORDER_NAMESPACE, type AdminGraphql } from "./setup.server";

/** The parts of the REST order webhook payload we read. No customer data. */
export interface OrderPayload {
  id: number;
  name: string;
  created_at: string;
  currency: string; // presentment
  line_items: {
    product_id: number | null;
    quantity: number;
    price_set?: { shop_money?: { amount: string; currency_code: string } };
  }[];
  note_attributes?: { name: string; value: string }[];
}

export const PROTECTED_TAG = "Shipping protection";

export interface OrderDetails {
  protected: boolean;
  choice: "accepted" | "declined" | null;
  /** Fee charged, shop currency (0 when not protected). */
  fee: number;
  currency: string;
}

/** Pure: what this order says about protection. */
export function orderDetails(p: OrderPayload, productId: number, shopCurrency: string): OrderDetails {
  const lines = p.line_items.filter((l) => l.product_id === productId);
  const fee = lines.reduce((s, l) => s + Number(l.price_set?.shop_money?.amount ?? 0) * l.quantity, 0);
  const raw = p.note_attributes?.find((a) => a.name === "_shipping_protection")?.value;
  const choice = raw === "accepted" || raw === "declined" ? raw : null;
  return {
    protected: lines.length > 0,
    choice,
    fee: Math.round(fee * 100) / 100,
    currency: lines[0]?.price_set?.shop_money?.currency_code ?? shopCurrency,
  };
}

export async function recordOrder(admin: AdminGraphql | null, shop: string, p: OrderPayload) {
  const row = await prisma.shop.findUnique({ where: { shop } });
  if (!row?.productId) return; // never set up — nothing to record
  const d = orderDetails(p, Number(row.productId.split("/").pop()), row.currency);
  const orderId = String(p.id);

  await prisma.orderRecord.upsert({
    where: { shop_orderId: { shop, orderId } },
    create: {
      shop,
      orderId,
      orderName: p.name,
      protected: d.protected,
      choice: d.choice,
      fee: d.fee,
      currency: d.currency,
      orderedAt: new Date(p.created_at),
    },
    update: { protected: d.protected, choice: d.choice, fee: d.fee },
  });

  if (!admin) return d;
  const gid = `gid://shopify/Order/${orderId}`;
  const res = await admin.graphql(
    `#graphql
    mutation SpOrderDetails($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: gid,
            namespace: ORDER_NAMESPACE,
            key: ORDER_KEY,
            type: "json",
            value: JSON.stringify({ ...d, recordedAt: new Date().toISOString() }),
          },
        ],
      },
    },
  );
  const json = (await res.json()) as { data?: { metafieldsSet: { userErrors: { message: string }[] } } };
  const errs = json.data?.metafieldsSet.userErrors ?? [];
  if (errs.length) console.warn(`[orders] metafield on ${p.name}:`, errs.map((e) => e.message).join("; "));

  if (d.protected) {
    await admin.graphql(
      `#graphql
      mutation SpOrderTag($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) { userErrors { message } }
      }`,
      { variables: { id: gid, tags: [PROTECTED_TAG] } },
    );
  }
  return d;
}
