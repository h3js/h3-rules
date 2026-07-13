import type { PreMergedRouteRules } from "./internal/premerge.ts";
import type { MatchedRouteRule, MatchedRouteRules } from "./types.ts";

/**
 * Whether an alternate (canonical / slash-merged) reading's rule may override an
 * already-resolved rule of the same name: `true` only when the incoming rule's
 * matched pattern is equal to, or strictly more specific than, the current one.
 * Injected (not imported) so `merge.ts` stays free of `rou3` and compiled
 * matchers that don't wire it remain tree-shakeable. When omitted the union keeps
 * its historical unconditional-override behavior.
 */
export type RouteOverridePredicate = (currentRoute: string, incomingRoute: string) => boolean;

/**
 * A single rule entry as stored in the matcher (one per rule name of a pattern).
 * This is the unit produced by exploding a normalized `RouteRules` object and the
 * shape carried in each rou3 layer's `.data` array (also emitted by the compiler).
 */
export interface RouteRuleEntry {
  name: string;
  route: string;
  method?: string;
  options: unknown;
  handler?: MatchedRouteRule["handler"];
}

/**
 * A matched rou3 layer: the entries registered for a pattern plus its params.
 * Data is either a plain entry array (merged per request) or a pre-merged layer
 * (`preMerge` mode — the most specific matched layer is the full result).
 */
export interface RouteRuleLayer {
  data: RouteRuleEntry[] | PreMergedRouteRules;
  params?: Record<string, string>;
}

/**
 * Multi-path merge + union. Resolve the raw (served) path and, if provided, the
 * canonical (decoded) path and the slash-merged canonical path independently — so
 * a rule's `false` reset only affects the path it is configured for — then union
 * in order: each later pass can **add or override, never delete**, a rule an
 * earlier path resolved. On overlap the later (more decoded) rule wins **only when
 * `canOverride` allows it** — its pattern must be equal to, or more specific than,
 * the current one — so a narrower canonical gate wins but a broader canonical
 * pattern can never downgrade a narrower rule the served path resolved (see
 * {@link unionLayers}). Omitting `canOverride` keeps the historical unconditional
 * override. The merged-canonical pass mirrors the second interpretation
 * `isPathInScope` uses: it recovers a narrower gate on the path a slash-merging
 * downstream would resolve (a `..` next to an encoded separator whose empty
 * segment h3's canonical form otherwise keeps).
 *
 * Pure: the caller supplies already-matched layers (least → most specific) and the
 * (pure) `canOverride` specificity predicate.
 */
export function mergeMatchedRouteRules(
  rawLayers: RouteRuleLayer[] | undefined,
  canonicalLayers?: RouteRuleLayer[] | undefined,
  mergedLayers?: RouteRuleLayer[] | undefined,
  canOverride?: RouteOverridePredicate,
): MatchedRouteRules {
  const routeRules = resolveLayers(rawLayers);
  unionLayers(routeRules, canonicalLayers, canOverride);
  unionLayers(routeRules, mergedLayers, canOverride);
  return routeRules;
}

// Union one alternate reading's resolved rules onto the accumulated set. Each
// reading is resolved on its own (so its `false` resets stay local), then merged
// in — add or override only, since a resolved set never carries a `false` option.
//
// Security: a later (more decoded) pass may **add** a rule the served path missed,
// but may **override** one it already resolved *only when `canOverride` allows it*
// — i.e. the incoming pattern is equal to, or strictly more specific than, the
// current one (the narrower canonical gate winning — e.g. `/app/admin/**` auth over
// a broad `/app/**` rule for `/app/admin%2fpanel`). It must NOT let a *broader*
// canonical pattern override a narrower rule the served (raw) path already
// resolved: a crafted encoded-dot path can canonicalize *up* to a broad pattern
// (`/app/admin/x/%2e%2e/%2e%2e/%2e%2e/y` → `/y`), and letting that broad rule win
// would downgrade the strict gate the served admin path actually hits. When the
// two patterns are not orderable by containment (`disjoint`/`partial`), `canOverride`
// fails closed and keeps the served path's rule. Callers that don't inject a
// predicate keep the historical unconditional-override behavior.
function unionLayers(
  routeRules: MatchedRouteRules,
  layers: RouteRuleLayer[] | undefined,
  canOverride?: RouteOverridePredicate,
): void {
  if (!layers?.length) {
    return;
  }
  const resolved = resolveLayers(layers);
  for (const rule of Object.values(resolved) as MatchedRouteRule[]) {
    const current = routeRules[rule.name as keyof MatchedRouteRules];
    if (current && canOverride && !canOverride(current.route, rule.route)) {
      continue;
    }
    mergeRouteRule(routeRules, rule, rule.params);
  }
}

// Resolve the matched layers (least → most specific) of a single path into a
// set of route rules. Resolving each path (raw / canonical) with its own call
// keeps a `false` reset from leaking across paths.
function resolveLayers(layers: RouteRuleLayer[] | undefined): MatchedRouteRules {
  const lastData = layers?.[layers.length - 1]?.data;
  if (lastData && !Array.isArray(lastData)) {
    return resolvePreMergedLayers(layers!, lastData);
  }
  const routeRules = emptyRouteRules();
  for (const layer of layers || []) {
    for (const entry of layer.data as RouteRuleEntry[]) {
      mergeRouteRule(routeRules, entry, layer.params);
    }
  }
  return routeRules;
}

// `typeof null === "object"`: without this guard a more specific `null` option
// would spread-merge into an inherited object (keeping it) instead of
// overriding it. Shared with the build-time chain merge (premerge).
export function isMergeableObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

// The accumulator every path resolves into is keyed by **rule name**, which is
// attacker-influenceable config (rule names become property keys). A null
// prototype makes a name like `__proto__`/`constructor`/`prototype` a plain own
// key: without it `routeRules["__proto__"]` reads the inherited `Object.prototype`
// getter (truthy), so `mergeRouteRule` would take the update branch and assign
// `currentRule.options`/`route`/`method` **directly onto `Object.prototype`** —
// a process-wide prototype-pollution DoS. `Object.values`/`entries`/`keys`
// (used downstream) all work on null-proto objects.
function emptyRouteRules(): MatchedRouteRules {
  return Object.create(null) as MatchedRouteRules;
}

// THE core option-merge rule, shared by every merge site (runtime layer merge
// below, build-time chain pre-merge in `src/internal/premerge.ts`, and the
// canonical-key collision merge in `src/normalize.ts`): two object options
// shallow-merge with the incoming (more specific / later) keys winning;
// anything else — non-objects, `null`, arrays-in-objects as leaf values —
// overrides wholesale. The `false`-delete branch stays local to each caller
// (their rule containers differ: record vs `Map`). Internal: not re-exported
// from `src/index.ts`.
export function mergeRuleOptions(current: unknown, incoming: unknown): unknown {
  return isMergeableObject(current) && isMergeableObject(incoming)
    ? { ...current, ...incoming }
    : incoming;
}

// ------------------------------------------------------------------------
// Internal
// ------------------------------------------------------------------------

// preMerge mode: the most specific matched layer already carries the fully
// merged chain result — only per-rule params (path-dependent) are attached
// here, merged from exactly the layers whose pattern contributed to the rule
// (same result as the per-request merge, without the merge).
function resolvePreMergedLayers(
  layers: RouteRuleLayer[],
  lastData: PreMergedRouteRules,
): MatchedRouteRules {
  const routeRules = emptyRouteRules();
  for (const entry of lastData.rules) {
    const paramRoutes = entry.paramRoutes;
    let params: Record<string, string> | undefined;
    for (const layer of layers) {
      const layerParams = layer.params;
      if (!layerParams) {
        continue;
      }
      const layerRoute = (layer.data as PreMergedRouteRules).route;
      if (paramRoutes ? paramRoutes.includes(layerRoute) : layerRoute === entry.route) {
        // rou3 creates fresh params objects per lookup — safe to use directly
        // for a single contributor.
        params = params ? { ...params, ...layerParams } : layerParams;
      }
    }
    routeRules[entry.name as keyof MatchedRouteRules] = {
      name: entry.name,
      route: entry.route,
      method: entry.method,
      options: entry.options,
      handler: entry.handler,
      params,
    } as never;
  }
  return routeRules;
}

// Apply one rule (a matched layer entry or a resolved rule from the other path)
// onto the accumulated set. `false` resets an inherited rule; otherwise options
// are merged (objects) or overridden, with the incoming — more specific or later
// — rule winning. `route`/`params` always take the more specific match's values.
function mergeRouteRule(
  routeRules: MatchedRouteRules,
  rule: RouteRuleEntry | MatchedRouteRule,
  params: Record<string, string> | undefined,
): void {
  const name = rule.name as keyof MatchedRouteRules;
  const currentRule = routeRules[name];
  if (currentRule) {
    if (rule.options === false) {
      // Remove/reset existing rule with `false` value
      delete routeRules[name];
      return;
    }
    // Merge nested rule objects, override non-objects
    currentRule.options = mergeRuleOptions(currentRule.options, rule.options) as never;
    // Routing (route and params)
    currentRule.route = rule.route;
    currentRule.method = rule.method;
    if (currentRule.params || params) {
      currentRule.params = { ...currentRule.params, ...params };
    }
  } else if (rule.options !== false) {
    routeRules[name] = { ...(rule as MatchedRouteRule), params } as never;
  }
}
