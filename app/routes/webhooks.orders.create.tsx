import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { recordOrder, type OrderPayload } from "../lib/orders.server";
import { billProtectedOrder } from "../lib/billing.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin, payload } = await authenticate.webhook(request);
  try {
    const d = await recordOrder(admin ?? null, shop, payload as OrderPayload);
    // Billing never fails the webhook: problems are kept on the UsageCharge row.
    if (d?.protected && admin) {
      const p = payload as OrderPayload;
      await billProtectedOrder(admin, shop, { id: String(p.id), name: p.name }).catch((err) =>
        console.error(`[billing] ${shop} ${p.name}:`, err),
      );
    }
  } catch (err) {
    // 500 → Shopify retries; recordOrder is idempotent.
    console.error(`[orders/create] ${shop}:`, err);
    return new Response(null, { status: 500 });
  }
  return new Response();
};
