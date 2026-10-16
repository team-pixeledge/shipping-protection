// Program results: what protection brought in against what claims cost.
// Fees come from OrderRecord (the fee on each protected order); costs from
// completed ClaimResolutions (refunds as Shopify reported them, replacement
// and manual costs as the merchant entered them, store credit issued). All
// in the shop currency. Not profit: payment fees, app charges and taxes
// aren't known here, and the page says so.
import prisma from "../db.server";
import { formatClaimNumber, type ClaimItem } from "./claims";

export const PERIODS = [30, 90, 365, 0] as const; // 0 = all time
export type Period = (typeof PERIODS)[number];
export const parsePeriod = (v: string | null): Period => {
  const n = Number(v);
  return (PERIODS as readonly number[]).includes(n) ? (n as Period) : 30;
};
const sinceOf = (days: Period) => (days ? new Date(Date.now() - days * 86_400_000) : new Date(0));

export async function programResults(shop: string, days: Period) {
  const since = sinceOf(days);
  const [orders, protectedOrders, claimCounts, costs] = await Promise.all([
    prisma.orderRecord.count({ where: { shop, orderedAt: { gte: since } } }),
    prisma.orderRecord.aggregate({
      where: { shop, orderedAt: { gte: since }, protected: true },
      _count: true,
      _sum: { fee: true },
    }),
    prisma.claim.groupBy({ by: ["status"], where: { shop, createdAt: { gte: since } }, _count: true }),
    prisma.claimResolution.groupBy({
      by: ["type"],
      where: { status: "DONE", completedAt: { gte: since }, claim: { shop } },
      _count: true,
      _sum: { amount: true },
    }),
  ]);
  const fees = Number(protectedOrders._sum.fee ?? 0);
  const costBy = Object.fromEntries(costs.map((c) => [c.type, { count: c._count, amount: Number(c._sum.amount ?? 0) }]));
  const claimCost = costs.reduce((s, c) => s + Number(c._sum.amount ?? 0), 0);
  const count = (s: string) => claimCounts.find((c) => c.status === s)?._count ?? 0;
  return {
    orders,
    protectedOrders: protectedOrders._count,
    attachRate: orders ? protectedOrders._count / orders : null,
    fees,
    claimCost,
    costBy,
    net: Math.round((fees - claimCost) * 100) / 100,
    /** Claim costs as a share of fees (null with no fees). */
    lossRatio: fees > 0 ? claimCost / fees : null,
    claims: {
      received: claimCounts.reduce((s, c) => s + c._count, 0),
      pending: count("OPEN") + count("NEEDS_INFO"),
      approved: count("APPROVED"),
      rejected: count("REJECTED"),
    },
  };
}

/** Spreadsheet apps run cells starting with = + - @ as formulas. */
export const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per claim filed in the period, with how it was resolved and what it cost. */
export async function claimsCsv(shop: string, days: Period) {
  const claims = await prisma.claim.findMany({
    where: { shop, createdAt: { gte: sinceOf(days) } },
    orderBy: { createdAt: "asc" },
    include: { resolutions: { where: { status: "DONE" } } },
  });
  const header = [
    "Claim",
    "Order",
    "Filed",
    "Type",
    "Status",
    "Protected",
    "Items",
    "Claimed value",
    "Currency",
    "Resolution",
    "Resolved",
    "Cost",
    "Shopify reference",
    "Flags",
  ];
  const rows = claims.map((c) => {
    const r = c.resolutions[0];
    return [
      formatClaimNumber(c.number),
      c.orderName,
      c.createdAt.toISOString().slice(0, 10),
      c.type,
      c.status,
      c.protected ? "yes" : "no",
      (c.items as unknown as ClaimItem[]).map((i) => `${i.quantity}× ${i.title}`).join("; "),
      Number(c.amount).toFixed(2),
      c.currency,
      r?.type ?? c.resolution ?? "",
      c.resolvedAt?.toISOString().slice(0, 10) ?? "",
      r ? Number(r.amount).toFixed(2) : "",
      r?.shopifyName ?? r?.shopifyId ?? "",
      c.flags.join(" "),
    ];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
