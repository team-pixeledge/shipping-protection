import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const TARGETS = [
  "extensions/protection-validation/src/pricing.ts",
  "extensions/protection-transform/src/pricing.ts",
  "extensions/protection-checkout/src/pricing.ts",
];

test.each(TARGETS)("%s matches shared/pricing.ts (run npm run sync:shared)", (target) => {
  const src = readFileSync("shared/pricing.ts", "utf8");
  const copy = readFileSync(target, "utf8");
  expect(copy.slice(copy.indexOf("\n") + 1)).toBe(src);
});
