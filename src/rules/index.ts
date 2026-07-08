import type { RuleHandlers } from "../types.ts";
import { basicAuth } from "./basic-auth.ts";
import { cache } from "./cache.ts";
import { headers } from "./headers.ts";
import { proxy } from "./proxy.ts";
import { redirect } from "./redirect.ts";

// Note: keep RUNTIME_RULE_NAMES (src/compiler.ts) in sync when adding rules,
// and export the handler from src/index.ts (compiled matchers import used
// handlers by name).

/**
 * Default rule handler registry (base for runtime matchers). The `cache` entry
 * is the shared default instance with module-scoped memoization; runtime
 * matchers replace it with an instance-scoped handler (see
 * `createRouteRulesMatcher`).
 */
export const ruleHandlers: RuleHandlers = {
  headers,
  redirect,
  proxy,
  cache,
  basicAuth,
};
