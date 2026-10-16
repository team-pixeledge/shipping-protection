import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  CLAIM_STATUSES,
  formatClaimNumber,
  isClaimStatus,
  STATUS_LABELS,
  STATUS_TONE,
  TYPE_LABELS,
  type ClaimStatus,
  type ClaimType,
} from "../lib/claims";
import { ensureShop } from "../lib/shop.server";
import { parseSettings } from "../lib/settings";

const PAGE = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const url = new URL(request.url);
  const raw = url.searchParams.get("status");
  const status = isClaimStatus(raw) ? raw : null;
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const [counts, claims] = await Promise.all([
    prisma.claim.groupBy({ by: ["status"], where: { shop: shop.shop }, _count: true }),
    prisma.claim.findMany({
      where: { shop: shop.shop, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE,
      take: PAGE + 1,
    }),
  ]);
  return {
    enabled: shop.settings ? parseSettings(shop.settings).claims.enabled : false,
    portalUrl: `https://${shop.shop}${shop.portalPath}/claims`,
    status,
    page,
    hasMore: claims.length > PAGE,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) as Partial<Record<ClaimStatus, number>>,
    claims: claims.slice(0, PAGE).map((c) => ({
      id: c.id,
      number: c.number,
      orderName: c.orderName,
      type: c.type as ClaimType,
      status: c.status as ClaimStatus,
      amount: Number(c.amount),
      currency: c.currency,
      flags: c.flags.length,
      at: c.createdAt.toISOString(),
    })),
  };
};

export default function Claims() {
  const d = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const money = (n: number, c: string) => new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(n);
  const link = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null ? p.delete(k) : p.set(k, v));
    const q = p.toString();
    return `/app/claims${q ? `?${q}` : ""}`;
  };
  const total = Object.values(d.counts).reduce((s, n) => s + (n ?? 0), 0);

  return (
    <s-page heading="Claims">
      {!d.enabled && (
        <s-banner tone="info" heading="The claims page is off">
          Customers can&apos;t file claims online yet. Turn it on in{" "}
          <s-link href="/app/settings">Settings → Claims</s-link>.
        </s-banner>
      )}

      <s-section>
        <s-stack direction="inline" gap="small-200">
          <s-button href={link({ status: null, page: null })} variant={d.status ? "secondary" : "primary"}>
            All ({total})
          </s-button>
          {CLAIM_STATUSES.map((s) => (
            <s-button key={s} href={link({ status: s, page: null })} variant={d.status === s ? "primary" : "secondary"}>
              {STATUS_LABELS[s]} ({d.counts[s] ?? 0})
            </s-button>
          ))}
        </s-stack>
      </s-section>

      <s-section>
        {d.claims.length === 0 ? (
          <s-paragraph>
            {d.status ? "No claims with this status." : "No claims yet."} Customers file claims at{" "}
            <s-link href={d.portalUrl} target="_blank">
              {d.portalUrl}
            </s-link>
            .
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Claim</s-table-header>
              <s-table-header>Order</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header format="numeric">Claimed</s-table-header>
              <s-table-header>Filed</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.claims.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>
                    <s-link href={`/app/claims/${c.id}`}>{formatClaimNumber(c.number)}</s-link>
                    {c.flags > 0 && (
                      <>
                        {" "}
                        <s-badge tone="caution">{c.flags === 1 ? "1 flag" : `${c.flags} flags`}</s-badge>
                      </>
                    )}
                  </s-table-cell>
                  <s-table-cell>{c.orderName}</s-table-cell>
                  <s-table-cell>{TYPE_LABELS[c.type]}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[c.status]}>{STATUS_LABELS[c.status]}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{money(c.amount, c.currency)}</s-table-cell>
                  <s-table-cell>{new Date(c.at).toLocaleDateString()}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {(d.page > 1 || d.hasMore) && (
          <s-stack direction="inline" gap="small-200">
            {d.page > 1 && <s-button href={link({ page: String(d.page - 1) })}>Newer</s-button>}
            {d.hasMore && <s-button href={link({ page: String(d.page + 1) })}>Older</s-button>}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
