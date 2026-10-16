// Bundles widget/protection.ts (+ shared/pricing.ts) into the theme
// extension's asset. Theme assets are served as-is by Shopify's CDN, so this
// must run before `shopify app deploy` (npm run deploy does it).
import { build } from "esbuild";

await build({
  entryPoints: ["widget/protection.ts"],
  outfile: "extensions/protection-widget/assets/protection.js",
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2019"],
  legalComments: "none",
  banner: { js: "/* Shipping protection widget — built from widget/protection.ts, do not edit. */" },
  logLevel: "info",
});
