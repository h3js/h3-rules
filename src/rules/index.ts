import type { RuleHandlers } from "../types.ts";
import { basicAuth } from "./basic-auth.ts";
import { cors } from "./cors.ts";
import { headers } from "./headers.ts";
import { redirect } from "./redirect.ts";

// Note: keep RUNTIME_RULE_NAMES (src/compiler/runtime-rules.ts) in sync when
// adding rules, and export the handler from src/index.ts (compiled matchers
// import used handlers by name).

/**
 * Default rule handler registry (base for runtime matchers). Two built-ins are
 * deliberately absent — each is an opt-in subpath export so its dependency stays
 * out of bundles that don't use it:
 * - `cache`: needs a caching implementation — register the ocache-backed one
 *   from `h3-rules/cache` (`handlers: { cache }`) or build your own with
 *   `createCacheRuleHandler` (see `src/rules/cache.ts`).
 * - `proxy`: pulls in h3's `proxyRequest` — register it from `h3-rules/proxy`
 *   (`handlers: { proxy }`, see `src/proxy.ts`).
 *
 * `createRouteRulesMatcher` throws when a rule set uses either without a
 * registered handler (pass `handlers: { cache: undefined }` / `{ proxy: undefined }`
 * to opt into data-only).
 */
export const ruleHandlers: RuleHandlers = {
  headers,
  redirect,
  basicAuth,
  cors,
};
