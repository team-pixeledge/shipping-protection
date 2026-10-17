// HTML for the storefront claims page. Shopify renders app-proxy responses
// as Liquid inside the store's theme, so every dynamic value goes through
// esc(), which also neutralises { and } — otherwise a customer could type
// "{{ shop.metafields… }}" into a description and have the store render it.
// Text comes from ./i18n.ts in the page's language (PageOptions.lang).
// Pure: no I/O, so it's unit-tested (test/claims.test.ts).
import {
  CLAIM_TYPES,
  formatClaimNumber,
  UPLOAD_TYPES,
  type ClaimItem,
  type ClaimStatus,
  type ClaimType,
  type OrderLine,
  type Resolution,
} from "./claims";
import { DICTS, fill, formatDate, formatMoney, LOCALES, type Locale } from "./i18n";

export const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"'{}]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "{": "&#123;", "}": "&#125;" })[c]!,
  );

const paras = (s: string) =>
  s
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

export const money = (amount: number, currency: string, lang: Locale = "en") => formatMoney(amount, currency, lang);

// Single braces only in CSS: "{{" would be Liquid.
const STYLE = `<style>
.sp-claims { max-width: 640px; margin: 2rem auto; padding: 0 16px; line-height: 1.5; }
.sp-claims h1 { margin: 0 0 .5rem; }
.sp-claims form { display: grid; gap: 1rem; margin: 1.5rem 0; }
.sp-claims label { display: grid; gap: .3rem; font-weight: 600; }
.sp-claims input[type=text], .sp-claims input[type=email], .sp-claims textarea, .sp-claims select { font: inherit; padding: .6rem .7rem; border: 1px solid rgba(0,0,0,.3); border-radius: 6px; width: 100%; box-sizing: border-box; background: #fff; color: #111; }
.sp-claims fieldset { border: 1px solid rgba(0,0,0,.15); border-radius: 8px; padding: .8rem 1rem; margin: 0; display: grid; gap: .6rem; }
.sp-claims legend { font-weight: 600; padding: 0 .3rem; }
.sp-claims .sp-choice { display: flex; gap: .6rem; align-items: flex-start; font-weight: 400; }
.sp-claims .sp-choice input { margin-top: .3rem; }
.sp-claims .sp-item { display: grid; grid-template-columns: auto 48px 1fr auto; gap: .6rem; align-items: center; font-weight: 400; }
.sp-claims .sp-item img { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; }
.sp-claims .sp-item select { width: auto; padding: .3rem; }
.sp-claims .sp-muted { opacity: .75; font-size: .92em; font-weight: 400; }
.sp-claims .sp-note { padding: .8rem 1rem; border-radius: 8px; background: rgba(0,0,0,.05); }
.sp-claims .sp-error { padding: .8rem 1rem; border-radius: 8px; background: #fde8e8; color: #7a1010; }
.sp-claims .sp-ok { padding: .8rem 1rem; border-radius: 8px; background: #e6f4ea; color: #0d5223; }
.sp-claims .sp-badge { display: inline-block; padding: .15rem .6rem; border-radius: 99px; background: rgba(0,0,0,.08); font-size: .9em; }
.sp-claims .sp-timeline { list-style: none; padding: 0; margin: 0; display: grid; gap: .8rem; }
.sp-claims .sp-timeline li { border-left: 3px solid rgba(0,0,0,.15); padding-left: .8rem; }
.sp-claims button { font: inherit; padding: .7rem 1.2rem; border-radius: 6px; border: 0; background: #111; color: #fff; cursor: pointer; justify-self: start; }
.sp-claims button[disabled] { opacity: .5; cursor: progress; }
.sp-claims .sp-files { display: grid; gap: .3rem; }
.sp-claims table { border-collapse: collapse; width: 100%; }
.sp-claims td { padding: .3rem 0; vertical-align: top; }
</style>`;

// POSTs through an app proxy need a trailing slash (without one the proxy
// redirects and the body is lost). liquid() adds it to a form's action only
// when action is the tag's LAST attribute — keep it last, without a slash.
// The upload endpoint is fetched by script, so it carries its own slash.
export interface PageOptions {
  /** e.g. "/apps/safeship" — forms post back through the proxy. */
  prefix: string;
  appUrl: string;
  /** The page's language. */
  lang?: Locale;
  /**
   * The language wasn't chosen explicitly (no ?lang, no form field): let the
   * storefront's own language, which only Liquid knows, switch the page.
   */
  detectLang?: boolean;
  /** Replace the address bar (after a POST) so a refresh doesn't resubmit. */
  replaceUrl?: string;
}

const L = (o: PageOptions) => DICTS[o.lang ?? "en"];

/** Hidden field that keeps the language across form posts. */
const langField = (o: PageOptions) => `<input type="hidden" name="lang" value="${esc(o.lang ?? "en")}">`;

// Liquid fills in the storefront's language; if it's one we have and the
// page isn't in it, reload with ?lang=. Single braces only, apart from the
// one Liquid output tag.
const detectScript = (o: PageOptions) =>
  `<script>(function(){var l=("{{ request.locale.iso_code }}"||"").toLowerCase().split("-")[0];var have=${JSON.stringify(
    LOCALES,
  )};var u=new URL(location.href);if(l&&l!=="${o.lang ?? "en"}"&&have.indexOf(l)>=0&&!u.searchParams.get("lang"))` +
  `{u.searchParams.set("lang",l);location.replace(u.toString())}})();</script>`;

/** Strings the upload script shows, in the page's language. */
const uploadText = (o: PageOptions) => {
  const t = L(o);
  return JSON.stringify({
    tooMany: t.upTooMany,
    tooLarge: t.upTooLarge,
    uploading: t.upUploading,
    failed: t.upFailed,
    remove: t.upRemove,
  });
};

function page(o: PageOptions, body: string) {
  const replace = o.replaceUrl ? ` data-sp-replace-url="${esc(o.replaceUrl)}"` : "";
  return `${STYLE}<div class="sp-claims" lang="${esc(o.lang ?? "en")}" data-sp-text="${esc(uploadText(o))}"${replace}>${body}</div>
${o.detectLang ? detectScript(o) : ""}<script src="${esc(o.appUrl)}/claims-portal.js" defer></script>`;
}

const notice = (n?: { error?: string; ok?: string }) =>
  (n?.error ? `<div class="sp-error" role="alert">${esc(n.error)}</div>` : "") +
  (n?.ok ? `<div class="sp-ok" role="status">${esc(n.ok)}</div>` : "");

export function unavailablePage(o: PageOptions, why?: string) {
  return page(o, `<h1>${esc(L(o).pageTitle)}</h1><p>${esc(why ?? L(o).unavailable)}</p>`);
}

export function lookupPage(
  o: PageOptions & { policy: string; signedIn: boolean; error?: string; orderName?: string; email?: string },
) {
  const t = L(o);
  return page(
    o,
    `<h1>${esc(t.lookupTitle)}</h1>
<p>${esc(t.lookupIntro)}</p>
${o.policy ? `<div class="sp-note">${paras(o.policy)}</div>` : ""}
${notice({ error: o.error })}
<form method="post" action="${esc(o.prefix)}/claims">
  <input type="hidden" name="intent" value="lookup">
  ${langField(o)}
  <label>${esc(t.orderNumber)} <input type="text" name="order" required maxlength="40" autocomplete="off" placeholder="#1001" value="${esc(o.orderName)}"></label>
  <label>${esc(t.orderEmail)} ${o.signedIn ? `<span class="sp-muted">${esc(t.signedInOptional)}</span>` : ""}
    <input type="email" name="email" ${o.signedIn ? "" : "required"} maxlength="254" autocomplete="email" value="${esc(o.email)}"></label>
  <button type="submit">${esc(t.findOrder)}</button>
</form>
<p class="sp-muted">${esc(t.alreadyFiled)}</p>`,
  );
}

export function ineligiblePage(o: PageOptions & { orderName: string; reason: string; openClaimUrl?: string }) {
  const t = L(o);
  return page(
    o,
    `<h1>${esc(fill(t.orderHeading, { order: o.orderName }))}</h1>
<div class="sp-error" role="alert">${esc(o.reason)}</div>
${o.openClaimUrl ? `<p><a href="${esc(o.openClaimUrl)}">${esc(t.viewOpenClaim)}</a></p>` : ""}
<p><a href="${esc(o.prefix)}/claims?lang=${esc(o.lang ?? "en")}">${esc(t.lookupAnother)}</a></p>`,
  );
}

export function claimFormPage(
  o: PageOptions & {
    orderName: string;
    email: string;
    token: string;
    lines: OrderLine[];
    currency: string;
    uploads: boolean;
    photosForDamage: boolean;
    /** Lost and stolen claims need a document too. */
    evidenceForAll?: boolean;
    uploadPrefix: string;
    error?: string;
    values?: { type?: string; description?: string; picked?: Record<string, number> };
  },
) {
  const t = L(o);
  const v = o.values ?? {};
  const types = CLAIM_TYPES.map(
    (k) => `<label class="sp-choice"><input type="radio" name="type" value="${k}" required ${v.type === k ? "checked" : ""}>
  <span>${esc(t.types[k])}<br><span class="sp-muted">${esc(t.typeHelp[k])}</span></span></label>`,
  ).join("");
  const items = o.lines
    .map((l) => {
      const id = l.id.split("/").pop()!;
      const picked = v.picked?.[l.id] ?? 0;
      const qtys = Array.from({ length: l.quantity }, (_, i) => i + 1)
        .map((q) => `<option value="${q}" ${q === (picked || l.quantity) ? "selected" : ""}>${q}</option>`)
        .join("");
      const each = fill(t.each, { price: money(l.unitAmount, o.currency, o.lang) });
      return `<label class="sp-item"><input type="checkbox" name="line" value="${esc(id)}" ${picked ? "checked" : ""}>
  ${l.image ? `<img src="${esc(l.image)}" alt="">` : "<span></span>"}
  <span>${esc(l.title)}${l.variantTitle ? `<br><span class="sp-muted">${esc(l.variantTitle)}</span>` : ""}<br><span class="sp-muted">${esc(each)}</span></span>
  ${l.quantity > 1 ? `<select name="qty_${esc(id)}" aria-label="${esc(t.quantity)}">${qtys}</select>` : `<input type="hidden" name="qty_${esc(id)}" value="1"><span></span>`}</label>`;
    })
    .join("");
  const required = o.evidenceForAll ? t.uploadRequiredAll : o.photosForDamage ? t.uploadRequiredDamage : "";
  const upload = o.uploads
    ? `<div data-sp-upload data-token="${esc(o.token)}" data-prefix="${esc(o.uploadPrefix)}" data-endpoint="${esc(o.prefix)}/upload/">
  <label>${esc(t.uploadLabel)} <span class="sp-muted">(${esc([required, t.uploadFormats].filter(Boolean).join("; "))})</span>
  <input type="file" multiple accept="${UPLOAD_TYPES.join(",")}"></label>
  <div class="sp-files" aria-live="polite"></div>
</div>`
    : "";
  return page(
    o,
    `<h1>${esc(fill(t.claimFor, { order: o.orderName }))}</h1>
${notice({ error: o.error })}
<form method="post" data-sp-claim-form action="${esc(o.prefix)}/claims">
  <input type="hidden" name="intent" value="submit">
  <input type="hidden" name="token" value="${esc(o.token)}">
  ${langField(o)}
  <fieldset><legend>${esc(t.whatHappened)}</legend>${types}</fieldset>
  <fieldset><legend>${esc(t.whichItems)}</legend>${items}</fieldset>
  <label>${esc(t.tellUs)}
    <textarea name="description" rows="5" required minlength="10" maxlength="3000">${esc(v.description)}</textarea></label>
  ${upload}
  <p class="sp-muted">${esc(fill(t.updatesTo, { email: o.email }))}</p>
  <label class="sp-choice"><input type="checkbox" name="confirm" required> <span>${esc(t.confirmTrue)}</span></label>
  <button type="submit">${esc(t.submit)}</button>
</form>`,
  );
}

export interface PublicEvent {
  at: string;
  actor: string;
  kind: string;
  status: string | null;
  message: string | null;
}

export function statusPage(
  o: PageOptions & {
    number: number;
    orderName: string;
    type: ClaimType;
    status: ClaimStatus;
    resolution: Resolution | null;
    items: ClaimItem[];
    amount: number;
    currency: string;
    createdAt: string;
    events: PublicEvent[];
    token: string;
    claimId: string;
    uploads: boolean;
    uploadPrefix: string;
    ok?: string;
    error?: string;
  },
) {
  const t = L(o);
  const lang = o.lang ?? "en";
  const open = o.status === "OPEN" || o.status === "NEEDS_INFO";
  const timeline = o.events
    .map((e) => {
      const you = e.actor === "CUSTOMER";
      const what =
        e.kind === "SUBMITTED"
          ? e.actor === "MERCHANT"
            ? t.evStaffFiled
            : t.evFiled
          : e.kind === "RESOLVED"
            ? t.evResolved
            : e.kind === "STATUS"
              ? fill(t.evStatus, { status: t.statuses[e.status as ClaimStatus] ?? e.status ?? "" })
              : e.kind === "FILES"
                ? you
                  ? t.evYouFiles
                  : t.evStoreFiles
                : you
                  ? t.evYouWrote
                  : t.evStoreWrote;
      const body = e.kind === "FILES" ? "" : e.message ? paras(e.message) : "";
      return `<li><strong>${esc(what)}</strong> <span class="sp-muted">${esc(formatDate(e.at, lang))}</span>${body}</li>`;
    })
    .join("");
  const items = o.items
    .map(
      (i) =>
        `<tr><td>${esc(i.title)} × ${esc(i.quantity)}</td><td style="text-align:right">${esc(money(i.amount, o.currency, lang))}</td></tr>`,
    )
    .join("");
  const reply = open
    ? `<form method="post" data-sp-claim-form action="${esc(o.prefix)}/claims/${esc(o.claimId)}?t=${encodeURIComponent(o.token)}">
  <input type="hidden" name="intent" value="reply">
  <input type="hidden" name="token" value="${esc(o.token)}">
  ${langField(o)}
  <label>${esc(o.status === "NEEDS_INFO" ? t.replyNeedsInfo : t.replyMessage)}
    <textarea name="message" rows="4" maxlength="3000"></textarea></label>
  ${
    o.uploads
      ? `<div data-sp-upload data-token="${esc(o.token)}" data-prefix="${esc(o.uploadPrefix)}" data-endpoint="${esc(o.prefix)}/upload/">
  <label>${esc(t.addFiles)} <input type="file" multiple accept="${UPLOAD_TYPES.join(",")}"></label>
  <div class="sp-files" aria-live="polite"></div></div>`
      : ""
  }
  <button type="submit">${esc(t.send)}</button>
</form>`
    : `<p class="sp-muted">${esc(t.closed)}</p>`;
  return page(
    o,
    `<h1>${esc(fill(t.claimNumber, { number: formatClaimNumber(o.number) }))}</h1>
<p>${esc(fill(t.claimMeta, { order: o.orderName, type: t.types[o.type], date: formatDate(o.createdAt, lang) }))}</p>
<p><span class="sp-badge">${esc(t.statuses[o.status])}</span>${
      o.status === "APPROVED" && o.resolution ? ` <span class="sp-muted">${esc(t.resolutions[o.resolution])}</span>` : ""
    }</p>
${notice({ ok: o.ok, error: o.error })}
<table>${items}<tr><td><strong>${esc(t.totalClaimed)}</strong></td><td style="text-align:right"><strong>${esc(money(o.amount, o.currency, lang))}</strong></td></tr></table>
<h2>${esc(t.history)}</h2>
<ul class="sp-timeline">${timeline}</ul>
${reply}`,
  );
}
