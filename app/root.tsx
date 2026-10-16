import type { ReactNode } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

// Embedded-app reload recovery. Shopify opens the app with ?shop&host; React
// Router's later navigations drop them from the iframe URL. If the page is
// then hard-reloaded from inside the iframe (a stale JS chunk after a
// deploy), the server gets /app/... with no shop and can't authenticate —
// the merchant saw a bare "200" (2026-10-14). So: remember shop/host from
// the first load in this tab, and on a param-less /app reload put them back
// once (sp-r guards against loops); Shopify's session-token bounce then
// fetches a fresh token as on any first load.
const RELOAD_GUARD = `(function () {
  try {
    var u = new URL(location.href), k = "sp-embed", p = u.searchParams;
    if (p.get("shop") && p.get("host")) {
      sessionStorage.setItem(k, JSON.stringify({ shop: p.get("shop"), host: p.get("host") }));
      return;
    }
    if (window.top === window || !/^\\/app(\\/|$)/.test(u.pathname) || p.get("sp-r")) return;
    var s = JSON.parse(sessionStorage.getItem(k) || "null");
    if (!s || !s.shop || !s.host) return;
    p.set("shop", s.shop); p.set("host", s.host); p.set("embedded", "1"); p.set("sp-r", "1");
    location.replace(u.toString());
  } catch (e) {}
})();`;

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: RELOAD_GUARD }} />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

// Last resort when a route can't render (React Router's default printed
// just the status, e.g. "200"). Never shows error details to merchants.
export function ErrorBoundary() {
  return (
    <div style={{ font: "15px/1.5 Inter, -apple-system, sans-serif", margin: 40, maxWidth: 520 }}>
      <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Shipping Protection needs a moment</h1>
      <p style={{ margin: 0, color: "#4a4a4a" }}>
        The app was updated or your session expired. Open Shipping Protection again from
        the Apps menu in your Shopify admin. If this keeps happening, email us and
        we&apos;ll take a look.
      </p>
    </div>
  );
}
