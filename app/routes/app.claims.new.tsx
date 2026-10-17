// Staff create a claim for a customer: a customer who phoned or emailed, or
// an order whose package the carrier never scanned. The same review flags
// as the claims page; the online rules (window, limits, protection bought)
// are shown, and overriding them needs an internal note.
import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, redirect, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  buildClaimItems,
  CLAIM_TYPES,
  claimableLines,
  isClaimType,
  isEmail,
  limitProblem,
  normalizeOrderName,
  orderEligibility,
  typeProblem,
  TYPE_LABELS,
  type ClaimOrder,
  type ClaimType,
} from "../lib/claims";
import {
  assessClaim,
  createClaim,
  findOrdersByName,
  getOrder,
  notifyNewClaim,
  orderIsProtected,
} from "../lib/claims.server";
import { parseSettings } from "../lib/settings";
import { ensureShop } from "../lib/shop.server";
import { refusalText } from "../lib/i18n";
import { storeShipments, type FulfillmentNode } from "../lib/tracking.server";

async function policyProblems(
  shop: string,
  order: ClaimOrder,
  settings: ReturnType<typeof parseSettings>,
  now: Date,
) {
  const isProtected = await orderIsProtected(shop, order);
  const prior = await prisma.claim.findMany({
    where: { shop, orderId: order.id },
    select: { id: true, status: true },
  });
  const ok = orderEligibility(order, {
    settings: settings.claims,
    isProtected,
    prior,
    now,
  });
  return {
    isProtected,
    prior,
    problem: ok.ok ? null : ok.reason,
    openClaimId: ok.ok ? null : (ok.openClaimId ?? null),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopRow = await ensureShop(session.shop);
  const settings = parseSettings(shopRow.settings);
  const url = new URL(request.url);
  const orderId = url.searchParams.get("order");
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 40);

  let error: string | null = null;
  let order: ClaimOrder | null = null;
  try {
    if (orderId && /^\d+$/.test(orderId))
      order = await getOrder(admin, orderId);
    else if (q) {
      const found = await findOrdersByName(admin, q);
      order =
        found.find(
          (o) => normalizeOrderName(o.name) === normalizeOrderName(q),
        ) ?? null;
      if (!order) error = `No order ${q} found in the last 60 days.`;
    }
  } catch (err) {
    error = `Couldn't load the order: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!order) return { order: null, q, error, currency: shopRow.currency };

  const policy = await policyProblems(
    session.shop,
    order,
    settings,
    new Date(),
  );
  return {
    q,
    error,
    currency: order.currency,
    order: {
      id: order.id,
      name: order.name,
      email: order.email ?? "",
      cancelled: order.cancelled,
      lines: claimableLines(order, shopRow.productId, settings.coverage).map(
        (l) => ({
          id: l.id,
          title: l.variantTitle ? `${l.title} — ${l.variantTitle}` : l.title,
          quantity: l.quantity,
          unitAmount: l.unitAmount,
        }),
      ),
      packages: order.shipments.length,
    },
    isProtected: policy.isProtected,
    problem: policy.problem,
    openClaimId: policy.openClaimId,
  };
};

type ActionResult = { ok: false; error: string };

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult | Response> => {
  const { session, admin } = await authenticate.admin(request);
  const shopRow = await ensureShop(session.shop);
  const settings = parseSettings(shopRow.settings);
  const body = (await request.json()) as Record<string, unknown>;
  const text = (v: unknown, max = 3000) =>
    typeof v === "string" ? v.trim().slice(0, max) : "";
  const orderId = text(body.orderId, 30);
  if (!/^\d+$/.test(orderId))
    return { ok: false, error: "Find the order first." };
  const order = await getOrder(admin, orderId);
  if (!order)
    return { ok: false, error: "That order can't be loaded any more." };

  const type = body.type;
  if (!isClaimType(type)) return { ok: false, error: "Choose what happened." };
  const email = text(body.email, 254).toLowerCase();
  if (!isEmail(email))
    return {
      ok: false,
      error: "Enter the customer's email — claim updates go there.",
    };
  const description = text(body.description);
  if (description.length < 3)
    return { ok: false, error: "Describe what happened." };
  const picked = (
    body.picked && typeof body.picked === "object" ? body.picked : {}
  ) as Record<string, number>;
  const { items, amount } = buildClaimItems(
    claimableLines(order, shopRow.productId, settings.coverage),
    picked,
  );
  if (!items.length) return { ok: false, error: "Choose at least one item." };

  const now = new Date();
  const policy = await policyProblems(session.shop, order, settings, now);
  if (policy.openClaimId)
    return { ok: false, error: "This order already has an open claim." };
  const year = new Date(now.getTime() - 365 * 86_400_000);
  const [onOrder, byCustomer] = await Promise.all([
    prisma.claim.aggregate({
      where: { shop: session.shop, orderId, status: { not: "REJECTED" } },
      _sum: { amount: true },
    }),
    prisma.claim.aggregate({
      where: {
        shop: session.shop,
        email,
        status: { not: "REJECTED" },
        createdAt: { gte: year },
      },
      _sum: { amount: true },
    }),
  ]);
  const outside = [
    policy.problem,
    ...[
      typeProblem(order, type, settings.claims, now),
      limitProblem(amount, Number(onOrder._sum.amount ?? 0), Number(byCustomer._sum.amount ?? 0), settings.claims),
    ].map((r) => (r ? refusalText(r) : null)),
  ].filter(Boolean) as string[];
  const override = text(body.override, 1000);
  if (outside.length && !override) {
    return {
      ok: false,
      error:
        "This claim is outside your online claim rules. Add a note saying why you're creating it.",
    };
  }

  const risk = await assessClaim(admin, {
    shop: session.shop,
    order,
    type,
    email,
    isProtected: policy.isProtected,
    items,
    amount,
    settings: settings.claims,
    tracking: settings.tracking,
    now,
  });
  const claim = await createClaim({
    shop: session.shop,
    order,
    type,
    email,
    description,
    items,
    amount,
    isProtected: policy.isProtected,
    flags: outside.length ? [...risk.flags, "OUTSIDE_POLICY"] : risk.flags,
    files: [],
    trackingNumbers: risk.trackingNumbers,
    addressHash: risk.addressHash,
    source: "STAFF",
    staffNote:
      [
        outside.length ? `Outside the online rules: ${outside.join(" ")}` : "",
        override,
      ]
        .filter(Boolean)
        .join("\n\n") || null,
  });
  await storeShipments(
    session.shop,
    order,
    (order.fulfillments ?? []) as FulfillmentNode[],
    settings.tracking,
  ).catch((err) =>
    console.error(`[claims] storing shipments for ${order.name}:`, err),
  );
  if (body.notify === true)
    await notifyNewClaim(admin, claim.id, { customer: true, merchant: false });
  return redirect(`/app/claims/${claim.id}`);
};

export default function NewClaim() {
  const d = useLoaderData<typeof loader>();
  const o = d.order;
  return (
    <s-page heading="Create a claim">
      <s-link slot="breadcrumb-actions" href="/app/claims">
        Claims
      </s-link>
      <s-section heading="Order">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            For a customer who contacted you directly, or a package you know is
            lost. The claim gets the same review flags as one filed on your
            claims page.
          </s-paragraph>
          <Form method="get">
            <s-stack direction="inline" gap="small-200" alignItems="end">
              <s-text-field
                name="q"
                label="Order number"
                placeholder="#1001"
                defaultValue={o?.name ?? d.q}
              />
              <s-button type="submit">Find order</s-button>
            </s-stack>
          </Form>
          {d.error && <s-banner tone="critical">{d.error}</s-banner>}
        </s-stack>
      </s-section>
      {/* Keyed: a new order starts a fresh form. */}
      {o && <ClaimForm key={o.id} d={{ ...d, order: o }} />}
    </s-page>
  );
}

type Loaded = ReturnType<typeof useLoaderData<typeof loader>>;

function ClaimForm({
  d,
}: {
  d: Loaded & { order: NonNullable<Loaded["order"]> };
}) {
  const fetcher = useFetcher<ActionResult>();
  const busy = fetcher.state !== "idle";
  const o = d.order;
  const [type, setType] = useState<ClaimType>("LOST");
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [email, setEmail] = useState(o?.email ?? "");
  const [description, setDescription] = useState("");
  const [override, setOverride] = useState("");
  const [notify, setNotify] = useState(true);
  const money = (n: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: d.currency,
    }).format(n);

  return (
    <>
      {fetcher.data && !fetcher.data.ok && (
        <s-banner tone="critical" heading="Not created">
          {fetcher.data.error}
        </s-banner>
      )}
      {d.openClaimId ? (
        <s-banner tone="warning" heading="This order already has an open claim">
          <s-link href={`/app/claims/${d.openClaimId}`}>Open it</s-link>
        </s-banner>
      ) : (
        <s-section heading={`Claim on ${o.name}`}>
          <s-stack direction="block" gap="base">
            {d.problem && (
              <s-banner
                tone="warning"
                heading="Outside your online claim rules"
              >
                {d.problem} You can still create it — say why in the note below.
              </s-banner>
            )}
            {!d.isProtected && (
              <s-text color="subdued">
                This order didn&apos;t buy shipping protection.
              </s-text>
            )}
            <s-select
              label="What happened"
              value={type}
              onChange={(e) => setType(e.currentTarget.value as ClaimType)}
            >
              {CLAIM_TYPES.map((t) => (
                <s-option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </s-option>
              ))}
            </s-select>
            <s-stack direction="block" gap="small-200">
              <s-text type="strong">Affected items</s-text>
              {o.lines.length === 0 && (
                <s-text color="subdued">
                  Nothing on this order can be claimed.
                </s-text>
              )}
              {o.lines.map((l) => (
                <s-stack
                  key={l.id}
                  direction="inline"
                  gap="small-200"
                  alignItems="center"
                >
                  <s-checkbox
                    label={`${l.title} (${money(l.unitAmount)} each)`}
                    checked={!!picked[l.id]}
                    onChange={(e) => {
                      const next = { ...picked };
                      if (e.currentTarget.checked) next[l.id] = l.quantity;
                      else delete next[l.id];
                      setPicked(next);
                    }}
                  />
                  {!!picked[l.id] && l.quantity > 1 && (
                    <s-number-field
                      label="Quantity"
                      labelAccessibilityVisibility="exclusive"
                      min={1}
                      max={l.quantity}
                      step={1}
                      value={String(picked[l.id])}
                      onInput={(e) =>
                        setPicked({
                          ...picked,
                          [l.id]: Math.max(
                            1,
                            Math.min(
                              l.quantity,
                              Number(e.currentTarget.value) || 1,
                            ),
                          ),
                        })
                      }
                    />
                  )}
                </s-stack>
              ))}
            </s-stack>
            <s-email-field
              label="Customer email"
              details="Claim updates and the status page link go here."
              value={email}
              onInput={(e) => setEmail(e.currentTarget.value)}
            />
            <s-text-area
              label="What happened"
              details="Shown to the customer on their claim page."
              rows={4}
              value={description}
              onInput={(e) => setDescription(e.currentTarget.value)}
            />
            <s-text-area
              label={
                d.problem
                  ? "Internal note: why create it anyway? (required)"
                  : "Internal note (optional)"
              }
              details="Only your staff see this."
              rows={2}
              value={override}
              onInput={(e) => setOverride(e.currentTarget.value)}
            />
            <s-checkbox
              label="Email the customer a confirmation with a link to follow the claim"
              checked={notify}
              onChange={(e) => setNotify(e.currentTarget.checked)}
            />
            <s-button
              variant="primary"
              {...(busy ? { loading: true } : {})}
              disabled={
                !Object.keys(picked).length ||
                !email.trim() ||
                !description.trim() ||
                (!!d.problem && !override.trim())
              }
              onClick={() =>
                fetcher.submit(
                  {
                    orderId: o.id,
                    type,
                    picked,
                    email,
                    description,
                    override,
                    notify,
                  } as never,
                  { method: "POST", encType: "application/json" },
                )
              }
            >
              Create claim
            </s-button>
          </s-stack>
        </s-section>
      )}
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
