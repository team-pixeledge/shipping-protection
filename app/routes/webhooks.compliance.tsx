import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { deleteBlobPrefix, deleteBlobs } from "../lib/blob.server";

// Mandatory GDPR topics. Order records hold no customer data (order name,
// protected or declined, fee). Claims do: the email the customer gave,
// their description and their evidence files — those are deleted, files
// included, when Shopify asks us to redact the customer or the shop.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      const p = payload as { orders_requested?: number[]; customer?: { email?: string } };
      const ids = (p.orders_requested ?? []).map(String);
      const email = p.customer?.email?.trim().toLowerCase();
      const [rows, claims] = await Promise.all([
        ids.length ? prisma.orderRecord.findMany({ where: { shop, orderId: { in: ids } } }) : [],
        prisma.claim.findMany({
          where: { shop, OR: [{ orderId: { in: ids } }, ...(email ? [{ email }] : [])] },
          include: { files: { select: { name: true } } },
        }),
      ]);
      // Shopify forwards the request to the merchant, who answers the
      // customer; the log is the record of what we hold. Claims are visible
      // to the merchant in the app (Claims), so they can include them.
      console.log(
        `[gdpr] data_request for ${shop}: ${ids.length} order(s); orders held: ` +
          (rows.map((r) => `${r.orderName} protected=${r.protected} fee=${r.fee}`).join(", ") || "none") +
          `; claims held: ` +
          (claims.map((c) => `C-${c.number} (${c.orderName}, ${c.files.length} file(s))`).join(", ") || "none"),
      );
      break;
    }
    case "CUSTOMERS_REDACT": {
      const p = payload as { orders_to_redact?: number[]; customer?: { email?: string } };
      const ids = (p.orders_to_redact ?? []).map(String);
      const email = p.customer?.email?.trim().toLowerCase();
      if (ids.length) await prisma.orderRecord.deleteMany({ where: { shop, orderId: { in: ids } } });
      const claims = await prisma.claim.findMany({
        where: { shop, OR: [{ orderId: { in: ids } }, ...(email ? [{ email }] : [])] },
        include: { files: { select: { pathname: true } } },
      });
      await deleteBlobs(claims.flatMap((c) => c.files.map((f) => f.pathname)));
      // Uploads that never made it onto a claim, for these orders.
      for (const orderId of new Set([...ids, ...claims.map((c) => c.orderId)])) await deleteBlobPrefix(shop, orderId);
      if (claims.length) await prisma.claim.deleteMany({ where: { id: { in: claims.map((c) => c.id) } } });
      break;
    }
    case "SHOP_REDACT": {
      await deleteBlobPrefix(shop);
      // Cascades to order records and claims.
      await prisma.shop.deleteMany({ where: { shop } });
      await prisma.session.deleteMany({ where: { shop } });
      break;
    }
  }
  return new Response();
};
