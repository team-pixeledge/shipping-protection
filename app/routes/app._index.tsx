import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { EMBED_HANDLE, embedStatus } from "../lib/embed.server";
import { parseSettings } from "../lib/settings";
import { ensureShop } from "../lib/shop.server";

const DAYS = 30;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const since = new Date(Date.now() - DAYS * 86_400_000);

  const [embed, totals, protectedTotals, recent, claimCounts] = await Promise.all([
    embedStatus(admin),
    prisma.orderRecord.count({ where: { shop: shop.shop, orderedAt: { gte: since } } }),
    prisma.orderRecord.aggregate({
      where: { shop: shop.shop, orderedAt: { gte: since }, protected: true },
      _count: true,
      _sum: { fee: true },
    }),
    prisma.orderRecord.findMany({
      where: { shop: shop.shop, protected: true },
      orderBy: { orderedAt: "desc" },
      take: 10,
    }),
    prisma.claim.groupBy({
      by: ["status"],
      where: { shop: shop.shop, createdAt: { gte: since } },
      _count: true,
      _sum: { amount: true },
    }),
  ]);
  const claimsBy = (s: string) => claimCounts.find((c) => c.status === s);

  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const configured = shop.settings !== null && shop.syncedVersion > 0;
  return {
    configured,
    enabled: configured && parseSettings(shop.settings).enabled,
    syncError: shop.syncError,
    pendingSync: shop.version !== shop.syncedVersion,
    currency: shop.currency,
    productId: shop.productId?.split("/").pop() ?? null,
    embed,
    embedUrl: `shopify://admin/themes/current/editor?context=apps&activateAppId=${apiKey}/${EMBED_HANDLE}`,
    blockUrl: `shopify://admin/themes/current/editor?template=cart&addAppBlockId=${apiKey}/cart-protection&target=newAppsSection`,
    stats: {
      orders: totals,
      protected: protectedTotals._count,
      revenue: Number(protectedTotals._sum.fee ?? 0),
    },
    claims: {
      enabled: configured && parseSettings(shop.settings).claims.enabled,
      received: claimCounts.reduce((s, c) => s + c._count, 0),
      pending: (claimsBy("OPEN")?._count ?? 0) + (claimsBy("NEEDS_INFO")?._count ?? 0),
      approved: claimsBy("APPROVED")?._count ?? 0,
      rejected: claimsBy("REJECTED")?._count ?? 0,
      approvedValue: Number(claimsBy("APPROVED")?._sum.amount ?? 0),
    },
    recent: recent.map((r) => ({
      id: r.orderId,
      name: r.orderName,
      fee: Number(r.fee),
      currency: r.currency,
      at: r.orderedAt.toISOString(),
    })),
  };
};

export default function Home() {
  const d = useLoaderData<typeof loader>();
  const money = (n: number, currency = d.currency) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);
  const rate = d.stats.orders ? Math.round((d.stats.protected / d.stats.orders) * 100) : 0;

  const steps: { done: boolean; title: string; body: React.ReactNode }[] = [
    {
      done: d.configured,
      title: "Set your pricing",
      body: (
        <>
          Choose a fixed fee, a percentage of the cart or price tiers, and save.{" "}
          <s-link href="/app/settings">Open Settings</s-link>
        </>
      ),
    },
    {
      done: d.embed.status === "on",
      title: "Turn on the app embed in your theme",
      body: (
        <>
          Shows the protection toggle above the checkout button in your cart drawer and cart page.{" "}
          <s-link href={d.embedUrl} target="_top">
            Open the theme editor
          </s-link>
          {d.embed.status === "unknown" && " (we couldn't check your theme — make sure it's on)"}
        </>
      ),
    },
    {
      done: false,
      title: "Optional: place the cart block yourself",
      body: (
        <>
          If the automatic placement doesn&apos;t suit your theme, add the &ldquo;Shipping protection&rdquo;
          block to your cart page and set the embed&apos;s placement to &ldquo;Only where I add the app
          block&rdquo;.{" "}
          <s-link href={d.blockUrl} target="_top">
            Add the cart block
          </s-link>
        </>
      ),
    },
  ];

  return (
    <s-page heading="Shipping Protection">
      {d.syncError && (
        <s-banner tone="critical" heading="Your last change didn't reach your store">
          {d.syncError} — open <s-link href="/app/settings">Settings</s-link> and save again.
        </s-banner>
      )}
      {d.configured && !d.enabled && (
        <s-banner tone="warning" heading="Protection is switched off">
          Customers don&apos;t see it, and it&apos;s removed from carts that still have it.{" "}
          <s-link href="/app/settings">Turn it on</s-link>
        </s-banner>
      )}

      <s-section heading="Get started">
        <s-stack direction="block" gap="base">
          {steps.map((s) => (
            <s-stack key={s.title} direction="inline" gap="base" alignItems="start">
              <s-badge tone={s.done ? "success" : "neutral"}>{s.done ? "Done" : "To do"}</s-badge>
              <s-stack direction="block" gap="small-200">
                <s-text type="strong">{s.title}</s-text>
                <s-text color="subdued">{s.body}</s-text>
              </s-stack>
            </s-stack>
          ))}
        </s-stack>
      </s-section>

      <s-section heading={`Last ${DAYS} days`}>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <Stat label="Protected orders" value={String(d.stats.protected)} />
          <Stat label="Attach rate" value={d.stats.orders ? `${rate}%` : "—"} hint={`of ${d.stats.orders} orders`} />
          <Stat label="Protection revenue" value={money(d.stats.revenue)} />
        </s-grid>
      </s-section>

      <s-section heading={`Claims, last ${DAYS} days`}>
        {d.claims.enabled || d.claims.received > 0 ? (
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="base">
              <Stat label="Received" value={String(d.claims.received)} />
              <Stat label="Waiting on you or the customer" value={String(d.claims.pending)} />
              <Stat label="Approved" value={String(d.claims.approved)} hint={`${money(d.claims.approvedValue)} claimed`} />
              <Stat label="Rejected" value={String(d.claims.rejected)} />
            </s-grid>
            <s-link href="/app/claims">Review claims</s-link>
          </s-stack>
        ) : (
          <s-paragraph>
            Let customers report lost, stolen or damaged packages on your store, and review them here.{" "}
            <s-link href="/app/settings">Turn on the claims page</s-link>
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Recent protected orders">
        {d.recent.length === 0 ? (
          <s-paragraph>
            No protected orders yet. Protected orders are tagged &ldquo;Shipping protection&rdquo; in your
            Orders list, and each order shows the fee under Metafields.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Date</s-table-header>
              <s-table-header>Protection</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.recent.map((o) => (
                <s-table-row key={o.id}>
                  <s-table-cell>
                    <s-link href={`shopify://admin/orders/${o.id}`} target="_top">
                      {o.name}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>{new Date(o.at).toLocaleDateString()}</s-table-cell>
                  <s-table-cell>{money(o.fee, o.currency)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {d.productId && (
        <s-section heading="Good to know">
          <s-unordered-list>
            <s-list-item>
              The fee is charged through a hidden product,{" "}
              <s-link href={`shopify://admin/products/${d.productId}`} target="_top">
                Shipping protection
              </s-link>
              . It&apos;s unlisted (not in search or collections) and managed by this app — please don&apos;t
              edit its variants.
            </s-list-item>
            <s-list-item>
              A checkout rule stops orders with the protection added twice, on its own, or at the wrong price.
            </s-list-item>
            <s-list-item>
              Discount codes for &ldquo;entire order&rdquo; also discount the protection fee unless you exclude
              the Shipping protection product in the discount.
            </s-list-item>
            <s-list-item>
              Express buttons on product pages (Buy it now, Shop Pay, Apple Pay) skip the cart, so those orders
              don&apos;t include protection.
            </s-list-item>
          </s-unordered-list>
        </s-section>
      )}
    </s-page>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {hint && <s-text color="subdued">{hint}</s-text>}
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
