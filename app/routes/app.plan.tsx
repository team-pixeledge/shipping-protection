// Plan & pricing: the current plan and this cycle's usage, the three plans
// side by side, a full feature comparison, what each plan costs at
// different volumes, and the FAQ. Open without a plan (app.tsx sends
// merchants here until they approve one). Layout follows weather-slip's
// Plans page. Everything shown comes from app/lib/plan.ts.
import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { syncPlan, usageThisCycle } from "../lib/billing.server";
import {
  CARD_FEATURES,
  COMPARISON,
  cycleCost,
  hasFeature,
  isPlanId,
  PLAN_ORDER,
  planHasRow,
  PLANS,
  type PlanId,
} from "../lib/plan";
import { ensureShop } from "../lib/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const active = await syncPlan(admin, session.shop).catch(() => null);
  const usage = await usageThisCycle(shop.shop, active);
  return {
    current: active?.plan ?? null,
    subscription: active && {
      test: active.test,
      periodEnd: active.currentPeriodEnd,
      cap: active.cappedAmount,
      used: active.balanceUsed,
    },
    test: shop.billingTest,
    usage: {
      ...usage,
      cycle: {
        start: usage.cycle.start.toISOString(),
        end: usage.cycle.end.toISOString(),
      },
    },
  };
};

type ActionResult = { ok: false; error: string };

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult | Response> => {
  const { billing, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const target = form.get("plan");
  if (!isPlanId(target)) return { ok: false, error: "Unknown plan." };
  const handle = session.shop.replace(/\.myshopify\.com$/, "");
  // Redirects to Shopify's approval page; Shopify sends the merchant back
  // here. The current plan stays until the new one is approved, and the new
  // one replaces it straight away (no double billing).
  return billing.request({
    plan: PLANS[target].billingName,
    isTest: shop.billingTest,
    returnUrl: `https://admin.shopify.com/store/${handle}/apps/${process.env.SHOPIFY_API_KEY}/app/plan?changed=${target}`,
  });
};

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: n < 1 ? 2 : 0,
  }).format(n);
const usd2 = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n,
  );
const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";

// s-button `inlineSize` isn't in the React typings.
const untyped = (props: Record<string, string>) => props as object;
const FILL = untyped({ inlineSize: "fill" });

const CARD = {
  background: "#fff",
  borderRadius: 12,
  border: "1px solid #e3e3e3",
  boxShadow: "0 1px 3px rgba(0,0,0,.08)",
  padding: 16,
} as const;

const VOLUMES = [50, 200, 500, 1000, 2500, 5000, 10000];

const FAQ: [string, string][] = [
  [
    "How does pricing work?",
    `There's no monthly fee on any plan. Each 30-day billing cycle starts with ${PLANS.GROWTH.freeOrders} free protected orders; after that you pay a small amount per protected order — ${PLAN_ORDER.map((id) => `${usd2(PLANS[id].pricePerOrder)} on ${PLANS[id].name}`).join(", ")} — and never more than the plan's monthly cap (${PLAN_ORDER.map((id) => `${usd(PLANS[id].cap)}`).join(" / ")}). Orders past the cap cost nothing.`,
  ],
  [
    "What counts as a protected order?",
    "An order where the customer bought shipping protection. Orders without protection never count, and nothing else is charged: claims, tracking, emails, refunds and replacements are all included.",
  ],
  [
    "Which plan should I choose?",
    "Starter has everything to offer protection and handle claims. Growth adds shipment tracking with late and lost-package flags, risk signals and limits for claims, staff-created claims and a claims page in 7 languages — it suits most stores shipping every day. Pro adds prices per market, and on Shopify Plus stores the exact percentage fee and a toggle inside checkout.",
  ],
  [
    "Do I keep the protection fees my customers pay?",
    "Yes, all of them. The fee is paid to you at checkout like any product in your store. SafeShip never takes a share of it; the only charge is the per-order price, on your Shopify bill.",
  ],
  [
    "How do upgrading and downgrading work?",
    "Choose a plan and approve it on Shopify's screen. The new plan replaces the old one straight away — you're never billed twice for the same cycle — and if you don't approve, nothing changes. Settings for features a lower plan doesn't include are kept, so they come back if you upgrade again.",
  ],
  [
    "What happens to my settings if I downgrade?",
    "Features your new plan doesn't include switch off: for example market prices fall back to your normal pricing, and the Shipments page and risk signals are hidden. Your settings stay saved, and existing claims keep their history.",
  ],
  [
    "How will I be billed?",
    "Through Shopify, on your regular Shopify invoice, in US dollars (Shopify converts it if you pay in another currency). Shopify lists every charge under Settings → Billing.",
  ],
  [
    "What if a protected order is cancelled or refunded?",
    `It still counts: orders are counted when they're placed, and usage charges aren't reversed. The ${PLANS.GROWTH.freeOrders} free orders each cycle usually cover the odd cancellation.`,
  ],
  [
    "Can I try it before paying?",
    `Yes. Every cycle starts with ${PLANS.GROWTH.freeOrders} free protected orders on every plan, and development stores only ever get test charges, so you can set everything up and place test orders without paying.`,
  ],
  [
    "How do I know it pays off?",
    "Home shows the protection fees you collected, what claims cost you and the net result for 30 days, 90 days, 12 months or all time.",
  ],
  [
    "How do I stop paying?",
    "Uninstall the app — Shopify cancels the plan straight away and nothing more is charged. Before uninstalling, use Settings → Remove from store so the hidden protection product and the checkout rule are removed too.",
  ],
  [
    "Will prices change?",
    "Only with your approval. If pricing ever changes, Shopify asks you to approve the new terms; until then you keep the terms you approved.",
  ],
];

export default function Plan() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();
  const shopify = useAppBridge();
  const [params] = useSearchParams();
  const pending =
    fetcher.state !== "idle" ? String(fetcher.formData?.get("plan")) : null;
  const changed = params.get("changed");
  const rank = (id: PlanId | null) => (id ? PLAN_ORDER.indexOf(id) : -1);
  const current = d.current ? PLANS[d.current] : null;
  const u = d.usage;
  const protectedOrders = u.free + u.charged + u.capped;
  const capPct = d.subscription
    ? Math.min(
        100,
        Math.round((d.subscription.used / d.subscription.cap) * 100),
      )
    : 0;

  useEffect(() => {
    if (changed && d.current === changed)
      shopify.toast.show(`You're on the ${PLANS[d.current].name} plan`);
  }, [changed, d.current, shopify]);

  const choose = (plan: PlanId) => fetcher.submit({ plan }, { method: "POST" });

  return (
    <s-page heading="Plan & pricing">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          paddingBottom: 32,
        }}
      >
        <div style={{ margin: "4px 0" }}>
          <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.3 }}>
            Plans
          </div>
          <s-text color="subdued">
            No monthly fee on any plan. The first {PLANS.GROWTH.freeOrders}{" "}
            protected orders every 30 days are free, then you pay a little per
            protected order, up to a monthly cap. Change plans any time.
          </s-text>
        </div>

        {fetcher.data && !fetcher.data.ok && (
          <s-banner tone="critical" heading="Something went wrong">
            {fetcher.data.error}
          </s-banner>
        )}
        {changed && d.current !== changed && (
          <s-banner tone="warning" heading="Plan not changed">
            The new plan wasn&apos;t approved, so nothing changed and nothing
            was billed. Choose a plan below to try again.
          </s-banner>
        )}

        {/* ---- current plan + usage ---- */}
        {current && d.subscription ? (
          <s-section>
            <s-stack direction="block" gap="small-300">
              <s-stack
                direction="inline"
                gap="small-200"
                alignItems="center"
                justifyContent="space-between"
              >
                <s-heading>Current plan: {current.name}</s-heading>
                <s-stack direction="inline" gap="small-200">
                  <s-badge tone="success">Active</s-badge>
                  {d.subscription.test && (
                    <s-badge tone="info">Test charge</s-badge>
                  )}
                </s-stack>
              </s-stack>
              <s-text color="subdued">
                {protectedOrders.toLocaleString()} protected orders this cycle ·{" "}
                {Math.min(u.free, current.freeOrders)} of {current.freeOrders}{" "}
                free · {usd2(u.amount)} charged so far · cycle ends{" "}
                {day(d.subscription.periodEnd)}
              </s-text>
              <div
                role="progressbar"
                aria-label="Charges this cycle against the monthly cap"
                aria-valuenow={capPct}
                aria-valuemin={0}
                aria-valuemax={100}
                style={{
                  height: 8,
                  borderRadius: 4,
                  background: "#e3e3e3",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${capPct}%`,
                    height: "100%",
                    background: capPct >= 100 ? "#29845a" : "#1f6fdb",
                  }}
                />
              </div>
              <s-text color="subdued">
                {capPct >= 100
                  ? `You've reached the ${usd(d.subscription.cap)} cap — the rest of this cycle is free.`
                  : `${usd2(d.subscription.used)} of the ${usd(d.subscription.cap)} monthly cap · billed on your Shopify invoice`}
              </s-text>
              {u.failed > 0 && (
                <s-text color="subdued">
                  {u.failed} order{u.failed === 1 ? "" : "s"} couldn&apos;t be
                  billed because Shopify was unavailable — you weren&apos;t
                  charged for {u.failed === 1 ? "it" : "them"}.
                </s-text>
              )}
              {d.test && (
                <s-text color="subdued">
                  Test mode: plan changes go through Shopify&apos;s approval
                  screen, but no money is charged.
                </s-text>
              )}
            </s-stack>
          </s-section>
        ) : (
          <s-banner tone="info" heading="Choose a plan to start using SafeShip">
            Every plan starts with {PLANS.GROWTH.freeOrders} free protected
            orders each cycle, and there&apos;s no monthly fee.
            {d.test
              ? " This is a development store, so the charge will be a test charge."
              : ""}
          </s-banner>
        )}

        {/* ---- plan cards ---- */}
        <span
          id="all-plans"
          style={{ fontSize: 15, fontWeight: 650, marginBottom: -4 }}
        >
          All plans
        </span>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 16,
            alignItems: "stretch",
          }}
        >
          {PLAN_ORDER.map((id) => {
            const p = PLANS[id];
            const isCurrent = id === d.current;
            const up = rank(id) > rank(d.current);
            const label = isCurrent
              ? "Current plan"
              : !d.current
                ? `Choose ${p.name}`
                : up
                  ? `Upgrade to ${p.name}`
                  : `Switch to ${p.name}`;
            return (
              <div
                key={id}
                style={{
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  padding: 16,
                  borderRadius: 12,
                  background: "#fff",
                  boxShadow: isCurrent
                    ? "0 4px 14px rgba(0,0,0,.10)"
                    : "0 1px 3px rgba(0,0,0,.08)",
                  border: isCurrent
                    ? "2px solid #29845a"
                    : p.highlight
                      ? "2px solid #1f6fdb"
                      : "1px solid #e3e3e3",
                }}
              >
                <s-stack
                  direction="inline"
                  gap="small-200"
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <span style={{ fontSize: 20, fontWeight: 700 }}>
                    {p.name}
                  </span>
                  {isCurrent ? (
                    <s-badge tone="success">Current plan</s-badge>
                  ) : p.highlight ? (
                    <s-badge tone="info">{p.highlight}</s-badge>
                  ) : null}
                </s-stack>
                <div>
                  <span style={{ fontSize: 30, fontWeight: 700 }}>
                    {usd2(p.pricePerOrder)}
                  </span>
                  <s-text color="subdued"> / protected order</s-text>
                  <div>
                    <s-text color="subdued">
                      First {p.freeOrders} every 30 days free · never more than{" "}
                      {usd(p.cap)}/month · no monthly fee
                    </s-text>
                  </div>
                </div>
                <s-text color="subdued">{p.tagline}</s-text>
                <div style={{ borderTop: "1px solid #ebebeb" }} />
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 5 }}
                >
                  {CARD_FEATURES.map((f) => {
                    const included = f.on === "all" || hasFeature(id, f.on);
                    return (
                      <div
                        key={f.text}
                        style={{
                          display: "flex",
                          gap: 6,
                          alignItems: "flex-start",
                          fontSize: 12.5,
                          lineHeight: 1.35,
                          opacity: included ? 1 : 0.45,
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            color: included ? "#29845a" : "#8a8a8a",
                            fontWeight: 700,
                            width: 12,
                            flex: "none",
                          }}
                        >
                          {included ? "✓" : "✕"}
                        </span>
                        <span>
                          {f.text}
                          {!included && <SrOnly> (not included)</SrOnly>}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div style={{ flex: 1 }} />
                <s-button
                  {...FILL}
                  variant={isCurrent ? "secondary" : "primary"}
                  disabled={isCurrent || (pending !== null && pending !== id)}
                  {...(pending === id ? { loading: true } : {})}
                  onClick={() => choose(id)}
                >
                  {label}
                </s-button>
              </div>
            );
          })}
        </div>

        {/* ---- full comparison ---- */}
        <div style={CARD}>
          <div style={{ fontSize: 15, fontWeight: 650, marginBottom: 8 }}>
            Compare every feature
          </div>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr>
                  <th style={{ ...TH, textAlign: "left" }}>Feature</th>
                  {PLAN_ORDER.map((id) => (
                    <th
                      key={id}
                      style={{
                        ...TH,
                        background: id === d.current ? "#f1f8f5" : undefined,
                      }}
                    >
                      {PLANS[id].name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={TD}>Price per protected order</td>
                  {PLAN_ORDER.map((id) => (
                    <td key={id} style={{ ...TD, ...CENTER }}>
                      {usd2(PLANS[id].pricePerOrder)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td style={TD}>Free protected orders every 30 days</td>
                  {PLAN_ORDER.map((id) => (
                    <td key={id} style={{ ...TD, ...CENTER }}>
                      {PLANS[id].freeOrders}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td style={TD}>Monthly cap</td>
                  {PLAN_ORDER.map((id) => (
                    <td key={id} style={{ ...TD, ...CENTER }}>
                      {usd(PLANS[id].cap)}
                    </td>
                  ))}
                </tr>
                {COMPARISON.map((g) => (
                  <Group key={g.group} title={g.group}>
                    {g.rows.map((r) => (
                      <tr key={r.label}>
                        <td style={TD}>
                          {r.label}
                          {r.hint && (
                            <span style={{ color: "#6b6b6b" }}>
                              {" "}
                              · {r.hint}
                            </span>
                          )}
                        </td>
                        {PLAN_ORDER.map((id) => (
                          <td key={id} style={{ ...TD, ...CENTER }}>
                            {planHasRow(id, r) ? (
                              <span
                                style={{ color: "#29845a", fontWeight: 700 }}
                              >
                                ✓<SrOnly>Included</SrOnly>
                              </span>
                            ) : (
                              <span style={{ color: "#b5b5b5" }}>
                                —<SrOnly>Not included</SrOnly>
                              </span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Group>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ---- cost by volume ---- */}
        <div style={CARD}>
          <div style={{ fontSize: 15, fontWeight: 650, marginBottom: 4 }}>
            What would I pay?
          </div>
          <s-text color="subdued">
            SafeShip&apos;s charge for 30 days, by protected orders in that
            time.
          </s-text>
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr>
                  <th style={{ ...TH, textAlign: "left" }}>Protected orders</th>
                  {PLAN_ORDER.map((id) => (
                    <th key={id} style={TH}>
                      {PLANS[id].name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {VOLUMES.map((n) => (
                  <tr key={n}>
                    <td style={TD}>{n.toLocaleString()}</td>
                    {PLAN_ORDER.map((id) => {
                      const c = cycleCost(PLANS[id], n);
                      return (
                        <td key={id} style={{ ...TD, ...CENTER }}>
                          {c === 0 ? "Free" : usd2(c)}
                          {c >= PLANS[id].cap && (
                            <span style={{ color: "#6b6b6b" }}> (cap)</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8 }}>
            <s-text color="subdued">
              For comparison: a customer paying $2.95 for protection on{" "}
              {PLANS.GROWTH.name} costs you {usd2(PLANS.GROWTH.pricePerOrder)} —
              you keep the rest of the fee.
            </s-text>
          </div>
        </div>

        {/* ---- FAQ ---- */}
        <div
          style={{ ...CARD, width: "100%", maxWidth: 820, margin: "0 auto" }}
        >
          <div
            style={{
              fontSize: 15,
              fontWeight: 650,
              marginBottom: 8,
              textAlign: "center",
            }}
          >
            FAQ
          </div>
          {FAQ.map(([q, a]) => (
            <details
              key={q}
              style={{ borderTop: "1px solid #ebebeb", padding: "10px 0" }}
            >
              <summary
                style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}
              >
                {q}
              </summary>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 13,
                  color: "#4a4a4a",
                  lineHeight: 1.5,
                }}
              >
                {a}
              </div>
            </details>
          ))}
        </div>
      </div>
    </s-page>
  );
}

const TH = {
  padding: "8px 10px",
  borderBottom: "2px solid #e3e3e3",
  fontWeight: 650,
  textAlign: "center" as const,
  whiteSpace: "nowrap" as const,
};
const TD = {
  padding: "7px 10px",
  borderBottom: "1px solid #f0f0f0",
  verticalAlign: "top" as const,
};
const CENTER = { textAlign: "center" as const, whiteSpace: "nowrap" as const };

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={PLAN_ORDER.length + 1}
          style={{
            padding: "14px 10px 6px",
            fontWeight: 650,
            fontSize: 13,
            borderBottom: "1px solid #e3e3e3",
          }}
        >
          {title}
        </td>
      </tr>
      {children}
    </>
  );
}

/** Visible to screen readers only (the ✓/✕ marks are visual). */
function SrOnly({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
