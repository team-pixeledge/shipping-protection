// Shipment tracking: reads each package (fulfillment) of protected and
// claimed orders from Shopify, stores it as a Shipment row and recomputes
// its flags. Runs from the fulfillment webhooks, when a claim is filed, from
// the admin's "Refresh" button and from the daily job (app/routes/api.cron.daily.tsx).
// The rules are in ./tracking.ts.
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { Shipment as ClaimShipment } from "./claims";
import { parseSettings } from "./settings";
import type { AdminGraphql } from "./setup.server";
import {
  FOLLOW_DAYS,
  isOpenStage,
  shipmentFlags,
  stageOf,
  trackingNumbersOf,
  type Stage,
  type TrackingNumber,
  type TrackingSettings,
} from "./tracking";

const DAY = 86_400_000;
const numericId = (gid: string) => gid.split("/").pop()!;

async function gql<T>(admin: AdminGraphql, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data as T;
}

/** The fulfillment fields tracking needs. Also used by the claims order query. */
export const FULFILLMENT_FIELDS = `
  id status displayStatus createdAt deliveredAt inTransitAt estimatedDeliveryAt
  trackingInfo { number company url }
  events(first: 1, sortKey: HAPPENED_AT, reverse: true) { nodes { status happenedAt } }
  fulfillmentLineItems(first: 100) { nodes { lineItem { id } } }`;

export interface FulfillmentNode {
  id: string;
  status: string;
  displayStatus: string | null;
  createdAt: string;
  deliveredAt: string | null;
  inTransitAt: string | null;
  estimatedDeliveryAt: string | null;
  trackingInfo: TrackingNumber[];
  events?: { nodes: { status: string; happenedAt: string }[] } | null;
  fulfillmentLineItems?: { nodes: { lineItem: { id: string } | null }[] } | null;
}

/** Pure: a Shopify fulfillment → the package the claims flow and the rules see. */
export function toShipment(f: FulfillmentNode): ClaimShipment & { stage: Stage; lastEventStatus: string | null } {
  const last = f.events?.nodes[0] ?? null;
  return {
    id: numericId(f.id),
    status: f.displayStatus ?? f.status,
    stage: stageOf(f.displayStatus, f.status, f.deliveredAt),
    shippedAt: f.createdAt,
    deliveredAt: f.deliveredAt,
    estimatedDeliveryAt: f.estimatedDeliveryAt,
    lastEventAt: last?.happenedAt ?? null,
    lastEventStatus: last?.status ?? null,
    tracking: f.trackingInfo,
    lineItemIds: (f.fulfillmentLineItems?.nodes ?? []).flatMap((n) => (n.lineItem ? [n.lineItem.id] : [])),
  };
}

/** Whether this order's packages are worth following: protection bought, or a claim filed. */
export async function shouldTrack(shop: string, orderId: string) {
  const [rec, claim] = await Promise.all([
    prisma.orderRecord.findUnique({ where: { shop_orderId: { shop, orderId } }, select: { protected: true } }),
    prisma.claim.findFirst({ where: { shop, orderId }, select: { id: true } }),
  ]);
  return !!rec?.protected || !!claim;
}

const trackingRules = async (shop: string) =>
  parseSettings((await prisma.shop.findUnique({ where: { shop }, select: { settings: true } }))?.settings).tracking;

/** Stores one order's packages and their flags. Cancelled fulfillments close their row. */
export async function storeShipments(
  shop: string,
  order: { id: string; name: string },
  fulfillments: FulfillmentNode[],
  rules: TrackingSettings,
  now = new Date(),
) {
  for (const f of fulfillments) {
    const s = toShipment(f);
    const flags = shipmentFlags(
      {
        stage: s.stage,
        shippedAt: s.shippedAt,
        deliveredAt: s.deliveredAt,
        estimatedDeliveryAt: s.estimatedDeliveryAt ?? null,
        lastEventAt: s.lastEventAt ?? null,
        tracking: s.tracking,
      },
      rules,
      now,
    );
    const closed =
      !isOpenStage(s.stage) || now.getTime() - new Date(s.shippedAt).getTime() > FOLLOW_DAYS * DAY ? now : null;
    const prev = await prisma.shipment.findUnique({
      where: { shop_fulfillmentId: { shop, fulfillmentId: s.id! } },
      select: { flags: true, flaggedAt: true },
    });
    const changed = !prev || prev.flags.join() !== flags.join();
    const data = {
      orderId: order.id,
      orderName: order.name,
      status: s.status,
      stage: s.stage,
      tracking: s.tracking as unknown as Prisma.InputJsonValue,
      trackingNumbers: trackingNumbersOf(s.tracking),
      lineItemIds: s.lineItemIds ?? [],
      shippedAt: new Date(s.shippedAt),
      inTransitAt: f.inTransitAt ? new Date(f.inTransitAt) : null,
      deliveredAt: s.deliveredAt ? new Date(s.deliveredAt) : null,
      estimatedDeliveryAt: s.estimatedDeliveryAt ? new Date(s.estimatedDeliveryAt) : null,
      lastEventAt: s.lastEventAt ? new Date(s.lastEventAt) : null,
      lastEventStatus: s.lastEventStatus,
      flags,
      flaggedAt: changed ? (flags.length ? now : null) : prev!.flaggedAt,
      checkedAt: now,
      closedAt: closed,
    };
    await prisma.shipment.upsert({
      where: { shop_fulfillmentId: { shop, fulfillmentId: s.id! } },
      create: { shop, fulfillmentId: s.id!, ...data },
      update: data,
    });
  }
}

interface OrderShipmentsNode {
  id: string;
  name: string;
  fulfillments: FulfillmentNode[];
}

const ORDER_SHIPMENTS = `#graphql
  fragment SpOrderShipments on Order { id name fulfillments(first: 50) { ${FULFILLMENT_FIELDS} } }`;

/** Re-reads one order's packages from Shopify and stores them. */
export async function refreshOrderShipments(admin: AdminGraphql, shop: string, orderId: string) {
  const data = await gql<{ order: OrderShipmentsNode | null }>(
    admin,
    `${ORDER_SHIPMENTS}
    query SpOrderShipments($id: ID!) { order(id: $id) { ...SpOrderShipments } }`,
    { id: `gid://shopify/Order/${orderId}` },
  );
  if (!data.order) return;
  await storeShipments(shop, { id: orderId, name: data.order.name }, data.order.fulfillments, await trackingRules(shop));
  await prisma.orderRecord.updateMany({ where: { shop, orderId }, data: { trackedAt: new Date() } });
}

/** Several orders in one call (Shopify's nodes query); missing ones are skipped. */
async function refreshOrders(admin: AdminGraphql, shop: string, orderIds: string[], rules: TrackingSettings) {
  if (!orderIds.length) return;
  const data = await gql<{ nodes: (OrderShipmentsNode | null)[] }>(
    admin,
    `${ORDER_SHIPMENTS}
    query SpOrdersShipments($ids: [ID!]!) { nodes(ids: $ids) { ...SpOrderShipments } }`,
    { ids: orderIds.map((id) => `gid://shopify/Order/${id}`) },
  );
  const now = new Date();
  for (const o of data.nodes) {
    if (!o?.fulfillments) continue;
    await storeShipments(shop, { id: numericId(o.id), name: o.name }, o.fulfillments, rules, now);
  }
  await prisma.orderRecord.updateMany({ where: { shop, orderId: { in: orderIds } }, data: { trackedAt: now } });
}

const BATCH = 25;

/**
 * The daily pass for one shop:
 *   1. re-read open packages not checked in the last 12 hours, oldest first;
 *   2. look for packages of protected orders we have no row for (missed
 *      webhooks, orders from before tracking existed) — once a day each, for
 *      orders up to 60 days old (all that read_orders can see);
 *   3. recompute the flags of open packages it didn't get to: flags change
 *      with time alone ("no update for 5 days").
 * Stops when `deadline` passes; the next run carries on.
 */
export async function syncShop(admin: AdminGraphql, shop: string, deadline: number) {
  const rules = await trackingRules(shop);
  const now = new Date();
  let refreshed = 0;

  const stale = await prisma.shipment.findMany({
    where: { shop, closedAt: null, checkedAt: { lt: new Date(now.getTime() - 12 * 3600_000) } },
    orderBy: { checkedAt: "asc" },
    select: { orderId: true },
    take: 500,
  });
  const staleOrders = [...new Set(stale.map((s) => s.orderId))];
  for (let i = 0; i < staleOrders.length && Date.now() < deadline; i += BATCH) {
    await refreshOrders(admin, shop, staleOrders.slice(i, i + BATCH), rules);
    refreshed += Math.min(BATCH, staleOrders.length - i);
  }

  if (Date.now() < deadline) {
    const untracked = await prisma.orderRecord.findMany({
      where: {
        shop,
        protected: true,
        orderedAt: { gte: new Date(now.getTime() - 60 * DAY) },
        OR: [{ trackedAt: null }, { trackedAt: { lt: new Date(now.getTime() - 20 * 3600_000) } }],
      },
      orderBy: { trackedAt: { sort: "asc", nulls: "first" } },
      select: { orderId: true },
      take: 200,
    });
    // Orders that already have packages are followed through step 1.
    const known = new Set(
      (
        await prisma.shipment.findMany({
          where: { shop, orderId: { in: untracked.map((o) => o.orderId) } },
          select: { orderId: true },
        })
      ).map((s) => s.orderId),
    );
    const missing = untracked.map((o) => o.orderId).filter((id) => !known.has(id));
    await prisma.orderRecord.updateMany({
      where: { shop, orderId: { in: untracked.map((o) => o.orderId).filter((id) => known.has(id)) } },
      data: { trackedAt: now },
    });
    for (let i = 0; i < missing.length && Date.now() < deadline; i += BATCH) {
      await refreshOrders(admin, shop, missing.slice(i, i + BATCH), rules);
      refreshed += Math.min(BATCH, missing.length - i);
    }
  }

  // Time-based flags for everything still open.
  const open = await prisma.shipment.findMany({ where: { shop, closedAt: null, checkedAt: { lt: now } } });
  for (const s of open) {
    const flags = shipmentFlags(
      {
        stage: s.stage as Stage,
        shippedAt: s.shippedAt.toISOString(),
        deliveredAt: s.deliveredAt?.toISOString() ?? null,
        estimatedDeliveryAt: s.estimatedDeliveryAt?.toISOString() ?? null,
        lastEventAt: s.lastEventAt?.toISOString() ?? null,
        tracking: s.tracking as unknown as TrackingNumber[],
      },
      rules,
      now,
    );
    const tooOld = now.getTime() - s.shippedAt.getTime() > FOLLOW_DAYS * DAY;
    if (flags.join() === s.flags.join() && !tooOld) continue;
    await prisma.shipment.update({
      where: { shop_fulfillmentId: { shop, fulfillmentId: s.fulfillmentId } },
      data: {
        flags,
        ...(flags.join() !== s.flags.join() ? { flaggedAt: flags.length ? now : null } : {}),
        ...(tooOld ? { closedAt: now } : {}),
      },
    });
  }
  return { refreshed };
}

/** Packages that need a look, for Home. */
export const attentionCount = (shop: string) =>
  prisma.shipment.count({ where: { shop, closedAt: null, NOT: { flags: { isEmpty: true } } } });
