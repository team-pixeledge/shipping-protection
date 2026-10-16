import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("the function's pricing.ts matches shared/pricing.ts (run npm run sync:shared)", () => {
  const src = readFileSync("shared/pricing.ts", "utf8");
  const copy = readFileSync("extensions/protection-validation/src/pricing.ts", "utf8");
  expect(copy.slice(copy.indexOf("\n") + 1)).toBe(src);
});
