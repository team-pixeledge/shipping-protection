import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { refreshOrderShipments, shouldTrack } from "../lib/tracking.server";

// fulfillments/create, fulfillments/update and fulfillment_events/create:
// re-read the order's packages when it's one we follow (protection bought,
// or a claim filed). Re-reading the whole order keeps one code path with the
// daily sync, and makes duplicate or out-of-order deliveries harmless.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, payload, topic } = await authenticate.webhook(request);
  const orderId = String((payload as { order_id?: number | string }).order_id ?? "");
  if (!admin || !/^\d+$/.test(orderId)) return new Response();
  try {
    if (await shouldTrack(shop, orderId)) await refreshOrderShipments(admin, shop, orderId);
  } catch (err) {
    // 500 → Shopify retries.
    console.error(`[${topic}] ${shop} order ${orderId}:`, err);
    return new Response(null, { status: 500 });
  }
  return new Response();
};
