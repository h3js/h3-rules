import { addRoute, createRouter, findAllRoutes } from "rou3";
import type { RouterContext } from "rou3";
import { createCacheRuleHandler } from "./rules/cache.ts";
import type { CacheRuleOptions } from "./rules/cache.ts";
import { parseRouteKey } from "./internal/key.ts";
import { mergeMatchedRouteRules } from "./merge.ts";
import type { RouteRuleEntry, RouteRuleLayer } from "./merge.ts";
import { preMergeRuleLayers } from "./internal/premerge.ts";
import type { PreMergedRouteRules } from "./internal/premerge.ts";
import { ruleHandlers } from "./rules/index.ts";
import { canonicalPath } from "./internal/scope.ts";
import type {
  MatchResult,
  MatchedRouteRule,
  MatchedRouteRules,
  RouteRules,
  RuleHandlers,
} from "./types.ts";

export interface RouteRulesMatcherOptions {
  /**
   * Base URL prefix for all rule patterns (trailing slash trimmed), matching
   * Nitro's `Router` constructor behavior.
   */
  baseURL?: string;
  /**
   * Add or override rule handler constructors by name. Built-ins (`headers`,
   * `redirect`, `proxy`, `cache`, `basicAuth`) are registry defaults; setting a
   * name to `undefined` makes that rule data-only.
   */
  handlers?: RuleHandlers;
  /** Cache rule wiring (ocache options / storage / full replacement). */
  cache?: CacheRuleOptions;
  /**
   * Memoize match results per `method + pathname` (see
   * {@link memoizeRouteRulesMatcher}). For a given path the merged result is
   * fully deterministic, so this skips the rule lookup, canonicalization, merge,
   * and middleware construction on repeat requests. `true` uses the default
   * entry cap; pass `{ max }` to tune it.
   */
  memoize?: boolean | MatcherMemoizeOptions;
  /**
   * Pre-merge each pattern's subsumption chain at startup so per-request
   * resolution takes only the most specific matched layer instead of merging
   * all layers. Exact — but requires a **chain-clean** rule set: throws at
   * startup if two patterns partially overlap (e.g. `/a/*​/c` vs `/a/b/*`) or
   * use patterns that cannot be analyzed (regex params). Composes with
   * `memoize`.
   */
  preMerge?: boolean;
}

export interface MatcherMemoizeOptions {
  /**
   * Maximum number of memoized `method + pathname` entries. On overflow the
   * oldest entry is evicted (FIFO). `0` (or negative) disables memoization.
   * @default 1024
   */
  max?: number;
}

export type RouteRulesMatcher = (method: string, pathname: string) => MatchResult;

/** A `findAllRoutes`-compatible lookup, as produced by `rou3/compiler` codegen. */
export type FindRouteRules = (method: string, pathname: string) => RouteRuleLayer[];

// Default rule handler registry. `cache` is created per matcher instance so its
// handler memoization is instance-scoped (see src/rules/cache.ts).
function createDefaultHandlers(opts?: RouteRulesMatcherOptions): RuleHandlers {
  return {
    ...ruleHandlers,
    cache: createCacheRuleHandler(opts?.cache),
    ...opts?.handlers,
  };
}

/**
 * Explode a normalized rule set into per-rule entries and register them on a
 * rou3 router (method `""` = all methods, matching Nitro's registration).
 *
 * rou3 resolves `methods[method] || methods[""]` per node, so a method-scoped
 * registration would *shadow* a method-agnostic rule on the same pattern. To get
 * the documented precedence instead — method-scoped rules merge **after** (i.e.
 * override, not replace) method-agnostic rules for the same pattern — the
 * agnostic entries are prepended to each method-scoped registration of the same
 * path. Method-agnostic-only rule sets (all Nitro-generated configs) are
 * unaffected.
 */
export function createRulesRouter(
  rules: Record<string, RouteRules>,
  handlers: RuleHandlers,
  baseURL?: string,
  preMerge?: boolean,
): RouterContext<RouteRuleEntry[] | PreMergedRouteRules> {
  let base = baseURL || "";
  if (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  // Explode each rule into per-name entries, grouped by (method, path)
  const byPath = new Map<string, Map<string, RouteRuleEntry[]>>();
  for (const key in rules) {
    const { method, path } = parseRouteKey(key);
    const rule = rules[key]!;
    const entries: RouteRuleEntry[] = [];
    for (const [name, options] of Object.entries(rule)) {
      if (options === undefined) {
        continue;
      }
      entries.push({
        name,
        route: path,
        method: method || undefined,
        options: base ? withScopeBase(name, options, base) : options,
        handler: handlers[name] as MatchedRouteRule["handler"],
      });
    }
    let methods = byPath.get(path);
    if (!methods) {
      byPath.set(path, (methods = new Map()));
    }
    methods.set(method, [...(methods.get(method) || []), ...entries]);
  }
  const router = createRouter<RouteRuleEntry[] | PreMergedRouteRules>();
  if (preMerge) {
    for (const [path, methods] of preMergeRuleLayers(byPath)) {
      for (const [method, data] of methods) {
        addRoute(router, method, base + path, data);
      }
    }
    return router;
  }
  for (const [path, methods] of byPath) {
    const agnostic = methods.get("");
    for (const [method, entries] of methods) {
      const data = method && agnostic ? [...agnostic, ...entries] : entries;
      addRoute(router, method, base + path, data);
    }
  }
  return router;
}

// The `redirect`/`proxy` scope check (`resolveRuleTarget`) runs against the full
// request path, which includes the `baseURL` prefix the patterns are registered
// under — compose it into the normalized `base` (fresh options object; the
// normalized rule set is never mutated) so `/**` targets validate and strip
// correctly for a mounted rule set.
function withScopeBase(name: string, options: unknown, baseURL: string): unknown {
  if (
    (name === "redirect" || name === "proxy") &&
    options !== null &&
    typeof options === "object" &&
    typeof (options as { base?: unknown }).base === "string"
  ) {
    return { ...options, base: baseURL + (options as { base: string }).base };
  }
  return options;
}

/**
 * Create a route-rules matcher from a **normalized** rule set (see
 * {@link normalizeRouteRules}). Returns `(method, pathname) =>
 * { routeRules, routeRuleMiddleware }`.
 */
export function createRouteRulesMatcher(
  rules: Record<string, RouteRules>,
  opts?: RouteRulesMatcherOptions,
): RouteRulesMatcher {
  const handlers = createDefaultHandlers(opts);
  const router = createRulesRouter(rules, handlers, opts?.baseURL, opts?.preMerge);
  const findRouteRules: FindRouteRules = (method, pathname) =>
    findAllRoutes(router, method, pathname) as RouteRuleLayer[];
  return createMatcherFromFind(findRouteRules, opts);
}

/**
 * Create a matcher from a `findAllRoutes`-compatible lookup — the integration
 * point for compiled matchers (`h3-rules/compiler` output). Runtime and compiled
 * matchers share this exact code path, so they produce identical results.
 * Accepts the `memoize` matcher option.
 */
export function createMatcherFromFind(
  findRouteRules: FindRouteRules,
  opts?: Pick<RouteRulesMatcherOptions, "memoize">,
): RouteRulesMatcher {
  const matcher: RouteRulesMatcher = (method, pathname) =>
    getRouteRules(findRouteRules, method, pathname);
  return opts?.memoize
    ? memoizeRouteRulesMatcher(matcher, opts.memoize === true ? undefined : opts.memoize)
    : matcher;
}

/**
 * Memoize a matcher per `method + pathname`. Exact: for a given path the merged
 * result (params included) is fully deterministic, so repeat requests skip both
 * rule lookups, `canonicalPath`, the merge, and middleware construction — a hot
 * path becomes a single map lookup.
 *
 * Memoized results are **shared across requests**: treat the returned
 * `routeRules` map and middleware array as immutable (rule `options` objects are
 * shared with the registered rule data either way). Entries are capped
 * (default 1024) with FIFO eviction, so unbounded dynamic paths cannot grow the
 * cache indefinitely — an evicted path is simply re-resolved on its next hit.
 */
export function memoizeRouteRulesMatcher(
  matcher: RouteRulesMatcher,
  opts?: MatcherMemoizeOptions,
): RouteRulesMatcher {
  const max = opts?.max ?? 1024;
  if (max <= 0) {
    // A non-positive cap means no caching, not a cap of 1.
    return matcher;
  }
  const memo = new Map<string, MatchResult>();
  return (method, pathname) => {
    const key = method + " " + pathname;
    let result = memo.get(key);
    if (!result) {
      result = matcher(method, pathname);
      if (memo.size >= max) {
        memo.delete(memo.keys().next().value!);
      }
      memo.set(key, result);
    }
    return result;
  };
}

function getRouteRules(
  findRouteRules: FindRouteRules,
  method: string,
  pathname: string,
): MatchResult {
  // h3 routes the served handler/middleware on the raw `pathname` (`%2f`/`%5c`
  // stay opaque), so the rules the raw path matches describe the handler that
  // actually runs and must all apply.
  const rawLayers = findRouteRules(method, pathname);

  // An encoded separator must not let a request dodge a rule it would still hit
  // once the downstream decodes `%2f`/`%5c` back to `/` — e.g. `/app/admin%2fpanel`
  // is served by a broad rule on the raw path but canonicalizes to
  // `/app/admin/panel`, which a narrower (auth) rule guards.
  // So also match on the canonical path. Fast path: identical paths skip the
  // second lookup.
  const canonical = canonicalPath(pathname);
  const canonicalLayers = canonical === pathname ? undefined : findRouteRules(method, canonical);

  if (!rawLayers?.length && !canonicalLayers?.length) {
    return { routeRules: {}, routeRuleMiddleware: [] };
  }

  // Resolve each path independently so a rule's `false` reset only affects the
  // path it is configured for, then union the two: a rule applies if the served
  // (raw) or the decoded (canonical) path enables it. The canonical pass can only
  // add or override — never delete — a rule the served path resolved, so an
  // encoded separator can neither dodge a rule nor strip one off the path that is
  // actually served. On overlap the canonical rule wins because it is applied
  // last (e.g. the `/app/admin/**` auth gate over a broad `/app/**` rule for
  // `/app/admin%2fpanel`) — this is unconditional, not a specificity comparison,
  // so a canonical match from a broader pattern also overrides the raw options.
  // Proxy/redirect still forward the raw `event.url.pathname`.
  const routeRules = mergeMatchedRouteRules(rawLayers, canonicalLayers);

  return { routeRules, routeRuleMiddleware: createRuleMiddleware(routeRules) };
}

/**
 * Build the ordered middleware array from merged rules. Rules without a handler
 * (data-only) are skipped; handlers run sorted by `handler.order ?? 0` ascending
 * (`basicAuth` has `order: -1` so unauthorized requests are neither redirected
 * nor proxied; `headers` is also `order: -1` so it runs outer to `cache`/
 * `redirect`/`proxy` and its headers land on the final response — see
 * `src/rules/headers.ts`).
 */
function createRuleMiddleware(routeRules: MatchedRouteRules): MatchResult["routeRuleMiddleware"] {
  const middleware: MatchResult["routeRuleMiddleware"] = [];
  const orderedRules = (Object.values(routeRules) as MatchedRouteRule[]).sort(
    (a, b) => (a.handler?.order || 0) - (b.handler?.order || 0),
  );
  for (const rule of orderedRules) {
    // merged rule sets never contain `false` options (types.ts: MatchedRouteRule)
    if (!rule.handler) {
      continue;
    }
    middleware.push(rule.handler(rule));
  }
  return middleware;
}
