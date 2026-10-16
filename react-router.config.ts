import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

// Vercel now, AWS later: the preset only applies on a Vercel build (VERCEL=1
// is set by its build environment). Everywhere else — local, Docker, a future
// AWS container — this is a plain Node server build (`npm start`).
export default {
  ssr: true,
  // Embedded app: with lazy discovery, a deploy made React Router hard-reload
  // /app/... (after /__manifest answered 204) without Shopify's shop/host
  // params, and the page showed a bare "200". Ship the full route manifest
  // with the first document instead — it's a small app.
  routeDiscovery: { mode: "initial" },
  presets: process.env.VERCEL ? [vercelPreset()] : [],
} satisfies Config;
