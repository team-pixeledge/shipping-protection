import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordOrder, type OrderPayload } from "../lib/orders.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, payload } = await authenticate.webhook(request);
  try {
    await recordOrder(admin ?? null, shop, payload as OrderPayload);
  } catch (err) {
    // 500 → Shopify retries; recordOrder is idempotent.
    console.error(`[orders/create] ${shop}:`, err);
    return new Response(null, { status: 500 });
  }
  return new Response();
};
