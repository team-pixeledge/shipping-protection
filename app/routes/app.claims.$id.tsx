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
} from "../lib/claims";
import { changeClaimStatus, ClaimConflict, messageCustomer } from "../lib/claims.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const claim = await prisma.claim.findFirst({
    where: { id: params.id, shop: session.shop },
    include: { events: { orderBy: { createdAt: "asc" } }, files: { orderBy: { createdAt: "asc" } } },
  });
  if (!claim) throw new Response("Not found", { status: 404 });
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
    },
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
    if (err instanceof ClaimConflict) return { ok: false, error: err.message };
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
  const { claim, files, events, otherClaims } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const choices = CLAIM_STATUSES.filter((s) => canTransition(claim.status, s));
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
    shopify.toast.show(d.intent === "status" ? "Claim updated" : d.intent === "message" ? "Message sent" : "Note added");
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
