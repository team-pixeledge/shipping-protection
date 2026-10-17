// The daily job (Vercel Cron → app/routes/api.cron.daily.tsx): shipment
// tracking for every active shop, then housekeeping. Each step is best
// effort and time-boxed; whatever doesn't fit carries over to tomorrow.
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { cleanupOrphanUploads } from "./blob.server";
import { syncShop, TRACKING_PLANS } from "./tracking.server";

export async function runDaily(budgetMs = 240_000) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const report: Record<string, unknown> = {};

  // Shops least recently synced first, so a shop that didn't fit yesterday goes first today.
  const shops = await prisma.shop.findMany({
    // Tracking is a plan feature: other shops are skipped.
    where: { uninstalledAt: null, settings: { not: { equals: null } }, plan: { in: TRACKING_PLANS } },
    select: { shop: true },
  });
  const order = await prisma.shipment.groupBy({ by: ["shop"], _min: { checkedAt: true } });
  const oldest = new Map(order.map((o) => [o.shop, o._min.checkedAt?.getTime() ?? 0]));
  shops.sort((a, b) => (oldest.get(a.shop) ?? 0) - (oldest.get(b.shop) ?? 0));

  const tracking: Record<string, unknown> = {};
  for (const { shop } of shops) {
    if (Date.now() > deadline - 30_000) break;
    try {
      const { admin } = await unauthenticated.admin(shop);
      tracking[shop] = await syncShop(admin, shop, deadline - 30_000);
    } catch (err) {
      tracking[shop] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  report.tracking = tracking;

  try {
    report.orphanUploads = await cleanupOrphanUploads(Math.max(deadline - 10_000, Date.now() + 5_000));
  } catch (err) {
    report.orphanUploads = { error: err instanceof Error ? err.message : String(err) };
  }
  report.rateLimits = (await prisma.rateLimit.deleteMany({ where: { resetAt: { lt: new Date() } } })).count;
  report.ms = Date.now() - started;
  return report;
}
