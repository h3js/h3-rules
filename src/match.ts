import { addRoute, createRouter, findAllRoutes } from "rou3";
import type { RouterContext } from "rou3";
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
  RouteRules,
  RuleHandler,
  RuleHandlers,
} from "./types.ts";

export interface RouteRulesMatcherOptions {
  /**
   * Base URL prefix for all rule patterns (trailing slash trimmed).
   */
  baseURL?: string;
  /**
   * Add or override rule handler constructors by name.
   * Registry defaults are `headers`, `redirect`, `basicAuth`; `cache` and
   * `proxy` are opt-in (register them from `h3-rules/cache` / `h3-rules/proxy`).
   * Setting a name to `undefined` makes that rule data-only.
   */
  handlers?: RuleHandlers;
  /**
   * Pre-merge each pattern's subsumption chain at startup so per-request
   * resolution takes only the most specific matched layer instead of merging
   * all layers. Exact — but requires a **chain-clean** rule set: throws at
   * startup if two patterns partially overlap (e.g. `/a/*​/c` vs `/a/b/*`) or
   * use patterns that cannot be analyzed (regex params).
   * Composes with {@link memoizeRouteRulesMatcher}.
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
  for (const [key, rule] of Object.entries(rules)) {
    const { method, path } = parseRouteKey(key);
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

/**
 * Create a route-rules matcher from a **normalized** rule set (see {@link normalizeRouteRules}).
 * Returns `(method, pathname) => { routeRules, routeRuleMiddleware }`.
 */
export function createRouteRulesMatcher(
  rules: Record<string, RouteRules>,
  opts?: RouteRulesMatcherOptions,
): RouteRulesMatcher {
  // Default rule handler registry. `cache` and `proxy` have no default handler —
  // each is an opt-in subpath export (`h3-rules/cache` / `h3-rules/proxy`) so its
  // dependency stays out of bundles that don't use it. A rule set that uses one
  // without a registered handler would silently degrade to a data-only rule, so
  // fail loudly at construction; an explicit `handlers: { <name>: undefined }`
  // opts into data-only.
  const handlers = {
    ...ruleHandlers,
    ...opts?.handlers,
  };
  requireOptInHandler(
    rules,
    handlers,
    "cache",
    "cache`/`swr",
    'Install `ocache` and pass `handlers: { cache }` from "h3-rules/cache", provide your own ' +
      "via `createCacheRuleHandler`, or pass `handlers: { cache: undefined }` to keep the rule data-only.",
  );
  requireOptInHandler(
    rules,
    handlers,
    "proxy",
    "proxy",
    'Pass `handlers: { proxy }` from "h3-rules/proxy", or `handlers: { proxy: undefined }` ' +
      "to keep the rule data-only.",
  );

  const router = createRulesRouter(rules, handlers, opts?.baseURL, opts?.preMerge);

  const findRouteRules: FindRouteRules = (method, pathname) =>
    findAllRoutes(router, method, pathname) as RouteRuleLayer[];

  // Memoization is opt-in via {@link memoizeRouteRulesMatcher} — wrap the
  // returned matcher explicitly. Keeping it decoupled from this constructor (and
  // from createMatcherFromFind) lets an un-memoized bundle tree-shake it away.
  return createMatcherFromFind(findRouteRules);
}

/**
 * Create a matcher from a `findAllRoutes`-compatible lookup — the integration
 * point for compiled matchers (`h3-rules/compiler` output). Runtime and compiled
 * matchers share this exact code path, so they produce identical results.
 *
 * Memoization is intentionally **not** wired in here: keeping the reference out
 * of this function lets an un-memoized compiled bundle tree-shake
 * {@link memoizeRouteRulesMatcher} away. Opt in by composing it explicitly —
 * `memoizeRouteRulesMatcher(createMatcherFromFind(findRouteRules))`. The same
 * composition wraps the matcher from `createRouteRulesMatcher`.
 */
export function createMatcherFromFind(findRouteRules: FindRouteRules): RouteRulesMatcher {
  return (method, pathname) => {
    // h3 routes the served handler/middleware on the raw `pathname` (`%2f`/`%5c` stay opaque)
    // so the rules the raw path matches describe the handler that actually runs and must all apply.
    const rawLayers = findRouteRules(method, pathname);

    // An encoded separator must not let a request dodge a rule it would still hit
    // once the downstream decodes `%2f`/`%5c` back to `/`
    // e.g. `/app/admin%2fpanel` is served by a broad rule on the raw path but canonicalizes to
    // `/app/admin/panel`, which a narrower (auth) rule guards.
    // So also match on the canonical path. Fast path: identical paths skip the second lookup.
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

    // Build the ordered middleware array from merged rules. Rules without a
    // handler (data-only) are skipped; handlers run sorted by `order` ascending
    // (`"pre"` = -1, `"post"` = 1, default 0, or an explicit number) — `basicAuth`
    // is `"pre"` so unauthorized requests are neither redirected nor proxied;
    // `headers` is also `"pre"` so it runs outer to `cache`/`redirect`/`proxy` and
    // its headers land on the final response — see `src/rules/headers.ts`.
    const routeRuleMiddleware: MatchResult["routeRuleMiddleware"] = [];
    const orderedRules = (Object.values(routeRules) as MatchedRouteRule[]).sort(
      (a, b) => orderWeight(a.handler) - orderWeight(b.handler),
    );
    for (const rule of orderedRules) {
      // merged rule sets never contain `false` options (types.ts: MatchedRouteRule)
      if (!rule.handler) {
        continue;
      }
      routeRuleMiddleware.push(rule.handler.handler(rule));
    }

    return { routeRules, routeRuleMiddleware };
  };
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

// ------------------------------------------------------------------------
// Internal
// ------------------------------------------------------------------------

// Fail loudly when a rule set uses an opt-in rule (`cache`/`proxy`) but no
// handler for it is registered — otherwise the rule would silently degrade to a
// data-only rule (no caching / no proxying). A `false` reset is falsy, so a rule
// set whose only values are resets does not throw; an own `<name>` key in
// `handlers` (including `undefined`) opts out of the check.
function requireOptInHandler(
  rules: Record<string, RouteRules>,
  handlers: RuleHandlers,
  name: string,
  label: string,
  hint: string,
): void {
  if (name in handlers) {
    return;
  }
  for (const key in rules) {
    if (rules[key]![name]) {
      throw new Error(
        `[h3-rules] rules use \`${label}\` (\`${key}\`) but no \`${name}\` handler is registered. ${hint}`,
      );
    }
  }
}

// Sort weight for a handler's `order` (lower runs first): a `number` is used
// as-is, `"pre"` is -1, `"post"` is 1, and the default (omitted / data-only
// rules with no handler) is 0.
function orderWeight(handler: RuleHandler | undefined): number {
  const order = handler?.order;
  return typeof order === "number" ? order : order === "pre" ? -1 : order === "post" ? 1 : 0;
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
