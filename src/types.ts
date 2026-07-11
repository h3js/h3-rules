import type { BasicAuthOptions, Middleware, ProxyOptions } from "h3";

/** Valid HTTP status code (100–599). Kept loose (`number`) for portability. */
export type HTTPStatus = number;

/**
 * `cache` rule options — the declarative caching schema owned by `h3-rules`.
 *
 * This is intentionally **not** imported from ocache: the core package has no
 * ocache dependency (the ocache-backed handler lives in `h3-rules/cache`), and
 * the rule schema must mean the same thing under any injected
 * `defineCachedHandler` implementation. Every field is a (JSON-serializable)
 * subset of ocache's `CachedEventHandlerOptions`, structurally compatible by
 * a type-level test — implementation hooks (`getKey`, `shouldCache`,
 * `getMaxAge`, …) are deliberately excluded: supply those through the cache
 * handler factory's `defaults` (fully typed against ocache in `h3-rules/cache`)
 * or augment this interface (see the README "Extending rule types" section).
 */
export interface CacheRuleOptions {
  /** Cache name, part of the cache key. Defaults to `<rulePattern>:<matchedRoute>`. */
  name?: string;
  /** Cache key group prefix. Defaults to `"h3-rules/route-rules"`. */
  group?: string;
  /** Custom integrity value participating in cache invalidation. */
  integrity?: unknown;
  /** Number of seconds to cache the response. */
  maxAge?: number;
  /** Enable stale-while-revalidate: serve stale cache while refreshing in the background. */
  swr?: boolean;
  /** Maximum number of seconds a stale entry may be served while revalidating. */
  staleMaxAge?: number;
  /** Storage key base prefix(es). */
  base?: string | string[];
  /** Only handle conditional headers (304 responses) without caching full responses. */
  headersOnly?: boolean;
  /** Request header names that vary the cache key (e.g. `["accept-language"]`). */
  varies?: string[] | readonly string[];
  /** Allowlist of query parameter names that vary the cache key. */
  allowQuery?: string[] | readonly string[];
  /** Allowlist of cookie names that participate in caching (default: none). */
  allowCookies?: string[] | readonly string[];
  /** Whether to synthesize a `Cache-Control` response header (default `true`). */
  sendCacheControl?: boolean;
  /** Cache-status response header: `true` (`X-Cache`), a custom name, or `false`. */
  cacheStatusHeader?: boolean | string;
}

/**
 * Route rule options as authored by the user (input to {@link normalizeRouteRules}).
 *
 * This is a **closed interface**: only the keys declared here type-check, so a
 * typo like `redirct` or `header` is a compile error. Custom / data-only rules
 * must be declared via module augmentation — the same mechanism consumers
 * (e.g. Nitro) use to re-add their own keys (`isr`, `prerender`, `static`, …)
 * with full typing via interface merging. Data-only keys still pass through
 * normalization untouched at runtime; augmentation only re-opens the *typing*.
 * See the README "Extending rule types" section.
 *
 * @example
 * ```ts
 * routeRules({
 *   "/blog/**": { swr: 60 },
 *   "/old/**": { redirect: { to: "/new/**", status: 301 } },
 *   "/api/**": { cors: true },
 * })
 * ```
 */
export interface RouteRuleConfig {
  /**
   * Enable runtime caching. When set to an options object, the matched route
   * handler is wrapped with a cached handler. Set to `false` to disable caching
   * inherited from a less-specific pattern.
   *
   * Requires a registered `cache` rule handler: the ocache-backed one from
   * `h3-rules/cache`, or your own via `createCacheRuleHandler`.
   */
  cache?: CacheRuleOptions | false;

  /** Response headers to set for matching routes. */
  headers?: Record<string, string>;

  /**
   * Server-side redirect. A plain string defaults to status `307`. Use an object
   * to specify a custom status. When the rule key ends with `/**` and `to` also
   * ends with `/**`, the matched path tail is appended to the destination. Set to
   * `false` to disable a redirect inherited from a less-specific pattern.
   */
  redirect?: string | { to: string; status?: HTTPStatus } | false;

  /**
   * Proxy matching requests to another origin or internal path. A plain string
   * specifies the destination. Use an object for additional H3 {@link ProxyOptions}.
   * Wildcard `/**` tail behavior works the same as {@link redirect}. Set to
   * `false` to disable a proxy inherited from a less-specific pattern.
   */
  proxy?: string | ({ to: string } & ProxyOptions) | false;

  /**
   * Protect matching routes with HTTP Basic Authentication. Set to `false` to
   * disable auth inherited from a less-specific pattern.
   */
  basicAuth?: Pick<BasicAuthOptions, "password" | "username" | "realm"> | false;

  // Shortcuts

  /**
   * Shortcut to add permissive CORS headers (`access-control-allow-origin: *`,
   * `access-control-allow-methods: *`, `access-control-allow-headers: *`,
   * `access-control-max-age: 0`). Individual {@link headers} override these.
   */
  cors?: boolean;

  /**
   * Shortcut for `cache: { swr: true, maxAge?: number }`.
   * - `true` — enable SWR with no explicit `maxAge`.
   * - `number` — enable SWR with the given `maxAge` in seconds (`0` is valid).
   * - `false` — do not enable SWR.
   */
  swr?: boolean | number;
}

/**
 * Normalized route rules used at runtime after shortcut resolution.
 *
 * Unlike {@link RouteRuleConfig}, this stays an **open interface** (retains its
 * `[key: string]: unknown` index signature): the matcher/merge runtime handles
 * arbitrary rule names, and a matched result (`event.context.routeRules`) may
 * carry augmented keys. Augment it alongside `RouteRuleConfig` to type custom
 * rules end to end (see the README "Extending rule types" section).
 */
export interface RouteRules {
  headers?: Record<string, string>;
  redirect?: RedirectRuleOptions | false;
  proxy?: ProxyRuleOptions | false;
  cache?: CacheRuleOptions | false;
  basicAuth?: Pick<BasicAuthOptions, "password" | "username" | "realm"> | false;
  [key: string]: unknown;
}

/** Normalized `redirect` rule options. */
export interface RedirectRuleOptions {
  to: string;
  status: HTTPStatus;
  /**
   * Scope base for a `/**` rule key (the key minus the `/**` suffix; the matcher
   * `baseURL` is prefixed at registration). When set, the runtime validates the
   * request path is within scope before stripping this base. First-class
   * replacement for Nitro's internal `_redirectStripBase` flag.
   */
  base?: string;
}

/** Normalized `proxy` rule options. */
export type ProxyRuleOptions = {
  to: string;
  /**
   * Scope base for a `/**` rule key (the key minus the `/**` suffix; the matcher
   * `baseURL` is prefixed at registration). See {@link RedirectRuleOptions.base}.
   * First-class replacement for Nitro's internal `_proxyStripBase` flag.
   */
  base?: string;
} & ProxyOptions;

/** A rule name (string keys of {@link RouteRules}). */
export type RouteRuleName = Extract<keyof RouteRules, string>;

/**
 * A single rule resolved for a matched request, one per rule name.
 */
export interface MatchedRouteRule<K extends RouteRuleName = RouteRuleName> {
  /** The rule name (e.g. `headers`, `redirect`, `cache`). */
  name: K;
  /** The rule options (never `false` after merge resolution). */
  options: Exclude<RouteRules[K], false>;
  /** The rule pattern that matched (e.g. `/api/**`). */
  route: string;
  /** Method scope of the rule (`""` = all methods). */
  method?: string;
  /** rou3 params extracted from the matched pattern. */
  params?: Record<string, string>;
  /**
   * Rule handler: the middleware constructor plus its optional `order`.
   * Data-only rules have no handler.
   */
  handler?: RuleHandler<K>;
}

/** The full set of rules resolved for a matched request, keyed by rule name. */
export type MatchedRouteRules = {
  [K in RouteRuleName]?: MatchedRouteRule<K>;
};

/**
 * A rule handler: `handler` constructs an H3 {@link Middleware} from a matched
 * rule, and the optional `order` controls execution order relative to other
 * rules — lower runs first. The shorthands `"pre"` (`-1`) and `"post"` (`1`) sit
 * on either side of the default (`0`, when omitted); a `number` gives finer
 * control (e.g. `-2` to run before `"pre"`).
 */
export interface RuleHandler<K extends RouteRuleName = RouteRuleName> {
  order?: "pre" | "post" | number;
  handler: (matched: MatchedRouteRule<K>) => Middleware;
}

/** Map of rule name → handler constructor. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RuleHandlers = Record<string, RuleHandler<any> | undefined>;

/** Result of matching a request against the rule set. */
export interface MatchResult {
  /** Merged rule map, exposed as `event.context.routeRules`. */
  routeRules: MatchedRouteRules;
  /** Ordered middleware to run before the route handler. */
  routeRuleMiddleware: Middleware[];
}
