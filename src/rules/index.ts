import type { RuleHandlers } from "../types.ts";
import { basicAuth } from "./basic-auth.ts";
import { headers } from "./headers.ts";
import { proxy } from "./proxy.ts";
import { redirect } from "./redirect.ts";

// Note: keep RUNTIME_RULE_NAMES (src/compiler/runtime-rules.ts) in sync when
// adding rules, and export the handler from src/index.ts (compiled matchers
// import used handlers by name).

/**
 * Default rule handler registry (base for runtime matchers). `cache` is
 * deliberately absent: its handler needs a caching implementation — register
 * the ocache-backed one from `h3-rules/cache` (`handlers: { cache }`) or build
 * your own with `createCacheRuleHandler` (see `src/rules/cache.ts`).
 */
export const ruleHandlers: RuleHandlers = {
  headers,
  redirect,
  proxy,
  basicAuth,
};
