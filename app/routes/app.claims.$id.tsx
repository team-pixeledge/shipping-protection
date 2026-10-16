import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { signToken } from "../lib/claim-token.server";
import {
  canTransition,
  CLAIM_STATUSES,
  FLAG_LABELS,
  formatClaimNumber,
  isClaimStatus,
  isResolution,
  RESOLUTION_LABELS,
  RESOLUTIONS,
  STATUS_LABELS,
  STATUS_TONE,
  TYPE_LABELS,
  type ClaimItem,
  type ClaimStatus,
  type ClaimType,
  type Resolution,
  type Shipment,
  defaultKind,
  isResolutionKind,
  KIND_SCOPES,
  RESOLUTION_KIND_LABELS,
  RESOLUTION_KINDS,
  type ResolutionKind,
} from "../lib/claims";
import { changeClaimStatus, ClaimConflict, messageCustomer } from "../lib/claims.server";
import { clearStuck, refundPreview, resolveClaim, ResolutionError, type RefundPreview } from "../lib/resolutions.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const claim = await prisma.claim.findFirst({
    where: { id: params.id, shop: session.shop },
    include: {
      events: { orderBy: { createdAt: "asc" } },
      files: { orderBy: { createdAt: "asc" } },
      resolutions: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!claim) throw new Response("Not found", { status: 404 });
  const shopRow = await prisma.shop.findUniqueOrThrow({ where: { shop: session.shop } });

  // What a refund would be, shown before the merchant commits to it.
  let refund: RefundPreview | null = null;
  let refundError: string | null = null;
  if (claim.status === "APPROVED" && !claim.resolvedAt) {
    try {
      refund = await refundPreview(admin, claim.orderId, claim.items as unknown as ClaimItem[]);
    } catch (err) {
      refundError = err instanceof Error ? err.message : String(err);
    }
  }
  const running = claim.resolutions.find((r) => r.id === claim.resolutionLock && r.status === "PROCESSING");
  const appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  const otherClaims = await prisma.claim.findMany({
    where: { shop: session.shop, email: claim.email, id: { not: claim.id } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, number: true, orderName: true, status: true },
  });
  return {
    claim: {
      id: claim.id,
      number: claim.number,
      orderId: claim.orderId,
      orderName: claim.orderName,
      type: claim.type as ClaimType,
      status: claim.status as ClaimStatus,
      resolution: claim.resolution as Resolution | null,
      email: claim.email,
      description: claim.description,
      items: claim.items as unknown as ClaimItem[],
      amount: Number(claim.amount),
      currency: claim.currency,
      protected: claim.protected,
      flags: claim.flags,
      shipments: claim.shipments as unknown as Shipment[],
      createdAt: claim.createdAt.toISOString(),
      resolvedAt: claim.resolvedAt?.toISOString() ?? null,
    },
    shopCurrency: shopRow.currency,
    refund,
    refundError,
    running: running ? { stuck: Date.now() - running.createdAt.getTime() > 5 * 60_000 } : null,
    resolutions: claim.resolutions.map((r) => ({
      id: r.id,
      type: r.type as ResolutionKind,
      status: r.status,
      amount: Number(r.amount),
      currency: r.currency,
      shopifyId: r.shopifyId,
      shopifyName: r.shopifyName,
      note: r.note,
      error: r.error,
      at: (r.completedAt ?? r.createdAt).toISOString(),
    })),
    files: claim.files.map((f) => {
      const t = encodeURIComponent(signToken({ p: "file", shop: session.shop, id: f.id }));
      return {
        id: f.id,
        name: f.name,
        image: f.contentType.startsWith("image/") && !/hei[cf]/.test(f.contentType),
        size: f.size,
        url: `${appUrl}/claim-files/${f.id}?t=${t}`,
        download: `${appUrl}/claim-files/${f.id}?t=${t}&download=1`,
      };
    }),
    events: claim.events.map((e) => ({
      id: e.id,
      actor: e.actor,
      kind: e.kind,
      status: e.status,
      message: e.message,
      internal: e.internal,
      at: e.createdAt.toISOString(),
    })),
    otherClaims: otherClaims.map((c) => ({ ...c, status: c.status as ClaimStatus })),
  };
};

type ActionResult = { ok: true; intent: string } | { ok: false; error: string };

export const action = async ({ request, params }: ActionFunctionArgs): Promise<ActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const claim = await prisma.claim.findFirst({ where: { id: params.id, shop: session.shop } });
  if (!claim) return { ok: false, error: "Claim not found." };
  const body = (await request.json()) as Record<string, unknown>;
  const text = (v: unknown, max = 3000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

  try {
    if (body.intent === "resolve") {
      const type = body.type;
      if (!isResolutionKind(type)) return { ok: false, error: "Choose how to resolve the claim." };
      const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
      const amount = num(body.amount);
      if (amount !== null && !(Number.isFinite(amount) && amount >= 0)) return { ok: false, error: "Enter a valid amount." };
      const input =
        type === "REFUND"
          ? { type, amount, notify: body.notify === true }
          : type === "REPLACEMENT"
            ? { type, cost: amount ?? Number(claim.amount) }
            : type === "STORE_CREDIT"
              ? { type, amount: amount ?? Number(claim.amount) }
              : { type, cost: amount ?? 0, note: text(body.note, 500) };
      await resolveClaim(admin, session.shop, claim.id, input);
      return { ok: true, intent: "resolve" };
    }
    if (body.intent === "clearStuck") {
      await clearStuck(session.shop, claim.id);
      return { ok: true, intent: "clearStuck" };
    }
    if (body.intent === "status") {
      const from = body.from;
      const to = body.to;
      if (!isClaimStatus(from) || !isClaimStatus(to) || !canTransition(from, to)) {
        return { ok: false, error: "That change isn't possible from the claim's current status." };
      }
      const message = text(body.message);
      const note = text(body.note);
      if ((to === "NEEDS_INFO" || to === "REJECTED") && !message) {
        return { ok: false, error: "Write a message to the customer explaining what you need or why." };
      }
      if (to === "OPEN" && claim.resolvedAt) {
        return { ok: false, error: "This claim was resolved (money or goods were sent), so it can't be reopened." };
      }
      if (to === "OPEN" && (from === "APPROVED" || from === "REJECTED") && !note) {
        return { ok: false, error: "Add an internal note saying why you're reopening the claim." };
      }
      const resolution = to === "APPROVED" ? (isResolution(body.resolution) ? body.resolution : "OTHER") : null;
      await changeClaimStatus(admin, { shop: session.shop, claimId: claim.id, from, to, resolution, message, note });
      return { ok: true, intent: "status" };
    }
    if (body.intent === "message") {
      const message = text(body.message);
      if (!message) return { ok: false, error: "Write a message first." };
      await messageCustomer(admin, session.shop, claim.id, message);
      return { ok: true, intent: "message" };
    }
    if (body.intent === "note") {
      const note = text(body.note);
      if (!note) return { ok: false, error: "Write a note first." };
      await prisma.claimEvent.create({
        data: { claimId: claim.id, actor: "MERCHANT", kind: "NOTE", message: note, internal: true },
      });
      return { ok: true, intent: "note" };
    }
  } catch (err) {
    if (err instanceof ClaimConflict || err instanceof ResolutionError) return { ok: false, error: err.message };
    throw err;
  }
  return { ok: false, error: "Unknown action." };
};

const ACTION_LABELS: Record<ClaimStatus, string> = {
  OPEN: "Reopen / back to review",
  NEEDS_INFO: "Ask the customer for more information",
  APPROVED: "Approve",
  REJECTED: "Reject",
};

export default function ClaimPage() {
  const { claim, files, events, otherClaims, refund, refundError, running, resolutions, shopCurrency } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const choices = CLAIM_STATUSES.filter(
    (s) => canTransition(claim.status, s) && !(s === "OPEN" && claim.resolvedAt),
  );
  const [to, setTo] = useState<ClaimStatus | "">("");
  const [resolution, setResolution] = useState<Resolution>("REFUND");
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");
  const [freeMessage, setFreeMessage] = useState("");
  const [freeNote, setFreeNote] = useState("");

  // Clear the form once per successful save (state set during render, not in an effect).
  const [handled, setHandled] = useState<ActionResult | undefined>(undefined);
  if (fetcher.data?.ok && fetcher.data !== handled) {
    setHandled(fetcher.data);
    setTo("");
    setMessage("");
    setNote("");
    setFreeMessage("");
    setFreeNote("");
  }
  useEffect(() => {
    const d = fetcher.data;
    if (!d?.ok) return;
    const toasts: Record<string, string> = {
      status: "Claim updated",
      message: "Message sent",
      note: "Note added",
      resolve: "Resolution carried out",
      clearStuck: "Cleared — you can try again",
    };
    shopify.toast.show(toasts[d.intent] ?? "Saved");
  }, [fetcher.data, shopify]);

  const money = (n: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: claim.currency }).format(n);
  const when = (iso: string) => new Date(iso).toLocaleString();
  const submit = (data: Record<string, unknown>) =>
    fetcher.submit(data as never, { method: "POST", encType: "application/json" });

  const messageNeeded = to === "NEEDS_INFO" || to === "REJECTED";
  const reopening = to === "OPEN" && (claim.status === "APPROVED" || claim.status === "REJECTED");

  return (
    <s-page heading={`${formatClaimNumber(claim.number)} · ${claim.orderName}`}>
      <s-link slot="breadcrumb-actions" href="/app/claims">
        Claims
      </s-link>

      {fetcher.data && !fetcher.data.ok && (
        <s-banner tone="critical" heading="Not saved">
          {fetcher.data.error}
        </s-banner>
      )}
      {claim.flags.length > 0 && (
        <s-banner tone="warning" heading="Check before deciding">
          <s-unordered-list>
            {claim.flags.map((f) => (
              <s-list-item key={f}>{FLAG_LABELS[f] ?? f}</s-list-item>
            ))}
          </s-unordered-list>
          These are hints from the order and tracking data, not proof either way.
        </s-banner>
      )}

      <s-section heading="Decision">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-badge tone={STATUS_TONE[claim.status]}>{STATUS_LABELS[claim.status]}</s-badge>
            {claim.status === "APPROVED" && claim.resolution && (
              <s-text color="subdued">{RESOLUTION_LABELS[claim.resolution]}</s-text>
            )}
          </s-stack>
          <s-select label="Next step" value={to} onChange={(e) => setTo(e.currentTarget.value as ClaimStatus | "")}>
            <s-option value="">Choose…</s-option>
            {choices.map((s) => (
              <s-option key={s} value={s}>
                {ACTION_LABELS[s]}
              </s-option>
            ))}
          </s-select>
          {to === "APPROVED" && (
            <s-select
              label="Resolution"
              value={resolution}
              details="Recorded on the claim and told to the customer. Issue the refund, replacement order or store credit in Shopify yourself."
              onChange={(e) => setResolution(e.currentTarget.value as Resolution)}
            >
              {RESOLUTIONS.map((r) => (
                <s-option key={r} value={r}>
                  {RESOLUTION_LABELS[r]}
                </s-option>
              ))}
            </s-select>
          )}
          {to && (
            <s-text-area
              label={messageNeeded ? "Message to the customer (required)" : "Message to the customer (optional)"}
              details="Included in the email the customer gets about this change."
              rows={4}
              value={message}
              onInput={(e) => setMessage(e.currentTarget.value)}
            />
          )}
          {to && (
            <s-text-area
              label={reopening ? "Internal note: why reopen? (required)" : "Internal note (optional)"}
              details="Only your staff see this."
              rows={2}
              value={note}
              onInput={(e) => setNote(e.currentTarget.value)}
            />
          )}
          {to && (
            <s-button
              variant="primary"
              tone={to === "REJECTED" ? "critical" : "auto"}
              disabled={(messageNeeded && !message.trim()) || (reopening && !note.trim())}
              {...(busy ? { loading: true } : {})}
              onClick={() => submit({ intent: "status", from: claim.status, to, resolution, message, note })}
            >
              {ACTION_LABELS[to]}
            </s-button>
          )}
        </s-stack>
      </s-section>

      {claim.status === "APPROVED" && !claim.resolvedAt && (
        <ResolvePanel
          claim={claim}
          refund={refund}
          refundError={refundError}
          running={running}
          shopCurrency={shopCurrency}
          busy={busy}
          submit={submit}
        />
      )}

      {resolutions.length > 0 && (
        <s-section heading="Resolution">
          <s-stack direction="block" gap="small-200">
            {resolutions.map((r) => (
              <s-box key={r.id} padding="small-200" borderWidth="base" borderRadius="base">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-badge tone={r.status === "DONE" ? "success" : r.status === "FAILED" ? "critical" : "info"}>
                    {r.status === "DONE" ? "Done" : r.status === "FAILED" ? "Failed" : "In progress"}
                  </s-badge>
                  <s-text type="strong">{RESOLUTION_KIND_LABELS[r.type]}</s-text>
                  {r.status === "DONE" && (
                    <s-text>
                      {new Intl.NumberFormat(undefined, { style: "currency", currency: r.currency }).format(r.amount)}{" "}
                      cost
                    </s-text>
                  )}
                  {r.type === "REPLACEMENT" && r.shopifyName && r.shopifyId && (
                    <s-link href={`shopify://admin/orders/${r.shopifyId.split("/").pop()}`} target="_top">
                      {r.shopifyName}
                    </s-link>
                  )}
                  {r.type === "REFUND" && r.status === "DONE" && (
                    <s-link href={`shopify://admin/orders/${claim.orderId}`} target="_top">
                      See the refund on {claim.orderName}
                    </s-link>
                  )}
                  <s-text color="subdued">{when(r.at)}</s-text>
                </s-stack>
                {r.note && <s-text>{r.note}</s-text>}
                {r.error && <s-text color="subdued">{r.error}</s-text>}
              </s-box>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section heading="Claim">
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
            <Field label="What happened" value={TYPE_LABELS[claim.type]} />
            <Field label="Filed" value={when(claim.createdAt)} />
            <Field label="Claimed" value={money(claim.amount)} />
            <Field label="Protection bought" value={claim.protected ? "Yes" : "No"} />
          </s-grid>
          <s-stack direction="inline" gap="small-200">
            <s-text color="subdued">Order:</s-text>
            <s-link href={`shopify://admin/orders/${claim.orderId}`} target="_top">
              {claim.orderName}
            </s-link>
            <s-text color="subdued">Customer email:</s-text>
            <s-link href={`mailto:${claim.email}`}>{claim.email}</s-link>
          </s-stack>
          <s-table>
            <s-table-header-row>
              <s-table-header>Item</s-table-header>
              <s-table-header format="numeric">Qty</s-table-header>
              <s-table-header format="numeric">Value</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {claim.items.map((i) => (
                <s-table-row key={i.lineItemId}>
                  <s-table-cell>{i.title}</s-table-cell>
                  <s-table-cell>{i.quantity}</s-table-cell>
                  <s-table-cell>{money(i.amount)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-paragraph>{claim.description}</s-paragraph>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading={`Evidence (${files.length})`}>
        {files.length === 0 ? (
          <s-paragraph>No files were uploaded.</s-paragraph>
        ) : (
          <s-stack direction="inline" gap="base">
            {files.map((f) => (
              <s-stack key={f.id} direction="block" gap="small-200">
                {f.image ? (
                  <a href={f.url} target="_blank" rel="noreferrer">
                    <img
                      src={f.url}
                      alt={f.name}
                      style={{ width: 160, height: 160, objectFit: "cover", borderRadius: 8, display: "block" }}
                    />
                  </a>
                ) : null}
                <s-link href={f.download} target="_blank">
                  {f.name}
                </s-link>
                <s-text color="subdued">{(f.size / 1024 / 1024).toFixed(1)} MB</s-text>
              </s-stack>
            ))}
          </s-stack>
        )}
        <s-text color="subdued">Links stop working after 15 minutes. Reload the page for fresh ones.</s-text>
      </s-section>

      <s-section heading="Shipping when the claim was filed">
        {claim.shipments.length === 0 ? (
          <s-paragraph>No shipments.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Status</s-table-header>
              <s-table-header>Shipped</s-table-header>
              <s-table-header>Delivered</s-table-header>
              <s-table-header>Tracking</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {claim.shipments.map((s, i) => (
                <s-table-row key={i}>
                  <s-table-cell>{s.status.replace(/_/g, " ").toLowerCase()}</s-table-cell>
                  <s-table-cell>{new Date(s.shippedAt).toLocaleDateString()}</s-table-cell>
                  <s-table-cell>{s.deliveredAt ? new Date(s.deliveredAt).toLocaleDateString() : "—"}</s-table-cell>
                  <s-table-cell>
                    {s.tracking.length === 0
                      ? "—"
                      : s.tracking.map((t, j) =>
                          t.url ? (
                            <s-link key={j} href={t.url} target="_blank">
                              {[t.company, t.number].filter(Boolean).join(" ")}
                            </s-link>
                          ) : (
                            <s-text key={j}>{[t.company, t.number].filter(Boolean).join(" ")}</s-text>
                          ),
                        )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="History">
        <s-stack direction="block" gap="base">
          {events.map((e) => (
            <s-box key={e.id} padding="small-200" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-text type="strong">{eventTitle(e)}</s-text>
                  {e.internal && <s-badge>Internal</s-badge>}
                  <s-text color="subdued">{when(e.at)}</s-text>
                </s-stack>
                {e.message && <s-text>{e.message}</s-text>}
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      <s-section heading="Message or note">
        <s-stack direction="block" gap="base">
          <s-text-area
            label="Message to the customer"
            details="Emailed to the customer and shown on their claim page. Doesn't change the status."
            rows={3}
            value={freeMessage}
            onInput={(e) => setFreeMessage(e.currentTarget.value)}
          />
          <s-button disabled={!freeMessage.trim()} onClick={() => submit({ intent: "message", message: freeMessage })}>
            Send message
          </s-button>
          <s-text-area
            label="Internal note"
            details="Only your staff see this."
            rows={2}
            value={freeNote}
            onInput={(e) => setFreeNote(e.currentTarget.value)}
          />
          <s-button disabled={!freeNote.trim()} onClick={() => submit({ intent: "note", note: freeNote })}>
            Add note
          </s-button>
        </s-stack>
      </s-section>

      {otherClaims.length > 0 && (
        <s-section heading="Other claims from this email">
          <s-unordered-list>
            {otherClaims.map((c) => (
              <s-list-item key={c.id}>
                <s-link href={`/app/claims/${c.id}`}>{formatClaimNumber(c.number)}</s-link> · {c.orderName} ·{" "}
                {STATUS_LABELS[c.status]}
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-section>
      )}
    </s-page>
  );
}

type Submit = (data: Record<string, unknown>) => void;

function ResolvePanel({
  claim,
  refund,
  refundError,
  running,
  shopCurrency,
  busy,
  submit,
}: {
  claim: { amount: number; currency: string; resolution: Resolution | null; orderName: string };
  refund: RefundPreview | null;
  refundError: string | null;
  running: { stuck: boolean } | null;
  shopCurrency: string;
  busy: boolean;
  submit: Submit;
}) {
  const shopify = useAppBridge();
  const [kind, setKind] = useState<ResolutionKind>(defaultKind(claim.resolution));
  const [custom, setCustom] = useState(false);
  const [amount, setAmount] = useState("");
  const [notify, setNotify] = useState(false);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [granted, setGranted] = useState<string[] | null>(null);

  useEffect(() => {
    let live = true;
    shopify.scopes
      .query()
      .then((d) => live && setGranted(d.granted))
      .catch(() => live && setGranted([]));
    return () => {
      live = false;
    };
  }, [shopify]);

  const fmt = (n: number, c: string) => new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(n);
  const missing = granted === null ? [] : KIND_SCOPES[kind].filter((s) => !granted.includes(s));
  const value = amount.trim() === "" ? null : Number(amount);

  const label =
    kind === "REFUND"
      ? `Refund ${refund ? fmt(custom && value !== null ? value : refund.amount, refund.currency) : ""}`
      : kind === "REPLACEMENT"
        ? "Create the replacement order"
        : kind === "STORE_CREDIT"
          ? `Issue ${fmt(value ?? claim.amount, shopCurrency)} store credit`
          : "Record as handled";

  const go = () =>
    submit({
      intent: "resolve",
      type: kind,
      amount: kind === "REFUND" ? (custom ? value : null) : value,
      notify,
      note,
    });

  return (
    <s-section heading="Carry out the resolution">
      <s-stack direction="block" gap="base">
        {running && (
          <s-banner tone={running.stuck ? "warning" : "info"} heading={running.stuck ? "An attempt didn't finish" : "In progress"}>
            {running.stuck ? (
              <>
                Check {claim.orderName} in Shopify (refunds, new orders, store credit). If nothing was created, clear the
                attempt and try again.{" "}
                <s-button variant="tertiary" onClick={() => submit({ intent: "clearStuck" })}>
                  Nothing was created — clear it
                </s-button>
              </>
            ) : (
              "This claim is being resolved. Reload in a moment."
            )}
          </s-banner>
        )}
        <s-select
          label="How"
          value={kind}
          onChange={(e) => {
            setKind(e.currentTarget.value as ResolutionKind);
            setAmount("");
            setConfirming(false);
          }}
        >
          {RESOLUTION_KINDS.map((k) => (
            <s-option key={k} value={k}>
              {RESOLUTION_KIND_LABELS[k]}
            </s-option>
          ))}
        </s-select>

        {kind === "REFUND" &&
          (refund ? (
            <s-stack direction="block" gap="small-200">
              <s-paragraph>
                Refunds {fmt(refund.amount, refund.currency)} for the claimed items, tax included, to{" "}
                {refund.sources.map((s) => s.label).join(" and ") || "the original payment"}. The items aren&apos;t
                restocked.
              </s-paragraph>
              <s-checkbox
                label="Refund a different amount (money only, no items)"
                checked={custom}
                onChange={(e) => setCustom(e.currentTarget.checked)}
              />
              {custom && (
                <s-number-field
                  label={`Amount (${refund.currency})`}
                  min={0}
                  max={refund.amount}
                  step={0.01}
                  value={amount}
                  onInput={(e) => setAmount(e.currentTarget.value)}
                />
              )}
              <s-checkbox
                label="Also send Shopify's refund notification to the customer"
                details="The customer gets our claim email either way."
                checked={notify}
                onChange={(e) => setNotify(e.currentTarget.checked)}
              />
            </s-stack>
          ) : (
            <s-banner tone="warning">{refundError ?? "A refund can't be worked out for this order."}</s-banner>
          ))}

        {kind === "REPLACEMENT" && (
          <s-stack direction="block" gap="small-200">
            <s-paragraph>
              Creates a new order for the claimed items at no charge, shipped to the original order&apos;s address,
              tagged &ldquo;Shipping protection replacement&rdquo;. Fulfil it like any other order.
            </s-paragraph>
            <s-number-field
              label={`Your cost, for reports (${shopCurrency})`}
              details="Defaults to the items' sale value. Enter what the replacement really costs you."
              min={0}
              step={0.01}
              placeholder={String(claim.amount)}
              value={amount}
              onInput={(e) => setAmount(e.currentTarget.value)}
            />
          </s-stack>
        )}

        {kind === "STORE_CREDIT" && (
          <s-stack direction="block" gap="small-200">
            <s-paragraph>
              Adds store credit to the customer&apos;s account. They use it at checkout when signed in.
            </s-paragraph>
            <s-number-field
              label={`Amount (${shopCurrency})`}
              min={0}
              step={0.01}
              placeholder={String(claim.amount)}
              value={amount}
              onInput={(e) => setAmount(e.currentTarget.value)}
            />
          </s-stack>
        )}

        {kind === "MANUAL" && (
          <s-stack direction="block" gap="small-200">
            <s-paragraph>
              For anything you did yourself in Shopify or elsewhere. Nothing is sent to Shopify or the customer.
            </s-paragraph>
            <s-number-field
              label={`What it cost you (${shopCurrency})`}
              min={0}
              step={0.01}
              value={amount}
              onInput={(e) => setAmount(e.currentTarget.value)}
            />
            <s-text-field label="What you did" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
          </s-stack>
        )}

        {missing.length > 0 ? (
          <s-banner tone="info" heading="Permission needed">
            The app needs your permission to {kind === "REPLACEMENT" ? "create orders" : "issue store credit"}.{" "}
            <s-button
              onClick={() =>
                shopify.scopes
                  .request(missing)
                  .then(() => shopify.scopes.query())
                  .then((d) => setGranted(d.granted))
                  .catch(() => {})
              }
            >
              Allow
            </s-button>
          </s-banner>
        ) : confirming ? (
          <s-stack direction="inline" gap="small-200">
            <s-button variant="primary" {...(busy ? { loading: true } : {})} onClick={go}>
              Yes, {label.charAt(0).toLowerCase() + label.slice(1)}
            </s-button>
            <s-button onClick={() => setConfirming(false)}>Cancel</s-button>
          </s-stack>
        ) : (
          <s-stack direction="inline" gap="small-200">
            <s-button
              variant="primary"
              disabled={
                !!running ||
                (kind === "REFUND" && (!refund || (custom && !(value !== null && value > 0 && value <= refund.amount)))) ||
                (kind === "MANUAL" && value === null)
              }
              onClick={() => setConfirming(true)}
            >
              {label}
            </s-button>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  );
}

function eventTitle(e: { actor: string; kind: string; status: string | null }) {
  const who = e.actor === "CUSTOMER" ? "Customer" : e.actor === "MERCHANT" ? "Staff" : "System";
  switch (e.kind) {
    case "SUBMITTED":
      return "Customer filed the claim";
    case "STATUS":
      return `${who}: ${STATUS_LABELS[e.status as ClaimStatus] ?? e.status}`;
    case "MESSAGE":
      return `${who} wrote`;
    case "NOTE":
      return "Internal note";
    case "FILES":
      return `${who} added files`;
    case "EMAIL":
      return "Email";
    case "RESOLVED":
      return "Resolution carried out";
    default:
      return e.kind;
  }
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <s-stack direction="block" gap="small-100">
      <s-text color="subdued">{label}</s-text>
      <s-text type="strong">{value}</s-text>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
