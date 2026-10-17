// Shared by the app-proxy routes (app/routes/proxy.*): Shopify forwards
// https://<store>/apps/safeship/… to https://<app>/proxy/… with a signed
// query string, which authenticate.public.appProxy checks.
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { pathnameAllowed, UPLOAD_TYPES, MAX_UPLOAD_BYTES, MAX_FILES_PER_MESSAGE } from "./claims";
import { blobInfo } from "./blob.server";
import type { PageOptions } from "./portal-pages";
import { parseSettings } from "./settings";
import { DICTS, fromAcceptLanguage, isLocale, type Locale } from "./i18n";
import { hasFeature, isPlanId } from "./plan";
import { effectiveClaimSettings } from "./gates";

const DEFAULT_PREFIX = "/apps/safeship";

export async function proxyContext(request: Request) {
  const { session, admin, liquid } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const shop = session?.shop ?? url.searchParams.get("shop") ?? "";
  const raw = url.searchParams.get("path_prefix") ?? DEFAULT_PREFIX;
  const prefix = /^\/(apps|a|community|tools)\/[\w-]{1,60}$/.test(raw) ? raw : DEFAULT_PREFIX;
  const customerId = url.searchParams.get("logged_in_customer_id") || null;

  const row = shop ? await prisma.shop.findUnique({ where: { shop } }) : null;
  // The merchant may rename the subpath; emailed links must follow it.
  if (row && row.portalPath !== prefix) {
    await prisma.shop.update({ where: { shop }, data: { portalPath: prefix } });
  }
  const settings = row?.settings ? parseSettings(row.settings) : null;
  const plan = isPlanId(row?.plan) ? row.plan : null;
  // Other languages are a Growth feature; Starter pages and emails are English.
  const languages = hasFeature(plan, "languages");
  // Language: ?lang (links, the Liquid switch), else the browser's, else
  // English. Routes that read a form apply its "lang" field (setLang).
  const asked = url.searchParams.get("lang");
  const explicit = isLocale(asked) ? asked : null;
  const opts: PageOptions = {
    prefix,
    appUrl: (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, ""),
    lang: languages ? (explicit ?? fromAcceptLanguage(request.headers.get("accept-language")) ?? "en") : "en",
    detectLang: languages && !explicit && request.method === "GET",
  };
  const setLang = (raw: unknown) => {
    if (languages && isLocale(raw)) {
      opts.lang = raw;
      opts.detectLang = false;
    }
  };
  const render = (html: string, status = 200) =>
    liquid(html, { status, headers: { "Cache-Control": "no-store" } });

  return {
    admin,
    shop,
    setLang,
    /** The page's strings (after setLang). */
    t: () => DICTS[opts.lang as Locale],
    prefix,
    customerId,
    row,
    plan,
    /** As the plan may use them (gates.ts). */
    claimSettings: settings ? effectiveClaimSettings(settings.claims, plan) : null,
    coverage: settings?.coverage,
    opts,
    render,
    available: !!admin && !!row && !row.uninstalledAt && !!settings?.claims.enabled,
  };
}

export type UploadedFile = { pathname: string; name: string; contentType: string; size: number };

/**
 * The files the browser says it uploaded (hidden "files" inputs). Each must
 * sit under this order's prefix and actually exist in Blob storage; the
 * size and type recorded are the store's, not the browser's.
 */
export async function verifiedFiles(form: FormData, shop: string, orderId: string): Promise<UploadedFile[]> {
  const seen = new Set<string>();
  const out: UploadedFile[] = [];
  for (const raw of form.getAll("files").slice(0, MAX_FILES_PER_MESSAGE)) {
    let f: { pathname?: unknown; name?: unknown };
    try {
      f = JSON.parse(String(raw));
    } catch {
      continue;
    }
    const pathname = typeof f.pathname === "string" ? f.pathname : "";
    if (!pathnameAllowed(pathname, shop, orderId) || seen.has(pathname)) continue;
    seen.add(pathname);
    const info = await blobInfo(pathname);
    if (!info || info.size > MAX_UPLOAD_BYTES || !UPLOAD_TYPES.includes(info.contentType)) continue;
    const name = (typeof f.name === "string" ? f.name : pathname.split("/").pop()!).slice(0, 120);
    out.push({ pathname, name, contentType: info.contentType, size: info.size });
  }
  return out;
}
