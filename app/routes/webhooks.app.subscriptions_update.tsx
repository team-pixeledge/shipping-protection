import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { syncPlan } from "../lib/billing.server";

// app_subscriptions/update: a plan was approved, replaced, cancelled, frozen
// or expired — possibly from Shopify's side (an unpaid invoice), not our
// Plan page. Rather than trust the payload, re-read the active subscription;
// syncPlan also re-pushes the store config when the plan's features change.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, admin } = await authenticate.webhook(request);
  const known = await prisma.shop.findUnique({ where: { shop }, select: { uninstalledAt: true } });
  if (admin && known && !known.uninstalledAt) {
    try {
      await syncPlan(admin, shop);
    } catch (err) {
      console.error(`[app_subscriptions/update] ${shop}:`, err);
      return new Response(null, { status: 500 });
    }
  }
  return new Response();
};
