# h3-rules

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/h3-rules?color=yellow)](https://npmjs.com/package/h3-rules)
[![npm downloads](https://img.shields.io/npm/dm/h3-rules?color=yellow)](https://npm.chart.dev/h3-rules)

<!-- /automd -->

Declarative route rules for [H3](https://h3.dev): Define route rules (redirect, proxy, headers, cache, basic auth, CORS) to patterns.

## Usage

### H3 Middleware

Add the `routeRules` middleware to your H3 app:

```ts
import { H3, serve } from "h3";
import { routeRules } from "h3-rules";
import { cache } from "h3-rules/cache"; // only needed for cache/swr rules (requires ocache)
import { proxy } from "h3-rules/proxy"; // only needed for proxy rules

const app = new H3();

app.use(
  routeRules(
    {
      "/blog/**": { swr: 60 },
      "/old/**": { redirect: { to: "/new/**", status: 301 } },
      "/api/proxy/**": { proxy: "https://example.com/**" },
      "/assets/**": { headers: { "cache-control": "s-maxage=31536000" } },
      "/admin/**": { basicAuth: { username: "admin", password: "secret" } },
      "/api/**": { cors: true },
      "GET /api/cached/**": { swr: 60 }, // method-scoped
    },
    { handlers: { cache, proxy } },
  ),
);

serve(app);
```

Patterns are matched with [rou3](https://github.com/h3js/rou3) against `event.url.pathname`. **All** matching patterns apply, merged from least to most specific. The merged rule map is exposed as `event.context.routeRules`, and rules with runtime behavior run as middleware before the route handler. Match results are memoized per `method + pathname` by default (treat them as read-only; pass `memoize: false` to opt out — see [Memoization](#memoization)).

### Rules

| Rule        | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `headers`   | Set response headers. Applied to the final response (after `cache`/`redirect`/`proxy`), so a `cache-control` here overrides ocache's computed value.                                                                                                                                                                                                                                                                                                                           |
| `redirect`  | Redirect (string defaults to status `307`; `/**` targets append the matched tail). The request query is forwarded with full fidelity (multi-valued params preserved, appended after any query baked into the target).                                                                                                                                                                                                                                                          |
| `proxy`     | Proxy the request to another origin or in-app path (same `/**` tail behavior). Opt-in handler from `h3-rules/proxy` (see [Proxying](#proxying-h3-rulesproxy)).                                                                                                                                                                                                                                                                                                                 |
| `cache`     | Wrap the matched route handler with a cached handler. Needs a registered handler — see [Caching](#caching-h3-rulescache).                                                                                                                                                                                                                                                                                                                                                      |
| `basicAuth` | HTTP Basic Authentication (runs before redirect/proxy/cache).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cors`      | Handle CORS via h3's [`handleCors`](https://h3.dev/utils/security#cors). `true` = permissive defaults; an object = h3 `CorsOptions` (origin allowlist, `credentials`, `maxAge`, …). Preflight (`OPTIONS`) is answered directly, before `basicAuth`. `credentials: true` requires an explicit `origin` (allowlist or validation function) — combining it with a wildcard origin throws at startup, since `Access-Control-Allow-Origin: *` is invalid for credentialed requests. |
| `swr`       | Shortcut for `cache: { swr: true, maxAge?: number }` (`swr: 0` is valid; `swr: false` resets an inherited `cache`).                                                                                                                                                                                                                                                                                                                                                            |

Setting a rule to `false` on a more specific pattern resets it:

```ts
routeRules({
  "/admin/**": { basicAuth: { username: "admin", password: "secret" } },
  "/admin/public/**": { basicAuth: false },
});
```

Note that `cors: true` normalizes to an empty options object (`{}`), so on a more specific pattern it shallow-merges with cors options inherited from broader patterns rather than restoring permissive defaults — use `cors: false` to reset inherited CORS, or an explicit options object to override specific fields.

Keys may carry an optional HTTP method prefix (`"GET /api/**"`). A key without a method applies to all methods; for the same pattern, method-scoped rules merge after (override) method-agnostic ones.

Unknown keys (e.g. `prerender`, `isr`, or your own) are **data-only**: they flow through matching and merging and can be read from `event.context.routeRules`, but have no runtime handler.

### Caching (`h3-rules/cache`)

The core package ships **no caching implementation** — `cache` (and the `swr` shortcut) need a registered `cache` rule handler, and matcher construction throws if a rule set uses them without one (pass `handlers: { cache: undefined }` to deliberately keep them data-only). The ready-made handler is backed by [ocache](https://github.com/unjs/ocache) and lives in the `h3-rules/cache` subpath, so ocache (an **optional** peer dependency — install it alongside `h3-rules`) stays out of every bundle that doesn't cache:

```ts
import { routeRules } from "h3-rules";
import { cache, createOcacheRuleHandler } from "h3-rules/cache";

// default: ocache with in-memory storage, wired with h3's response glue
app.use(routeRules({ "/blog/**": { swr: 60 } }, { handlers: { cache } }));

// custom storage / defaults (one handler instance per matcher):
app.use(
  routeRules(rules, {
    handlers: {
      cache: createOcacheRuleHandler({
        storage: myStorage, // ocache storage (minimal get/set) — note: process-global (`setStorage`)
        defaults: { staleMaxAge: 60 }, // ocache defaults incl. hooks (rule options win)
      }),
    },
  }),
);
```

To plug in your own caching (no ocache at all), build a handler from the **core** factory — `defineCachedHandler` receives the matched route handler plus the merged rule options (`group`/`name` pre-filled) and returns the cached wrapper. This is the integration point for frameworks (e.g. Nitro's unstorage / `useStorage()` wiring):

```ts
import { createCacheRuleHandler } from "h3-rules";

const cache = createCacheRuleHandler({
  defineCachedHandler: (handler, opts) => myCachedHandler(handler, opts),
});
```

The declarative rule options (`RouteRuleConfig["cache"]`) are the ocache-compatible `CacheRuleOptions` schema owned by `h3-rules`; implementation hooks (`getKey`, `shouldCache`, `getMaxAge`, …) are not rule data — pass them via the handler factory's `defaults`.

### Proxying (`h3-rules/proxy`)

Like caching, the `proxy` rule is **opt-in**: its handler imports h3's `proxyRequest` (the request-forwarding machinery), so it lives in the `h3-rules/proxy` subpath and stays out of every bundle that doesn't proxy. Register it explicitly, and matcher construction throws if a rule set uses `proxy` without a handler (pass `handlers: { proxy: undefined }` to deliberately keep the rule data-only):

```ts
import { routeRules } from "h3-rules";
import { proxy } from "h3-rules/proxy";

app.use(
  routeRules({ "/api/proxy/**": { proxy: "https://example.com/**" } }, { handlers: { proxy } }),
);
```

### Utils

```ts
import {
  createRouteRulesMatcher,
  normalizeRouteRules,
  mergeMatchedRouteRules,
  ruleHandlers,
} from "h3-rules";
import { cache } from "h3-rules/cache";

const matcher = createRouteRulesMatcher(normalizeRouteRules(config), {
  baseURL: "/base", // prefix all patterns
  preMerge: true, // pre-merge pattern chains at startup (throws on ambiguous rule sets)
  handlers: {
    // add or override rule handlers by name; `undefined` = data-only.
    // A handler is `{ handler, order? }` — `order` is a number controlling
    // execution order (lower runs first, default 0). Built-in bands:
    // cors (-3), basicAuth (-2), headers (-1), everything else 0.
    myRule: {
      handler: (matched) => (event, next) => {
        /* ... */
      },
    },
    // cache/swr rules need a registered cache handler (none by default):
    cache,
  },
});

const { routeRules, routeRuleMiddleware } = matcher("GET", "/blog/post");
```

#### Memoization

For a given `method + pathname` the merged result is fully deterministic, so it can be memoized: repeat requests skip the rule lookups, path canonicalization, merging, and middleware construction (~8× faster on a mixed path sweep; far larger on hot paths, where a match becomes a single map lookup). The `routeRules()` middleware memoizes **by default** — pass `memoize: false` to opt out, or `memoize: { max }` to tune the cap. For the lower-level matchers, memoization is decoupled from construction — opt in by wrapping any matcher with `memoizeRouteRulesMatcher(matcher, opts?)`:

```ts
import { createRouteRulesMatcher, memoizeRouteRulesMatcher } from "h3-rules";

const matcher = memoizeRouteRulesMatcher(createRouteRulesMatcher(normalizeRouteRules(config)));
```

Entries are capped (default `1024`, tune with `{ max }`) with FIFO eviction, so unbounded dynamic paths cannot grow the cache. Memoized results are shared across requests — treat `event.context.routeRules` as read-only (rule `options` objects are shared with the registered rule data either way). It wraps a compiled matcher the same way (`memoizeRouteRulesMatcher(createMatcherFromFind(findRouteRules))`); keeping it out of `createMatcherFromFind`/`createRouteRulesMatcher` lets an un-memoized bundle tree-shake it away.

#### Pre-merging

`preMerge: true` resolves each pattern's subsumption chain up front (at matcher startup, or at build time via the compiler option) so per-request resolution takes only the most specific matched layer instead of merging all matched layers (~20% faster on cold paths; composes with `memoizeRouteRulesMatcher` for warm ones). It is exact, but requires an unambiguous rule set: if two patterns partially overlap (e.g. `/a/*/c` vs `/a/b/*` — the most specific match would be ambiguous) or use patterns it cannot analyze (regex params), the **runtime matcher throws at startup** (a misconfigured `preMerge` is a startup error). The **compiler is fail-safe**: it emits a `console.warn` and falls back to plain compilation so the build still produces a correct matcher. Method-scoped and method-agnostic rules, `false` resets, and per-rule `params` behave identically to the default per-request merge (a tested invariant).

### Compiled matcher (`h3-rules/compiler`)

For build-time codegen, compile your rules into a `findRouteRules` function so `rou3` stays out of the runtime bundle:

```ts
import { compileRouteRules } from "h3-rules/compiler";

const mod = compileRouteRules(config, {
  preMerge: true, // optional: bake pre-merged chains into the generated matcher
});
mod.code; // whole module (also `String(mod)` / template interpolation)
// -> import { headers as __ruleHandlers__$headers } from "h3-rules";
// -> export const findRouteRules = (method, path) => ...;
```

`compileRouteRules` returns the module split into its two composable halves — `imports` (the handler `import` statements) and `body` (the `export const findRouteRules = …` declaration) — plus `code` (the whole module, same as `String(mod)`). Take `code` to write a standalone module, or hoist `imports` and inline `body` to weave the matcher into a larger generated module.

The compiler entrypoints normalize their input themselves (compilation is build-time, so the pass is free) — pass authored config directly. An already-normalized rule set (from your own `normalizeRouteRules` call) is equally valid input: normalization is idempotent.

At runtime, wrap `findRouteRules` with `createMatcherFromFind(findRouteRules)` (for memoization, compose `memoizeRouteRulesMatcher(createMatcherFromFind(findRouteRules))`). Compiled and runtime matchers produce identical results. Unlike the compiler, `createRouteRulesMatcher` takes **normalized** rules — this keeps normalization out of runtime bundles; `routeRules()` is the auto-normalizing runtime entry point.

To skip the hand-written wrapper, pass `matcher` so the generated module exports a ready-to-use matcher alongside `findRouteRules`:

```ts
compileRouteRules(config, { matcher: true });
// -> export const findRouteRules = …;
// -> import { createMatcherFromFind } from "h3-rules";
// -> export const matcher = createMatcherFromFind(findRouteRules);

// rename the export, or bake in memoization:
compileRouteRules(config, { matcher: { name: "routeMatcher", memoize: true } });
// -> import { createMatcherFromFind, memoizeRouteRulesMatcher } from "h3-rules";
// -> export const routeMatcher = memoizeRouteRulesMatcher(createMatcherFromFind(findRouteRules));
```

`matcher: true` names the export `matcher`; pass a string to rename it, or `{ name?, memoize? }` to also wrap in `memoizeRouteRulesMatcher` (`memoize: { max }` tunes the cap). `memoizeRouteRulesMatcher` is imported **only** when `memoize` is set, so an un-memoized matcher export still tree-shakes it away. The infra import counts toward `mod.imports`.

The generated module imports **only the rule handlers the rule set uses** — most built-ins are a named export of `h3-rules` (`headers`, `redirect`, `basicAuth`, `cors`), except the opt-in subpath handlers: `cache` imports from `h3-rules/cache` (the ocache-backed handler; requires the optional `ocache` peer only when a cache rule exists) and `proxy` from `h3-rules/proxy` (pulls h3's `proxyRequest` only when a proxy rule exists). Unused handlers and their dependencies (rou3's matcher always, ocache/ufo when `cache`/`redirect`/`proxy` are unused) tree-shake out of the bundle.

Where each handler is imported from is controlled by `runtimeRules` — a record keyed by rule name whose value is either a module id (the module must export a member named exactly as the rule key, e.g. `cache: "#nitro/cache"` imports `cache`) or `{ source, export }` when the export is named something else. It is merged **over** the built-in preset (`DEFAULT_RUNTIME_RULES`: every built-in from `h3-rules`, except `cache` from `h3-rules/cache` and `proxy` from `h3-rules/proxy`), so you only list what you add or change — the built-ins stay registered. Handlers sharing a source collapse into one import statement:

```ts
import { compileRouteRules } from "h3-rules/compiler";

compileRouteRules(config, {
  runtimeRules: {
    cache: "#nitro/cache", // repoint the built-in cache at your own module
    isr: { source: "#nitro/rules", export: "handleISR" }, // custom rule + export
  },
});
// -> import { handleISR as __ruleHandlers__$isr } from "#nitro/rules";
// -> import { cache as __ruleHandlers__$cache } from "#nitro/cache";
// (redirect, headers, … still import from "h3-rules" when used)
```

A custom `cache` handler can be built with `createOcacheRuleHandler` — the ocache-wired factory from `h3-rules/cache` (`storage`/`defaults`) — or the core injection factory `createCacheRuleHandler` from `h3-rules` (`defineCachedHandler`); see [Caching](#caching-h3-rulescache).

### Extending rule types

`RouteRuleConfig` (the config you author) is a **closed** interface — unknown keys are compile errors, so a typo like `redirct` is caught at build time. To add custom or data-only rules, declare them via module augmentation. Augment `RouteRuleConfig` for the config input, and `RouteRules` (which stays open) so the key is typed on the normalized/matched result too:

```ts
declare module "h3-rules" {
  interface RouteRuleConfig {
    /** Incremental Static Regeneration (handled at build time). */
    isr?: number | boolean;
    /** Add this route to the prerender queue. */
    prerender?: boolean;
    /** A data-only rule with no runtime handler. */
    audience?: "public" | "internal";
  }
  interface RouteRules {
    isr?: number | boolean;
    prerender?: boolean;
    audience?: "public" | "internal";
  }
}
```

Data-only rules (no matching handler) still flow through normalization and merge untouched at runtime — augmentation only re-opens the typing.

## Development

<details>

<summary>local development</summary>

- Clone this repository
- Install latest LTS version of [Node.js](https://nodejs.org/en/)
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- Run interactive tests using `pnpm dev`

</details>

## License

Published under the [MIT](https://github.com/h3js/h3-rules/blob/main/LICENSE) license 💛.
