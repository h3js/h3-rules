// Every export must stay tree-shakeable, including namespace member access
// (`import * as rules from "h3-rules"; rules.xyz`): no module-level side
// effects, `/* @__PURE__ */` on module-scope instantiations. Pinned by
// test/treeshake.test.ts.

export { routeRules } from "./h3.ts";
export type { RouteRulesOptions } from "./h3.ts";

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

export { normalizeRouteRules } from "./normalize.ts";

export { mergeMatchedRouteRules } from "./merge.ts";
export type { RouteRuleEntry, RouteRuleLayer } from "./merge.ts";

export { ruleHandlers } from "./rules/index.ts";
export { headers } from "./rules/headers.ts";
export { redirect } from "./rules/redirect.ts";
export { basicAuth } from "./rules/basic-auth.ts";
export { cors } from "./rules/cors.ts";
// `proxy`/`cache` handlers are opt-in subpaths (h3-rules/proxy, h3-rules/cache)
// so proxyRequest/ocache stay out of bundles that don't use them; this factory
// builds a cache handler from an injected `defineCachedHandler`.
export { createCacheRuleHandler } from "./rules/cache.ts";
export type { CacheRuleHandlerOptions, DefineCachedHandler } from "./rules/cache.ts";

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
