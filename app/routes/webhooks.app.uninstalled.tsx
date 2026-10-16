import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }
  // Keep settings until shop/redact (48h later) so a quick reinstall keeps
  // them. The theme extension and validation stop with the uninstall; the
  // protection product stays in the store (no token left to remove it) —
  // Settings has "Remove from store" for a clean exit before uninstalling.
  await db.shop.updateMany({ where: { shop }, data: { uninstalledAt: new Date() } });
  return new Response();
};
