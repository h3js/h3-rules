// Type-level tests for the route-rule config surface. Validated by `pnpm
// typecheck` (tsgo) — a stray `@ts-expect-error` with no underlying error, or a
// failing `expectTypeOf`, fails the build. Not run by vitest (`.test-d.ts` does
// not match the runtime test glob); it declares no runtime behavior.
import { expectTypeOf } from "vitest";
import { normalizeRouteRules } from "../src/normalize.ts";
import { routeRules } from "../src/h3.ts";
import type { MatchedRouteRules, RouteRuleConfig, RouteRules } from "../src/types.ts";

// --- `RouteRuleConfig` is a closed interface: typos are compile errors ---

// A typo for `redirect` on a direct annotation.
// @ts-expect-error - unknown key `redirct` on the closed RouteRuleConfig
const typoRedirect: RouteRuleConfig = { redirct: "/new" };
void typoRedirect;

// A typo for `headers` on a direct annotation.
// @ts-expect-error - unknown key `header` on the closed RouteRuleConfig
const typoHeaders: RouteRuleConfig = { header: { a: "1" } };
void typoHeaders;

// The same typo inside a `routeRules({...})` config argument.
routeRules({
  // @ts-expect-error - unknown key `redirct` in the routeRules config
  "/old/**": { redirct: "/new" },
});

// ...and inside a `normalizeRouteRules({...})` config argument.
normalizeRouteRules({
  // @ts-expect-error - unknown key `header` in the normalizeRouteRules config
  "/api/**": { header: { a: "1" } },
});

// Known keys still type-check.
const known: RouteRuleConfig = {
  redirect: "/new",
  headers: { "x-a": "1" },
  cors: true,
  swr: 60,
  cache: false,
  basicAuth: { username: "u", password: "p" },
};
void known;

// --- Custom keys are re-enabled via module augmentation ---

declare module "../src/types.ts" {
  interface RouteRuleConfig {
    myPlugin?: { mode: "a" | "b" };
  }
  interface RouteRules {
    myPlugin?: { mode: "a" | "b" };
  }
}

// The augmented key type-checks in config (annotation + both entry points).
const augmented: RouteRuleConfig = { myPlugin: { mode: "a" } };
void augmented;
routeRules({ "/x": { myPlugin: { mode: "b" } } });
normalizeRouteRules({ "/x": { myPlugin: { mode: "b" } } });

// A wrong shape for the augmented key is still caught.
// @ts-expect-error - `mode` must be "a" | "b"
const augmentedBad: RouteRuleConfig = { myPlugin: { mode: "c" } };
void augmentedBad;

// ...and readable off the normalized `RouteRules` shape as the augmented type.
declare const normalized: RouteRules;
expectTypeOf(normalized.myPlugin).toEqualTypeOf<{ mode: "a" | "b" } | undefined>();

// It is also accessible off the matched-rule map. `MatchedRouteRules` stays
// intentionally open (its key domain is `string`, since `RouteRules` carries an
// index signature for arbitrary data-only rules), so a matched rule's `options`
// widen to `unknown` — augmented or not; the key is reachable without a cast.
declare const matched: MatchedRouteRules;
expectTypeOf(matched.myPlugin?.options).toEqualTypeOf<unknown>();
