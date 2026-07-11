// Everything exported here must stay tree-shakeable — incl. via namespace
// member access (`import * as rules from "h3-rules"; rules.xyz`): no
// module-level side effects, `/* @__PURE__ */` on module-scope instantiations.
// Pinned by test/treeshake.test.ts.

// h3 middleware (headline API)
export { routeRules } from "./h3.ts";

// Runtime matcher
export {
  createRouteRulesMatcher,
  createMatcherFromFind,
  memoizeRouteRulesMatcher,
} from "./match.ts";

export type {
  RouteRulesMatcher,
  RouteRulesMatcherOptions,
  MatcherMemoizeOptions,
  FindRouteRules,
} from "./match.ts";

// Normalization
export { normalizeRouteRules } from "./normalize.ts";

// Merge algorithm (pure)
export { mergeMatchedRouteRules } from "./merge.ts";
export type { RouteRuleEntry, RouteRuleLayer } from "./merge.ts";

// Rule handlers
export { ruleHandlers } from "./rules/index.ts";
export { headers } from "./rules/headers.ts";
export { redirect } from "./rules/redirect.ts";
export { proxy } from "./rules/proxy.ts";
export { basicAuth } from "./rules/basic-auth.ts";
// The ocache-backed `cache` handler lives in the `h3-rules/cache` subpath;
// this factory builds one from an injected `defineCachedHandler`.
export { createCacheRuleHandler } from "./rules/cache.ts";
export type { CacheRuleHandlerOptions, DefineCachedHandler } from "./rules/cache.ts";

// Types
export type {
  RouteRuleConfig,
  RouteRules,
  CacheRuleOptions,
  RedirectRuleOptions,
  ProxyRuleOptions,
  MatchedRouteRule,
  MatchedRouteRules,
  MatchResult,
  RuleHandler,
  RuleHandlers,
  HTTPStatus,
} from "./types.ts";
