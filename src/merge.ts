import type { PreMergedRouteRules } from "./internal/premerge.ts";
import type { MatchedRouteRule, MatchedRouteRules } from "./types.ts";

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
 * Dual-path merge + union. Resolve the raw (served) path and,
 * if provided, the canonical (decoded) path independently — so a rule's `false`
 * reset only affects the path it is configured for — then union: the canonical
 * pass can **add or override, never delete**, a rule the raw path resolved. On
 * overlap the canonical rule wins (it is applied last), regardless of whether
 * its pattern is more or less specific than the raw match.
 *
 * Pure: the caller supplies already-matched layers (least → most specific).
 */
export function mergeMatchedRouteRules(
  rawLayers: RouteRuleLayer[] | undefined,
  canonicalLayers?: RouteRuleLayer[] | undefined,
): MatchedRouteRules {
  const routeRules = resolveLayers(rawLayers);
  if (canonicalLayers?.length) {
    const canonicalRules = resolveLayers(canonicalLayers);
    for (const name in canonicalRules) {
      const rule = canonicalRules[name as keyof MatchedRouteRules]!;
      mergeRouteRule(routeRules, rule, rule.params);
    }
  }
  return routeRules;
}

// Resolve the matched layers (least → most specific) of a single path into a
// set of route rules. Resolving each path (raw / canonical) with its own call
// keeps a `false` reset from leaking across paths.
function resolveLayers(layers: RouteRuleLayer[] | undefined): MatchedRouteRules {
  const lastData = layers?.[layers.length - 1]?.data;
  if (lastData && !Array.isArray(lastData)) {
    return resolvePreMergedLayers(layers!, lastData);
  }
  const routeRules: MatchedRouteRules = {};
  for (const layer of layers || []) {
    for (const entry of layer.data as RouteRuleEntry[]) {
      mergeRouteRule(routeRules, entry, layer.params);
    }
  }
  return routeRules;
}

// preMerge mode: the most specific matched layer already carries the fully
// merged chain result — only per-rule params (path-dependent) are attached
// here, merged from exactly the layers whose pattern contributed to the rule
// (same result as the per-request merge, without the merge).
function resolvePreMergedLayers(
  layers: RouteRuleLayer[],
  lastData: PreMergedRouteRules,
): MatchedRouteRules {
  const routeRules: MatchedRouteRules = {};
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
export function mergeRouteRule(
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
    if (isMergeableObject(currentRule.options) && isMergeableObject(rule.options)) {
      // Merge nested rule objects
      currentRule.options = { ...currentRule.options, ...rule.options } as never;
    } else {
      // Override rule if non-object
      currentRule.options = rule.options as never;
    }
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

// `typeof null === "object"`: without this guard a more specific `null` option
// would spread-merge into an inherited object (keeping it) instead of
// overriding it. Shared with the build-time chain merge (premerge).
export function isMergeableObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
