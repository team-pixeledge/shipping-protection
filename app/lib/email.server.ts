// Claim emails through Resend. Without RESEND_API_KEY / CLAIMS_EMAIL_FROM
// nothing is sent and the claim's history says so — a claim never fails
// because an email couldn't go out.
import { Resend } from "resend";
import { formatClaimNumber, type ClaimStatus, type Resolution } from "./claims";
import { DICTS, fill, type Locale } from "./i18n";

export type EmailResult = { ok: true } | { ok: false; error: string };

let client: Resend | null = null;
const resend = () => (client ??= new Resend(process.env.RESEND_API_KEY));

export const emailConfigured = () => !!process.env.RESEND_API_KEY && !!process.env.CLAIMS_EMAIL_FROM;

/** `"Store name" <claims@…>`: the store's name, our verified address. */
function fromHeader(storeName: string) {
  const address = process.env.CLAIMS_EMAIL_FROM!.replace(/^.*<([^>]+)>.*$/, "$1").trim();
  const name = storeName.replace(/["<>\r\n\\]/g, "").slice(0, 60) || "Shipping protection";
  return `"${name}" <${address}>`;
}

export async function sendEmail(msg: {
  storeName: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string;
}): Promise<EmailResult> {
  if (!emailConfigured()) return { ok: false, error: "email isn't set up" };
  try {
    const { error } = await resend().emails.send(
      {
        from: fromHeader(msg.storeName),
        to: msg.to,
        ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
        subject: msg.subject.replace(/[\r\n]/g, " "),
        html: msg.html,
        text: msg.text,
      },
      msg.idempotencyKey ? { idempotencyKey: msg.idempotencyKey } : undefined,
    );
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- Templates ----

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const paragraphs = (s: string) =>
  s
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

function layout(storeName: string, title: string, body: string, link?: { href: string; label: string }) {
  const button = link
    ? `<p style="margin:20px 0"><a href="${escapeHtml(link.href)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(link.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;font-size:15px;line-height:1.5">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:28px">
<p style="margin:0 0 4px;color:#666;font-size:13px">${escapeHtml(storeName)}</p>
<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h1>
${body}${button}
</div></body></html>`;
}

export interface ClaimEmailContext {
  storeName: string;
  number: number;
  orderName: string;
  statusUrl: string;
  /** The claim's language (Claim.locale). */
  lang?: Locale;
}

/** To the customer, right after they file. */
export function claimReceivedEmail(c: ClaimEmailContext) {
  const t = DICTS[c.lang ?? "en"];
  const v = { number: formatClaimNumber(c.number), order: c.orderName };
  const title = fill(t.mailReceivedTitle, v);
  const body = fill(t.mailReceivedBody, v);
  return {
    subject: fill(t.mailSubject, { title, order: c.orderName }),
    html: layout(c.storeName, title, paragraphs(body), { href: c.statusUrl, label: t.mailViewClaim }),
    text: `${title}\n\n${body}\n\n${t.mailViewClaim}: ${c.statusUrl}`,
  };
}

/** To the customer, when the merchant changes the status (or writes to them). */
export function claimUpdateEmail(
  c: ClaimEmailContext & { status: ClaimStatus; resolution?: Resolution | null; message?: string | null },
) {
  const t = DICTS[c.lang ?? "en"];
  const v = { number: formatClaimNumber(c.number), order: c.orderName };
  const lead =
    c.status === "APPROVED" && c.resolution
      ? fill(t.mailApprovedWith, { ...v, resolution: t.resolutions[c.resolution].toLowerCase() })
      : fill(t.mailLead[c.status], v);
  const title = fill(t.mailUpdateTitle, { ...v, status: t.statuses[c.status] });
  const message = c.message?.trim() ? `\n\n${c.message.trim()}` : "";
  const body = lead + message;
  return {
    subject: fill(t.mailSubject, { title, order: c.orderName }),
    html: layout(c.storeName, title, paragraphs(body), {
      href: c.statusUrl,
      label: c.status === "NEEDS_INFO" ? t.mailReply : t.mailViewClaim,
    }),
    text: `${title}\n\n${body}\n\n${c.statusUrl}`,
  };
}

/** To the customer, when an approved claim's resolution was carried out. */
export function claimResolvedEmail(c: ClaimEmailContext & { text: string }) {
  const t = DICTS[c.lang ?? "en"];
  const title = fill(t.mailResolvedTitle, { number: formatClaimNumber(c.number) });
  return {
    subject: fill(t.mailSubject, { title, order: c.orderName }),
    html: layout(c.storeName, title, paragraphs(c.text), { href: c.statusUrl, label: t.mailViewClaim }),
    text: `${title}\n\n${c.text}\n\n${c.statusUrl}`,
  };
}

/** To the merchant: a new claim, or the customer replied. */
export function merchantClaimEmail(
  c: { storeName: string; number: number; orderName: string; adminUrl: string; kind: "new" | "reply"; summary: string },
) {
  const n = formatClaimNumber(c.number);
  const title = c.kind === "new" ? `New claim ${n} on order ${c.orderName}` : `Customer replied on claim ${n}`;
  return {
    subject: title,
    html: layout(c.storeName, title, paragraphs(c.summary), { href: c.adminUrl, label: "Review the claim" }),
    text: `${title}\n\n${c.summary}\n\n${c.adminUrl}`,
  };
}
