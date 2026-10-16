// Bundles portal/claims-portal.ts (+ @vercel/blob's browser client) into
// public/claims-portal.js, which the storefront claims page loads from the
// app's domain. Runs before every build (npm run build / vercel-build / dev).
import { build } from "esbuild";

await build({
  entryPoints: ["portal/claims-portal.ts"],
  outfile: "public/claims-portal.js",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2019"],
  legalComments: "none",
  banner: { js: "/* SafeShip claims page — built from portal/claims-portal.ts, do not edit. */" },
  logLevel: "info",
});
