import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { parsePeriod, programResults } from "../lib/program.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { EMBED_HANDLE, embedStatus } from "../lib/embed.server";
import { parseSettings } from "../lib/settings";
import { ensureShop } from "../lib/shop.server";
import { attentionCount } from "../lib/tracking.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const days = parsePeriod(new URL(request.url).searchParams.get("days"));

  const [embed, results, recent, attention] = await Promise.all([
    embedStatus(admin),
    programResults(shop.shop, days),
    prisma.orderRecord.findMany({
      where: { shop: shop.shop, protected: true },
      orderBy: { orderedAt: "desc" },
      take: 10,
    }),
    attentionCount(shop.shop),
  ]);

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
    days,
    results,
    attention,
    claimsEnabled: configured && parseSettings(shop.settings).claims.enabled,
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
  const r = d.results;

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

      <s-section heading="Program results">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200">
            {PERIOD_LABELS.map(([n, label]) => (
              <s-button key={n} href={`/app?days=${n}`} variant={d.days === n ? "primary" : "secondary"}>
                {label}
              </s-button>
            ))}
          </s-stack>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
            <Stat label="Protection fees collected" value={money(r.fees)} hint={`${r.protectedOrders} protected orders`} />
            <Stat label="Attach rate" value={r.attachRate === null ? "—" : `${Math.round(r.attachRate * 100)}%`} hint={`of ${r.orders} orders`} />
            <Stat
              label="Claim costs"
              value={money(r.claimCost)}
              hint={r.lossRatio === null ? undefined : `${Math.round(r.lossRatio * 100)}% of fees`}
            />
            <Stat label="Net from protection" value={money(r.net)} hint="Fees minus claim costs" />
          </s-grid>
          {Object.keys(r.costBy).length > 0 && (
            <s-text color="subdued">
              Claim costs:{" "}
              {Object.entries(r.costBy)
                .map(([type, c]) => `${COST_LABELS[type] ?? type} ${money(c.amount)} (${c.count})`)
                .join(" · ")}
            </s-text>
          )}
          <s-text color="subdued">
            Not profit: payment processing fees, app charges and taxes on the fee aren&apos;t included. Replacement
            costs are what you entered when creating them.
          </s-text>
        </s-stack>
      </s-section>

      {d.attention > 0 && (
        <s-banner tone="warning" heading={`${d.attention} protected ${d.attention === 1 ? "package needs" : "packages need"} a look`}>
          Late, stalled, not picked up or missing tracking.{" "}
          <s-link href="/app/shipments">See shipments</s-link>
        </s-banner>
      )}

      <s-section heading="Claims">
        {d.claimsEnabled || r.claims.received > 0 ? (
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="base">
              <Stat label="Received" value={String(r.claims.received)} />
              <Stat label="Waiting on you or the customer" value={String(r.claims.pending)} />
              <Stat label="Approved" value={String(r.claims.approved)} />
              <Stat label="Rejected" value={String(r.claims.rejected)} />
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

const PERIOD_LABELS: [number, string][] = [
  [30, "30 days"],
  [90, "90 days"],
  [365, "12 months"],
  [0, "All time"],
];
const COST_LABELS: Record<string, string> = {
  REFUND: "Refunds",
  REPLACEMENT: "Replacements",
  STORE_CREDIT: "Store credit",
  MANUAL: "Handled outside the app",
};

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
