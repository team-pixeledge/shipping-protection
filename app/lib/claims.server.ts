// Claims: reading the order from Shopify, filing, status changes and the
// emails that go with them. The rules themselves are in ./claims.ts.
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { signToken } from "./claim-token.server";
import {
  canTransition,
  formatClaimNumber,
  RESOLUTION_LABELS,
  TYPE_LABELS,
  type ClaimItem,
  type ClaimOrder,
  type ClaimStatus,
  type ClaimType,
  type Resolution,
} from "./claims";
import { claimReceivedEmail, claimUpdateEmail, merchantClaimEmail, sendEmail } from "./email.server";
import { parseSettings } from "./settings";
import type { AdminGraphql } from "./setup.server";

const numericId = (gid: string | null | undefined) => (gid ? (gid.split("/").pop() ?? null) : null);

async function gql<T>(admin: AdminGraphql, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data as T;
}

// ---- Shopify reads ----

const ORDER_FIELDS = `#graphql
  fragment SpClaimOrderFields on Order {
    id name email createdAt cancelledAt currencyCode
    customer { id }
    lineItems(first: 100) {
      nodes {
        id title variantTitle currentQuantity requiresShipping isGiftCard
        product { id productType vendor tags }
        discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
        image { url(transform: { maxWidth: 160, maxHeight: 160 }) }
      }
    }
    fulfillments(first: 20) {
      createdAt displayStatus deliveredAt status
      trackingInfo { number company url }
    }
  }`;

interface OrderNode {
  id: string;
  name: string;
  email: string | null;
  createdAt: string;
  cancelledAt: string | null;
  currencyCode: string;
  customer: { id: string } | null;
  lineItems: {
    nodes: {
      id: string;
      title: string;
      variantTitle: string | null;
      currentQuantity: number;
      requiresShipping: boolean;
      isGiftCard: boolean;
      product: { id: string; productType: string | null; vendor: string | null; tags: string[] } | null;
      discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: string } };
      image: { url: string } | null;
    }[];
  };
  fulfillments: {
    createdAt: string;
    displayStatus: string | null;
    deliveredAt: string | null;
    status: string;
    trackingInfo: { number: string | null; company: string | null; url: string | null }[];
  }[];
}

/** Pure: Shopify's order → what the claims flow needs. Cancelled/failed fulfillments aren't shipments. */
export function toClaimOrder(o: OrderNode): ClaimOrder {
  return {
    id: numericId(o.id)!,
    name: o.name,
    email: o.email,
    customerId: numericId(o.customer?.id),
    createdAt: o.createdAt,
    cancelled: !!o.cancelledAt,
    currency: o.currencyCode,
    lines: o.lineItems.nodes.map((l) => ({
      id: l.id,
      title: l.title,
      variantTitle: l.variantTitle,
      quantity: l.currentQuantity,
      unitAmount: Number(l.discountedUnitPriceAfterAllDiscountsSet.shopMoney.amount),
      image: l.image?.url ?? null,
      productId: l.product?.id ?? null,
      requiresShipping: l.requiresShipping,
      giftCard: l.isGiftCard,
      productType: l.product?.productType ?? null,
      vendor: l.product?.vendor ?? null,
      tags: l.product?.tags ?? [],
    })),
    shipments: o.fulfillments
      .filter((f) => !["CANCELLED", "ERROR", "FAILURE"].includes(f.status))
      .map((f) => ({
        status: f.displayStatus ?? f.status,
        shippedAt: f.createdAt,
        deliveredAt: f.deliveredAt,
        tracking: f.trackingInfo,
      })),
  };
}

/**
 * Orders whose name matches what the customer typed. The search is fuzzy,
 * so the caller still compares names exactly. Only the last 60 days of
 * orders are visible without the read_all_orders scope.
 */
export async function findOrdersByName(admin: AdminGraphql, typed: string): Promise<ClaimOrder[]> {
  const bare = typed.trim().replace(/^#/, "").replace(/["\\]/g, "");
  if (!bare || bare.length > 40) return [];
  const data = await gql<{ orders: { nodes: OrderNode[] } }>(
    admin,
    `${ORDER_FIELDS}
    query SpClaimOrders($q: String!) {
      orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ...SpClaimOrderFields } }
    }`,
    { q: `name:"${bare}" OR name:"#${bare}"` },
  );
  return data.orders.nodes.map(toClaimOrder);
}

export async function getOrder(admin: AdminGraphql, orderId: string): Promise<ClaimOrder | null> {
  const data = await gql<{ order: OrderNode | null }>(
    admin,
    `${ORDER_FIELDS}
    query SpClaimOrder($id: ID!) { order(id: $id) { ...SpClaimOrderFields } }`,
    { id: `gid://shopify/Order/${orderId}` },
  );
  return data.order ? toClaimOrder(data.order) : null;
}

export interface StoreProfile {
  name: string;
  email: string;
  contactEmail: string | null;
}

export async function storeProfile(admin: AdminGraphql): Promise<StoreProfile> {
  const data = await gql<{ shop: StoreProfile }>(
    admin,
    `#graphql
    query SpStoreProfile { shop { name email contactEmail } }`,
  );
  return data.shop;
}

/** Did the order buy protection? The order's own lines decide; the webhook record is the fallback. */
export async function orderIsProtected(shop: string, order: ClaimOrder) {
  const row = await prisma.shop.findUnique({ where: { shop }, select: { productId: true } });
  if (row?.productId && order.lines.some((l) => l.productId === row.productId)) return true;
  const rec = await prisma.orderRecord.findUnique({ where: { shop_orderId: { shop, orderId: order.id } } });
  return rec?.protected ?? false;
}

// ---- Links ----

/** Storefront path of a claim's status page, with its access token. */
export const claimStatusPath = (shop: string, portalPath: string, claimId: string) =>
  `${portalPath}/claims/${claimId}?t=${encodeURIComponent(signToken({ p: "claim", shop, id: claimId }))}`;

/** Absolute link for emails (the myshopify domain redirects to the primary one). */
export const claimStatusUrl = (shop: string, portalPath: string, claimId: string) =>
  `https://${shop}${claimStatusPath(shop, portalPath, claimId)}`;

export const claimAdminUrl = (shop: string, claimId: string) =>
  `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, "")}/apps/${process.env.SHOPIFY_API_KEY}/app/claims/${claimId}`;

// ---- Writes ----

async function logEmail(claimId: string, what: string, to: string, result: { ok: boolean; error?: string }) {
  await prisma.claimEvent.create({
    data: {
      claimId,
      actor: "SYSTEM",
      kind: "EMAIL",
      internal: true,
      message: result.ok ? `${what} sent to ${to}` : `${what} not sent to ${to}: ${result.error}`,
    },
  });
}

/**
 * Emails run after the claim is saved: if Shopify or the email service
 * fails, the change still stands — the failure goes in the claim's history
 * instead of reaching the customer or merchant as an error.
 */
async function afterSave(claimId: string, what: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[claims] ${what} for ${claimId}:`, msg);
    await prisma.claimEvent
      .create({ data: { claimId, actor: "SYSTEM", kind: "EMAIL", internal: true, message: `${what} failed: ${msg}` } })
      .catch(() => {});
  }
}

export interface NewClaim {
  shop: string;
  order: ClaimOrder;
  type: ClaimType;
  email: string;
  description: string;
  items: ClaimItem[];
  amount: number;
  isProtected: boolean;
  flags: string[];
  files: { pathname: string; name: string; contentType: string; size: number }[];
}

/** Creates the claim with the next per-shop number (retries if two land at once). */
export async function createClaim(c: NewClaim) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const last = await tx.claim.aggregate({ where: { shop: c.shop }, _max: { number: true } });
        const number = (last._max.number ?? 1000) + 1;
        return tx.claim.create({
          data: {
            shop: c.shop,
            number,
            orderId: c.order.id,
            orderName: c.order.name,
            type: c.type,
            email: c.email.trim().toLowerCase(),
            description: c.description,
            items: c.items as unknown as Prisma.InputJsonValue,
            amount: c.amount,
            currency: c.order.currency,
            protected: c.isProtected,
            flags: c.flags,
            shipments: c.order.shipments as unknown as Prisma.InputJsonValue,
            events: {
              create: [
                { actor: "CUSTOMER", kind: "SUBMITTED", status: "OPEN", message: c.description },
                ...(c.files.length
                  ? [{ actor: "CUSTOMER", kind: "FILES", message: c.files.map((f) => f.name).join(", ") }]
                  : []),
              ],
            },
            files: { create: c.files },
          },
        });
      });
    } catch (err) {
      const dup = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      if (!dup || attempt >= 4) throw err;
    }
  }
}

/** Emails after filing: confirmation to the customer, alert to the merchant. */
export async function notifyNewClaim(admin: AdminGraphql, claimId: string) {
  await afterSave(claimId, "New-claim emails", () => sendNewClaimEmails(admin, claimId));
}

async function sendNewClaimEmails(admin: AdminGraphql, claimId: string) {
  const claim = await prisma.claim.findUniqueOrThrow({ where: { id: claimId }, include: { shopRef: true } });
  const store = await storeProfile(admin);
  const settings = parseSettings(claim.shopRef.settings).claims;
  const ctx = {
    storeName: store.name,
    number: claim.number,
    orderName: claim.orderName,
    statusUrl: claimStatusUrl(claim.shop, claim.shopRef.portalPath, claim.id),
  };
  const toCustomer = claimReceivedEmail(ctx);
  const sentCustomer = await sendEmail({
    storeName: store.name,
    to: claim.email,
    replyTo: store.contactEmail ?? store.email,
    ...toCustomer,
    idempotencyKey: `claim-received-${claim.id}`,
  });
  await logEmail(claim.id, "Confirmation", claim.email, sentCustomer);

  const merchantTo = settings.notifyEmail || store.email;
  const summary = `${TYPE_LABELS[claim.type as ClaimType]} — ${claim.currency} ${claim.amount.toFixed(2)} claimed.\n\n${claim.description}`;
  const toMerchant = merchantClaimEmail({
    storeName: store.name,
    number: claim.number,
    orderName: claim.orderName,
    adminUrl: claimAdminUrl(claim.shop, claim.id),
    kind: "new",
    summary,
  });
  const sentMerchant = await sendEmail({
    storeName: store.name,
    to: merchantTo,
    ...toMerchant,
    idempotencyKey: `claim-new-${claim.id}`,
  });
  await logEmail(claim.id, "New-claim alert", merchantTo, sentMerchant);
}

export class ClaimConflict extends Error {}

/**
 * The merchant changes the status. Only transitions canTransition allows,
 * and only from the status the merchant was looking at (two people
 * reviewing at once can't both decide). Emails the customer.
 */
export async function changeClaimStatus(
  admin: AdminGraphql,
  opts: {
    shop: string;
    claimId: string;
    from: ClaimStatus;
    to: ClaimStatus;
    resolution?: Resolution | null;
    message?: string | null;
    note?: string | null;
  },
) {
  if (!canTransition(opts.from, opts.to)) throw new ClaimConflict(`Can't move a claim from ${opts.from} to ${opts.to}.`);
  const decided = opts.to === "APPROVED" || opts.to === "REJECTED";
  const message = opts.message?.trim() || null;
  const note = opts.note?.trim() || null;

  const claim = await prisma.$transaction(async (tx) => {
    const res = await tx.claim.updateMany({
      where: { id: opts.claimId, shop: opts.shop, status: opts.from },
      data: {
        status: opts.to,
        resolution: opts.to === "APPROVED" ? (opts.resolution ?? "OTHER") : opts.to === "OPEN" ? null : undefined,
        decidedAt: decided ? new Date() : opts.to === "OPEN" ? null : undefined,
      },
    });
    if (res.count !== 1) throw new ClaimConflict("This claim was changed by someone else. Reload and try again.");
    const resolutionText =
      opts.to === "APPROVED" ? `Resolution: ${RESOLUTION_LABELS[opts.resolution ?? "OTHER"]}` : null;
    await tx.claimEvent.create({
      data: {
        claimId: opts.claimId,
        actor: "MERCHANT",
        kind: "STATUS",
        status: opts.to,
        message: [resolutionText, message].filter(Boolean).join("\n\n") || null,
      },
    });
    if (note) {
      await tx.claimEvent.create({
        data: { claimId: opts.claimId, actor: "MERCHANT", kind: "NOTE", message: note, internal: true },
      });
    }
    return tx.claim.findUniqueOrThrow({ where: { id: opts.claimId }, include: { shopRef: true } });
  });

  await afterSave(claim.id, "Status update email", async () => {
    const store = await storeProfile(admin);
    const mail = claimUpdateEmail({
      storeName: store.name,
      number: claim.number,
      orderName: claim.orderName,
      statusUrl: claimStatusUrl(claim.shop, claim.shopRef.portalPath, claim.id),
      status: opts.to,
      resolution: (claim.resolution as Resolution | null) ?? null,
      message,
    });
    const sent = await sendEmail({ storeName: store.name, to: claim.email, replyTo: store.contactEmail ?? store.email, ...mail });
    await logEmail(claim.id, "Status update", claim.email, sent);
  });
  return claim;
}

/** A message to the customer without changing the status. */
export async function messageCustomer(admin: AdminGraphql, shop: string, claimId: string, message: string) {
  const claim = await prisma.claim.findFirstOrThrow({ where: { id: claimId, shop }, include: { shopRef: true } });
  await prisma.claimEvent.create({ data: { claimId, actor: "MERCHANT", kind: "MESSAGE", message } });
  await afterSave(claim.id, "Message email", async () => {
    const store = await storeProfile(admin);
    const mail = claimUpdateEmail({
      storeName: store.name,
      number: claim.number,
      orderName: claim.orderName,
      statusUrl: claimStatusUrl(claim.shop, claim.shopRef.portalPath, claim.id),
      status: claim.status as ClaimStatus,
      resolution: (claim.resolution as Resolution | null) ?? null,
      message,
    });
    const sent = await sendEmail({ storeName: store.name, to: claim.email, replyTo: store.contactEmail ?? store.email, ...mail });
    await logEmail(claim.id, "Message", claim.email, sent);
  });
}

/**
 * The customer replies from the status page (text and/or files). A reply
 * to NEEDS_INFO puts the claim back in review. Emails the merchant.
 */
export async function customerReply(
  admin: AdminGraphql,
  opts: {
    shop: string;
    claimId: string;
    message: string;
    files: { pathname: string; name: string; contentType: string; size: number }[];
  },
) {
  const claim = await prisma.$transaction(async (tx) => {
    const c = await tx.claim.findFirstOrThrow({ where: { id: opts.claimId, shop: opts.shop } });
    if (opts.message) {
      await tx.claimEvent.create({ data: { claimId: c.id, actor: "CUSTOMER", kind: "MESSAGE", message: opts.message } });
    }
    if (opts.files.length) {
      await tx.claimFile.createMany({ data: opts.files.map((f) => ({ ...f, claimId: c.id })) });
      await tx.claimEvent.create({
        data: { claimId: c.id, actor: "CUSTOMER", kind: "FILES", message: opts.files.map((f) => f.name).join(", ") },
      });
    }
    if (c.status === "NEEDS_INFO") {
      const moved = await tx.claim.updateMany({ where: { id: c.id, status: "NEEDS_INFO" }, data: { status: "OPEN" } });
      if (moved.count) {
        await tx.claimEvent.create({ data: { claimId: c.id, actor: "SYSTEM", kind: "STATUS", status: "OPEN" } });
      }
    }
    return tx.claim.findUniqueOrThrow({ where: { id: c.id }, include: { shopRef: true } });
  });

  await afterSave(claim.id, "Reply alert email", async () => {
    const store = await storeProfile(admin);
    const to = parseSettings(claim.shopRef.settings).claims.notifyEmail || store.email;
    const summary = [opts.message, opts.files.length ? `${opts.files.length} new file(s) attached.` : ""]
      .filter(Boolean)
      .join("\n\n");
    const mail = merchantClaimEmail({
      storeName: store.name,
      number: claim.number,
      orderName: claim.orderName,
      adminUrl: claimAdminUrl(claim.shop, claim.id),
      kind: "reply",
      summary,
    });
    const sent = await sendEmail({ storeName: store.name, to, ...mail });
    await logEmail(claim.id, "Reply alert", to, sent);
  });
  return claim;
}

export const claimTitle = (c: { number: number; orderName: string }) => `${formatClaimNumber(c.number)} · ${c.orderName}`;
