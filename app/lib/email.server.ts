// Claim emails through Resend. Without RESEND_API_KEY / CLAIMS_EMAIL_FROM
// nothing is sent and the claim's history says so — a claim never fails
// because an email couldn't go out.
import { Resend } from "resend";
import { formatClaimNumber, RESOLUTION_LABELS, STATUS_LABELS, type ClaimStatus, type Resolution } from "./claims";

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
}

/** To the customer, right after they file. */
export function claimReceivedEmail(c: ClaimEmailContext) {
  const title = `We've received your claim ${formatClaimNumber(c.number)}`;
  const body = `We've received your claim for order ${c.orderName}. We'll review it and email you when there's an update.`;
  return {
    subject: `${title} (order ${c.orderName})`,
    html: layout(c.storeName, title, paragraphs(body), { href: c.statusUrl, label: "View your claim" }),
    text: `${title}\n\n${body}\n\nView your claim: ${c.statusUrl}`,
  };
}

/** To the customer, when the merchant changes the status (or writes to them). */
export function claimUpdateEmail(
  c: ClaimEmailContext & { status: ClaimStatus; resolution?: Resolution | null; message?: string | null },
) {
  const n = formatClaimNumber(c.number);
  const lead: Record<ClaimStatus, string> = {
    OPEN: `Your claim ${n} for order ${c.orderName} is being reviewed.`,
    NEEDS_INFO: `We need a little more information to review your claim ${n} for order ${c.orderName}. Please reply using the link below.`,
    APPROVED: `Good news: your claim ${n} for order ${c.orderName} has been approved${
      c.resolution ? ` (${RESOLUTION_LABELS[c.resolution].toLowerCase()})` : ""
    }.`,
    REJECTED: `We've reviewed your claim ${n} for order ${c.orderName} and weren't able to approve it.`,
  };
  const title = `Claim ${n}: ${STATUS_LABELS[c.status]}`;
  const message = c.message?.trim() ? `\n\n${c.message.trim()}` : "";
  const body = lead[c.status] + message;
  return {
    subject: `${title} (order ${c.orderName})`,
    html: layout(c.storeName, title, paragraphs(body), {
      href: c.statusUrl,
      label: c.status === "NEEDS_INFO" ? "Reply to the store" : "View your claim",
    }),
    text: `${title}\n\n${body}\n\n${c.statusUrl}`,
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
