import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

// Mandatory GDPR topics. We hold no customer data: per order only the order
// name, whether protection was bought or declined, and the fee. The same
// details sit on the order itself (shipping_protection.details), which
// Shopify's own redaction covers.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      const ids = ((payload as { orders_requested?: number[] }).orders_requested ?? []).map(String);
      const rows = ids.length
        ? await prisma.orderRecord.findMany({ where: { shop, orderId: { in: ids } } })
        : [];
      // Nothing personal to hand over; log what exists for the record.
      console.log(
        `[gdpr] data_request for ${shop}: ${ids.length} order(s); held: ` +
          (rows.map((r) => `${r.orderName} protected=${r.protected} fee=${r.fee}`).join(", ") || "nothing"),
      );
      break;
    }
    case "CUSTOMERS_REDACT": {
      const ids = ((payload as { orders_to_redact?: number[] }).orders_to_redact ?? []).map(String);
      if (ids.length) await prisma.orderRecord.deleteMany({ where: { shop, orderId: { in: ids } } });
      break;
    }
    case "SHOP_REDACT": {
      // Cascades to order records.
      await prisma.shop.deleteMany({ where: { shop } });
      await prisma.session.deleteMany({ where: { shop } });
      break;
    }
  }
  return new Response();
};
