import { formatRouteKey, parseRouteKey } from "./internal/key.ts";
import { mergeRuleOptions } from "./merge.ts";
import type { RouteRuleConfig, RouteRules } from "./types.ts";

/**
 * Normalize user route-rule config into runtime rules.
 *
 * Expands the `swr` shortcut, normalizes `cors` (`true` → permissive options
 * object) and `redirect`/`proxy` string forms,
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
    const canonicalKey = formatRouteKey(method, path);

    // The consumed keys are pulled out and re-added in normalized form only
    // when set (no undefined-marker cleanup needed), always in the same fixed
    // order (redirect, proxy, cors, cache) so normalization is key-order
    // idempotent — the compiler pins byte-identical codegen for authored vs
    // pre-normalized input. The rest-destructure copies the remaining keys, so
    // the user's config object is never mutated.
    const { redirect, proxy, cors, swr, cache, ...rest } = routeConfig;
    const routeRules: RouteRules = rest;

    // Redirect
    if (redirect) {
      const redirectOptions: { to?: string; status?: number } =
        typeof redirect === "string" ? { to: redirect } : redirect;
      routeRules.redirect = { to: "/", status: 307, ...redirectOptions };
      if (path.endsWith("/**")) {
        routeRules.redirect.base = path.slice(0, -3);
      }
    }

    // Proxy
    if (proxy) {
      routeRules.proxy = typeof proxy === "string" ? { to: proxy } : { ...proxy };
      if (path.endsWith("/**")) {
        routeRules.proxy.base = path.slice(0, -3);
      }
    }

    // CORS (h3 `handleCors` options). `true` → permissive defaults (empty
    // options object; h3 fills origin/methods/allowHeaders `*`). `false` is a
    // reset marker (handled below with the other resets).
    if (cors !== undefined && cors !== false) {
      const corsOptions = cors === true ? {} : { ...cors };
      // `Access-Control-Allow-Origin: *` is unusable for credentialed requests
      // (Fetch spec: https://fetch.spec.whatwg.org/#cors-protocol-and-credentials
      // — browsers reject the response, and h3 would warn on every request).
      // Normalization runs once at startup/build time, so fail here instead.
      // A function `origin` validates dynamically and cannot be checked
      // statically — it passes (as does h3's literal `"null"` origin).
      if (
        corsOptions.credentials === true &&
        (corsOptions.origin === undefined ||
          corsOptions.origin === "*" ||
          (Array.isArray(corsOptions.origin) && corsOptions.origin.includes("*")))
      ) {
        throw new Error(
          `[h3-rules] \`cors\` rule for \`${canonicalKey}\` sets \`credentials: true\` with a wildcard origin — \`Access-Control-Allow-Origin: *\` is invalid for credentialed requests; set an explicit \`origin\` allowlist (or validation function)`,
        );
      }
      routeRules.cors = corsOptions;
    }

    // Cache: swr
    // Note: 0 is a valid swr value (serve stale, revalidate immediately),
    // so we must not use a falsy check here.
    if (swr !== undefined && swr !== false) {
      // Copy: `cache` aliases the user's config object here.
      const cacheOptions: Exclude<RouteRules["cache"], false | undefined> = {
        ...(cache || undefined),
      };
      cacheOptions.swr = true;
      if (typeof swr === "number") {
        cacheOptions.maxAge = swr;
      }
      routeRules.cache = cacheOptions;
    } else if (swr === false && cache === undefined) {
      // Bare `swr: false` (no explicit `cache`) is a cache reset marker — same
      // as `cache: false` — so it disables an inherited `cache` rule at merge
      // time. `swr: 0` is a real value (handled above), not a reset; an explicit
      // `cache` alongside `swr: false` wins and is handled by the branch below.
      routeRules.cache = false;
    } else if (cache !== undefined && cache !== false) {
      routeRules.cache = cache;
    }

    // `false` reset markers (delete an inherited rule at runtime merge)
    if (cache === false) {
      routeRules.cache = false;
    }
    if (redirect === false) {
      routeRules.redirect = false;
    }
    if (proxy === false) {
      routeRules.proxy = false;
    }
    if (cors === false) {
      routeRules.cors = false;
    }

    // A top-level array option has no well-defined merge: the shallow object
    // spread used to combine overlapping layers would splice two arrays into an
    // index-keyed plain object (losing array-ness), so reject it at config time
    // instead of silently corrupting. Wrap the array in an object if needed.
    // Rule names become object property keys throughout matching/merging;
    // reserved prototype keys (`__proto__` / `constructor` / `prototype`) are
    // never legitimate rule names and would otherwise resolve to inherited
    // prototype members at match time — reject them here (the runtime merge is
    // also hardened with null-prototype accumulators, but fail loudly at config
    // time). `for..in` also surfaces an own `__proto__` key (e.g. from a
    // JSON-sourced config), which a plain-object key check would miss.
    for (const name in routeRules) {
      if (name === "__proto__" || name === "constructor" || name === "prototype") {
        throw new Error(
          `[h3-rules] \`${name}\` is a reserved name and cannot be used as a rule for \`${canonicalKey}\``,
        );
      }
      if (Array.isArray(routeRules[name])) {
        throw new Error(
          `[h3-rules] \`${name}\` rule for \`${canonicalKey}\` is an array — rule options cannot be top-level arrays (ambiguous merge semantics); wrap it in an object`,
        );
      }
    }

    // Distinct config keys can collide once canonicalized (`"get /x"` vs
    // `"GET /x"`, `"x"` vs `"/x"`) — merge per rule name (same semantics as the
    // runtime merge of duplicate registrations) instead of dropping the earlier
    // rule wholesale.
    const existing = normalizedRules[canonicalKey];
    if (existing) {
      for (const [name, options] of Object.entries(routeRules)) {
        existing[name] = mergeRuleOptions(existing[name], options);
      }
    } else {
      normalizedRules[canonicalKey] = routeRules;
    }
  }
  return normalizedRules;
}
