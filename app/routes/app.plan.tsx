// Plan & pricing: the one usage plan, this cycle's usage, and answers to the
// questions merchants ask before approving a charge. Open without a plan
// (app.tsx sends merchants here until they approve it).
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { activePlan, usageThisCycle } from "../lib/billing.server";
import { cycleCost, PLAN } from "../lib/plan";
import { ensureShop } from "../lib/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const plan = await activePlan(admin).catch(() => null);
  const usage = await usageThisCycle(shop.shop, plan);
  return {
    plan: plan && {
      test: plan.test,
      periodEnd: plan.currentPeriodEnd,
      cap: plan.cappedAmount,
      used: plan.balanceUsed,
    },
    test: shop.billingTest,
    usage: { ...usage, cycle: { start: usage.cycle.start.toISOString(), end: usage.cycle.end.toISOString() } },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const handle = session.shop.replace(/\.myshopify\.com$/, "");
  // Redirects to Shopify's approval page; Shopify sends the merchant back here.
  return billing.request({
    plan: PLAN.name,
    isTest: shop.billingTest,
    returnUrl: `https://admin.shopify.com/store/${handle}/apps/${process.env.SHOPIFY_API_KEY}/app`,
  });
};

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

const FAQ: { q: string; a: string }[] = [
  {
    q: "How much does SafeShip cost?",
    a: `There's no monthly fee. The first ${PLAN.freeOrders} protected orders in each 30-day billing cycle are free. After that it's ${usd(PLAN.pricePerOrder)} per protected order, and never more than ${usd(PLAN.cap)} in a cycle — orders past the cap cost nothing.`,
  },
  {
    q: "What counts as a protected order?",
    a: "An order where the customer bought shipping protection. Orders without protection, and everything else in the app — claims, tracking, emails, refunds and replacements — are never charged.",
  },
  {
    q: "Do I keep the protection fees my customers pay?",
    a: "Yes, all of them. The fee is paid to you at checkout like any product in your store. SafeShip never takes a share of it; the only charge is the per-order price above, on your Shopify bill.",
  },
  {
    q: "How will I be billed?",
    a: "Through Shopify, on your regular Shopify invoice, in US dollars (Shopify converts it if you pay in another currency). You approve the plan once; Shopify shows every charge in Settings → Billing.",
  },
  {
    q: "What if a protected order is cancelled or refunded?",
    a: `It still counts: orders are counted when they're placed, and usage charges aren't reversed. The free ${PLAN.freeOrders} orders each cycle usually cover the odd cancellation.`,
  },
  {
    q: "Can I try it before paying?",
    a: `Yes. Every cycle starts with ${PLAN.freeOrders} free protected orders, and development stores only ever get test charges, so you can set everything up and place test orders without paying.`,
  },
  {
    q: "How do I know it pays off?",
    a: `Home shows the protection fees you collected, what claims cost you and the net result. For comparison, a customer paying $2.95 for protection costs you ${usd(PLAN.pricePerOrder)} in SafeShip charges.`,
  },
  {
    q: "How do I stop paying?",
    a: "Uninstall the app — Shopify cancels the plan straight away and nothing more is charged. Before uninstalling, use Settings → Remove from store so the hidden protection product and the checkout rule are removed too.",
  },
  {
    q: "Will the price change?",
    a: "Only with your approval. If the pricing ever changes, Shopify asks you to approve the new terms; until then you keep the terms you approved.",
  },
];

export default function Plan() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const u = d.usage;
  const total = u.free + u.charged + u.capped;
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

  return (
    <s-page heading="Plan & pricing">
      {!d.plan && (
        <s-banner tone="info" heading="Approve the plan to start using SafeShip">
          You only pay for orders where customers buy protection — and the first {PLAN.freeOrders} every cycle are
          free.{d.test ? " This is a development store, so the charge will be a test charge." : ""}
        </s-banner>
      )}

      <s-section heading="SafeShip Usage">
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
            <Box label="Monthly fee" value="None" />
            <Box label="Free each cycle" value={`${PLAN.freeOrders} protected orders`} />
            <Box label="Then" value={`${usd(PLAN.pricePerOrder)} per protected order`} />
            <Box label="Never more than" value={`${usd(PLAN.cap)} per 30 days`} />
          </s-grid>
          <s-unordered-list>
            <s-list-item>Every feature included: protection widget, checkout rule, claims page, tracking and reports.</s-list-item>
            <s-list-item>You keep 100% of the protection fees your customers pay.</s-list-item>
            <s-list-item>Unlimited claims, emails, refunds and replacements at no extra cost.</s-list-item>
          </s-unordered-list>
          {d.plan ? (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-badge tone="success">Active{d.plan.test ? " (test)" : ""}</s-badge>
              <s-text color="subdued">Current cycle ends {day(d.plan.periodEnd)}</s-text>
            </s-stack>
          ) : (
            <s-stack direction="inline" gap="small-200">
              <s-button
                variant="primary"
                {...(busy ? { loading: true } : {})}
                onClick={() => fetcher.submit({}, { method: "POST" })}
              >
                Approve plan
              </s-button>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {d.plan && (
        <s-section heading="This billing cycle">
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
              <Box label="Protected orders" value={String(total)} hint={`${day(u.cycle.start)} – ${day(u.cycle.end)}`} />
              <Box label="Free orders used" value={`${Math.min(u.free, PLAN.freeOrders)} of ${PLAN.freeOrders}`} />
              <Box label="Charged so far" value={usd(u.amount)} hint={`${u.charged} orders`} />
              <Box label="Cap" value={usd(d.plan.cap)} hint={`${usd(Math.max(0, d.plan.cap - d.plan.used))} left`} />
            </s-grid>
            {u.failed > 0 && (
              <s-text color="subdued">
                {u.failed} order{u.failed === 1 ? "" : "s"} couldn&apos;t be billed because Shopify was unavailable —
                you weren&apos;t charged for {u.failed === 1 ? "it" : "them"}.
              </s-text>
            )}
          </s-stack>
        </s-section>
      )}

      <s-section heading="What would I pay?">
        <s-table>
          <s-table-header-row>
            <s-table-header>Protected orders in 30 days</s-table-header>
            <s-table-header>SafeShip cost</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {[25, 100, 500, 2000, 10000].map((n) => (
              <s-table-row key={n}>
                <s-table-cell>{n.toLocaleString()}</s-table-cell>
                <s-table-cell>{cycleCost(n) === 0 ? "Free" : usd(cycleCost(n))}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section heading="Frequently asked questions">
        <s-stack direction="block" gap="base">
          {FAQ.map((f) => (
            <details key={f.q}>
              <summary style={{ cursor: "pointer", fontWeight: 600, padding: "4px 0" }}>{f.q}</summary>
              <s-paragraph>{f.a}</s-paragraph>
            </details>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

function Box({ label, value, hint }: { label: string; value: string; hint?: string }) {
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

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
