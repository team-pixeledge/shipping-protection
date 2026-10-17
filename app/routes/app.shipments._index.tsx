import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { formatClaimNumber, STATUS_LABELS, STATUS_TONE, type ClaimStatus } from "../lib/claims";
import { ensureShop } from "../lib/shop.server";
import { refreshOrderShipments } from "../lib/tracking.server";
import { hasFeature, isPlanId } from "../lib/plan";
import { UpgradeNotice } from "../components/Upgrade";
import {
  SHIPMENT_FLAG_LABELS,
  STAGE_LABELS,
  STAGE_TONE,
  type ShipmentFlag,
  type Stage,
  type TrackingNumber,
} from "../lib/tracking";

const PAGE = 50;
const VIEWS = {
  attention: "Needs attention",
  transit: "On the way",
  delivered: "Delivered",
  all: "All",
} as const;
type View = keyof typeof VIEWS;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopRow = await ensureShop(session.shop);
  const shop = shopRow.shop;
  const locked = !hasFeature(isPlanId(shopRow.plan) ? shopRow.plan : null, "tracking");
  const url = new URL(request.url);
  const view = (url.searchParams.get("view") as View) in VIEWS ? (url.searchParams.get("view") as View) : "attention";
  const q = (url.searchParams.get("q") ?? "").trim().replace(/^#/, "").slice(0, 40);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const base: Prisma.ShipmentWhereInput = { shop, ...(q ? { orderName: { contains: q, mode: "insensitive" } } : {}) };
  const where: Record<View, Prisma.ShipmentWhereInput> = {
    attention: { ...base, closedAt: null, NOT: { flags: { isEmpty: true } } },
    transit: { ...base, stage: { in: ["PENDING", "IN_TRANSIT", "OUT_FOR_DELIVERY", "EXCEPTION"] }, closedAt: null },
    delivered: { ...base, stage: "DELIVERED" },
    all: base,
  };
  const [rows, counts] = await Promise.all([
    prisma.shipment.findMany({
      where: where[view],
      orderBy: view === "attention" ? [{ flaggedAt: "desc" }, { shippedAt: "desc" }] : [{ shippedAt: "desc" }],
      skip: (page - 1) * PAGE,
      take: PAGE + 1,
    }),
    Promise.all((Object.keys(VIEWS) as View[]).map((v) => prisma.shipment.count({ where: where[v] }))),
  ]);
  const orderIds = [...new Set(rows.map((r) => r.orderId))];
  const [claims, packages] = await Promise.all([
    prisma.claim.findMany({
      where: { shop, orderId: { in: orderIds } },
      select: { id: true, number: true, orderId: true, status: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.shipment.groupBy({ by: ["orderId"], where: { shop, orderId: { in: orderIds } }, _count: true }),
  ]);
  const packageCount = new Map(packages.map((p) => [p.orderId, p._count]));
  return {
    locked,
    view,
    q,
    page,
    hasMore: rows.length > PAGE,
    counts: Object.fromEntries((Object.keys(VIEWS) as View[]).map((v, i) => [v, counts[i]])) as Record<View, number>,
    rows: rows.slice(0, PAGE).map((r) => ({
      key: r.fulfillmentId,
      orderId: r.orderId,
      orderName: r.orderName,
      packages: packageCount.get(r.orderId) ?? 1,
      stage: r.stage as Stage,
      tracking: r.tracking as unknown as TrackingNumber[],
      shippedAt: r.shippedAt.toISOString(),
      expected: r.estimatedDeliveryAt?.toISOString() ?? null,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
      lastUpdate: (r.lastEventAt ?? r.checkedAt).toISOString(),
      carrierUpdates: !!r.lastEventAt,
      flags: r.flags as ShipmentFlag[],
      claims: claims
        .filter((c) => c.orderId === r.orderId)
        .map((c) => ({ id: c.id, number: c.number, status: c.status as ClaimStatus })),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const orderId = String(form.get("orderId") ?? "");
  if (!/^\d+$/.test(orderId)) return { ok: false as const, error: "Unknown order." };
  const known = await prisma.shipment.findFirst({ where: { shop: session.shop, orderId } });
  if (!known) return { ok: false as const, error: "Unknown order." };
  try {
    await refreshOrderShipments(admin, session.shop, orderId);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
};

export default function Shipments() {
  const d = useLoaderData<typeof loader>();
  if (!d.locked) return <ShipmentList />;
  return (
    <s-page heading="Shipments">
      <UpgradeNotice feature="tracking">
        Follow every protected package with what the carrier last reported, and see at a glance which ones
        weren&apos;t picked up, stalled, are late or may be lost — before the customer files a claim. Claims also
        show the carrier data that supports or questions them.
      </UpgradeNotice>
    </s-page>
  );
}

function ShipmentList() {
  const d = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  useEffect(() => {
    if (fetcher.data?.ok) shopify.toast.show("Tracking refreshed");
    else if (fetcher.data && !fetcher.data.ok) shopify.toast.show(fetcher.data.error, { isError: true });
  }, [fetcher.data, shopify]);

  const link = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null ? p.delete(k) : p.set(k, v));
    const s = p.toString();
    return `/app/shipments${s ? `?${s}` : ""}`;
  };
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

  return (
    <s-page heading="Shipments">
      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Every package of an order that bought protection (or has a claim), with what the carrier last reported.
            Flags are hints worked out from tracking data and your rules in{" "}
            <s-link href="/app/settings#tracking">Settings → Tracking</s-link>. A delivery scan alone doesn&apos;t
            prove a package arrived or was lost — check with the carrier before deciding a claim.
          </s-paragraph>
          <s-stack direction="inline" gap="small-200">
            {(Object.keys(VIEWS) as View[]).map((v) => (
              <s-button key={v} href={link({ view: v, page: null })} variant={d.view === v ? "primary" : "secondary"}>
                {VIEWS[v]} ({d.counts[v]})
              </s-button>
            ))}
          </s-stack>
          <Form method="get">
            <input type="hidden" name="view" value={d.view} />
            <s-stack direction="inline" gap="small-200" alignItems="end">
              <s-search-field name="q" label="Find an order" labelAccessibilityVisibility="exclusive" placeholder="Order number, e.g. 1001" defaultValue={d.q} />
              <s-button type="submit">Search</s-button>
              {d.q && <s-button href={link({ q: null, page: null })} variant="tertiary">Clear</s-button>}
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      <s-section>
        {d.rows.length === 0 ? (
          <s-paragraph>
            {d.view === "attention"
              ? "Nothing needs attention — no protected package is late, stalled or missing tracking."
              : "No packages here yet. Packages appear once a protected order is fulfilled."}
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Tracking</s-table-header>
              <s-table-header>Shipped</s-table-header>
              <s-table-header>Expected</s-table-header>
              <s-table-header>Last carrier update</s-table-header>
              <s-table-header>Claims</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.rows.map((r) => (
                <s-table-row key={r.key}>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-100">
                      <s-link href={`shopify://admin/orders/${r.orderId}`} target="_top">
                        {r.orderName}
                      </s-link>
                      {r.packages > 1 && <s-text color="subdued">{r.packages} packages</s-text>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-100">
                      <s-badge tone={STAGE_TONE[r.stage]}>{STAGE_LABELS[r.stage]}</s-badge>
                      {r.flags.map((f) => (
                        <s-text key={f} color="subdued">
                          ⚠ {SHIPMENT_FLAG_LABELS[f] ?? f}
                        </s-text>
                      ))}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {r.tracking.length === 0
                      ? "—"
                      : r.tracking.map((t, i) =>
                          t.url ? (
                            <s-link key={i} href={t.url} target="_blank">
                              {[t.company, t.number].filter(Boolean).join(" ")}
                            </s-link>
                          ) : (
                            <s-text key={i}>{[t.company, t.number].filter(Boolean).join(" ")}</s-text>
                          ),
                        )}
                  </s-table-cell>
                  <s-table-cell>{day(r.shippedAt)}</s-table-cell>
                  <s-table-cell>{r.deliveredAt ? `Delivered ${day(r.deliveredAt)}` : day(r.expected)}</s-table-cell>
                  <s-table-cell>{r.carrierUpdates ? day(r.lastUpdate) : "None from the carrier"}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-100">
                      {r.claims.map((c) => (
                        <s-stack key={c.id} direction="inline" gap="small-100">
                          <s-link href={`/app/claims/${c.id}`}>{formatClaimNumber(c.number)}</s-link>
                          <s-badge tone={STATUS_TONE[c.status]}>{STATUS_LABELS[c.status]}</s-badge>
                        </s-stack>
                      ))}
                      <s-stack direction="inline" gap="small-100">
                        <s-button variant="tertiary" href={`/app/claims/new?order=${r.orderId}`}>
                          Create claim
                        </s-button>
                        <s-button
                          variant="tertiary"
                          {...(fetcher.state !== "idle" && fetcher.formData?.get("orderId") === r.orderId
                            ? { loading: true }
                            : {})}
                          onClick={() => fetcher.submit({ orderId: r.orderId }, { method: "POST" })}
                        >
                          Refresh
                        </s-button>
                      </s-stack>
                    </s-stack>
                  </s-table-cell>
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
        <s-text color="subdued">Tracking is checked when the carrier reports an update and once a day.</s-text>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
