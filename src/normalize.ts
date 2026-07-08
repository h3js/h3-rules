import { formatRouteKey, parseRouteKey } from "./internal/key.ts";
import { isMergeableObject } from "./merge.ts";
import type { RouteRuleConfig, RouteRules } from "./types.ts";

/**
 * Normalize user route-rule config into runtime rules.
 *
 * Expands shortcuts (`swr`, `cors`), resolves `redirect`/`proxy` string forms,
 * and attaches a first-class `base` field to `/**` redirect/proxy rules. Keys
 * may carry a `"METHOD /path"` prefix (see {@link parseRouteKey}); the returned
 * map is re-keyed in canonical `"METHOD /path"` / `"/path"` form with the path
 * leading-slash coerced. Unknown/custom keys pass through untouched (data-only
 * rules).
 */
export function normalizeRouteRules(
  config: Record<string, RouteRuleConfig>,
): Record<string, RouteRules> {
  const normalizedRules: Record<string, RouteRules> = {};
  for (const key in config) {
    const routeConfig = config[key]!;
    const { method, path } = parseRouteKey(key);

    const routeRules: RouteRules = {
      ...routeConfig,
      redirect: undefined,
      proxy: undefined,
      cors: undefined,
      swr: undefined,
    };

    // Redirect
    if (routeConfig.redirect) {
      const redirectOptions: { to?: string; status?: number } =
        typeof routeConfig.redirect === "string"
          ? { to: routeConfig.redirect }
          : routeConfig.redirect;
      routeRules.redirect = { to: "/", status: 307, ...redirectOptions };
      if (path.endsWith("/**")) {
        routeRules.redirect.base = path.slice(0, -3);
      }
    }

    // Proxy
    if (routeConfig.proxy) {
      routeRules.proxy =
        typeof routeConfig.proxy === "string"
          ? { to: routeConfig.proxy }
          : { ...routeConfig.proxy };
      if (path.endsWith("/**")) {
        routeRules.proxy.base = path.slice(0, -3);
      }
    }

    // CORS
    if (routeConfig.cors) {
      routeRules.headers = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "*",
        "access-control-allow-headers": "*",
        "access-control-max-age": "0",
        ...routeRules.headers,
      };
    }

    // Cache: swr
    // Note: 0 is a valid swr value (serve stale, revalidate immediately),
    // so we must not use a falsy check here.
    if (routeConfig.swr !== undefined && routeConfig.swr !== false) {
      // Copy: `routeRules.cache` still aliases the user's config object here.
      const cache: Exclude<RouteRules["cache"], false | undefined> = {
        ...(routeRules.cache || undefined),
      };
      cache.swr = true;
      if (typeof routeConfig.swr === "number") {
        cache.maxAge = routeConfig.swr;
      }
      routeRules.cache = cache;
    }

    // `false` reset markers (delete an inherited rule at runtime merge)
    if (routeConfig.cache === false) {
      routeRules.cache = false;
    }
    if (routeConfig.redirect === false) {
      routeRules.redirect = false;
    }
    if (routeConfig.proxy === false) {
      routeRules.proxy = false;
    }

    // Drop the keys we consumed / reset to undefined so the serialized rule set
    // is clean (undefined-valued own props otherwise survive object spread).
    if (routeRules.redirect === undefined) delete routeRules.redirect;
    if (routeRules.proxy === undefined) delete routeRules.proxy;
    delete routeRules.cors;
    delete routeRules.swr;

    // Distinct config keys can collide once canonicalized (`"get /x"` vs
    // `"GET /x"`, `"x"` vs `"/x"`) — merge per rule name (same semantics as the
    // runtime merge of duplicate registrations) instead of dropping the earlier
    // rule wholesale.
    const canonicalKey = formatRouteKey(method, path);

    // A top-level array option has no well-defined merge: the shallow object
    // spread used to combine overlapping layers would splice two arrays into an
    // index-keyed plain object (losing array-ness), so reject it at config time
    // instead of silently corrupting. Wrap the array in an object if needed.
    for (const name in routeRules) {
      if (Array.isArray(routeRules[name])) {
        throw new Error(
          `[h3-rules] \`${name}\` rule for \`${canonicalKey}\` is an array — rule options cannot be top-level arrays (ambiguous merge semantics); wrap it in an object`,
        );
      }
    }

    const existing = normalizedRules[canonicalKey];
    if (existing) {
      for (const [name, options] of Object.entries(routeRules)) {
        existing[name] =
          isMergeableObject(existing[name]) && isMergeableObject(options)
            ? { ...existing[name], ...options }
            : options;
      }
    } else {
      normalizedRules[canonicalKey] = routeRules;
    }
  }
  return normalizedRules;
}
