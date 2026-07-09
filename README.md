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

const app = new H3();

app.use(
  routeRules({
    "/blog/**": { swr: 60 },
    "/old/**": { redirect: { to: "/new/**", status: 301 } },
    "/api/proxy/**": { proxy: "https://example.com/**" },
    "/assets/**": { headers: { "cache-control": "s-maxage=31536000" } },
    "/admin/**": { basicAuth: { username: "admin", password: "secret" } },
    "/api/**": { cors: true },
    "GET /api/cached/**": { swr: 60 }, // method-scoped
  }),
);

serve(app);
```

Patterns are matched with [rou3](https://github.com/h3js/rou3) against `event.url.pathname`. **All** matching patterns apply, merged from least to most specific. The merged rule map is exposed as `event.context.routeRules`, and rules with runtime behavior run as middleware before the route handler.

### Rules

| Rule        | Behavior                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `headers`   | Set response headers.                                                                            |
| `redirect`  | Redirect (string defaults to status `307`; `/**` targets append the matched tail).               |
| `proxy`     | Proxy the request to another origin or in-app path (same `/**` tail behavior).                   |
| `cache`     | Wrap the matched route handler with a cached handler ([ocache](https://github.com/unjs/ocache)). |
| `basicAuth` | HTTP Basic Authentication (runs before redirect/proxy/cache).                                    |
| `cors`      | Shortcut for permissive CORS headers (your `headers` win).                                       |
| `swr`       | Shortcut for `cache: { swr: true, maxAge?: number }` (`swr: 0` is valid).                        |

Setting a rule to `false` on a more specific pattern resets it:

```ts
routeRules({
  "/admin/**": { basicAuth: { username: "admin", password: "secret" } },
  "/admin/public/**": { basicAuth: false },
});
```

Keys may carry an optional HTTP method prefix (`"GET /api/**"`). A key without a method applies to all methods; for the same pattern, method-scoped rules merge after (override) method-agnostic ones.

Unknown keys (e.g. `prerender`, `isr`, or your own) are **data-only**: they flow through matching and merging and can be read from `event.context.routeRules`, but have no runtime handler.

### Utils

```ts
import {
  createRouteRulesMatcher,
  normalizeRouteRules,
  mergeMatchedRouteRules,
  ruleHandlers,
} from "h3-rules";

const matcher = createRouteRulesMatcher(normalizeRouteRules(config), {
  baseURL: "/base", // prefix all patterns
  memoize: true, // memoize match results per method + pathname (or { max: n })
  preMerge: true, // pre-merge pattern chains at startup (throws on ambiguous rule sets)
  handlers: {
    // add or override rule handlers by name; `undefined` = data-only
    myRule: (matched) => (event, next) => {
      /* ... */
    },
  },
  cache: {
    // storage: myStorage, // ocache storage (minimal get/set)
    // defaults: { staleMaxAge: 60 }, // ocache defaults (rule options win)
    // or replace the wiring entirely:
    // defineCachedHandler: (handler, opts) => ...,
  },
});

const { routeRules, routeRuleMiddleware } = matcher("GET", "/blog/post");
```

#### Memoization

For a given `method + pathname` the merged result is fully deterministic, so `memoize: true` caches it: repeat requests skip the rule lookups, path canonicalization, merging, and middleware construction (~8× faster per request, a single map lookup on hot paths). Entries are capped (default `1024`, tune with `{ max }`) with FIFO eviction, so unbounded dynamic paths cannot grow the cache. Memoized results are shared across requests — treat `event.context.routeRules` as read-only (rule `options` objects are shared with the registered rule data either way). Also available standalone as `memoizeRouteRulesMatcher(matcher, opts?)` and as an option to `createMatcherFromFind` for compiled matchers.

#### Pre-merging

`preMerge: true` resolves each pattern's subsumption chain up front (at matcher startup, or at build time via the compiler option) so per-request resolution takes only the most specific matched layer instead of merging all matched layers (~20% faster on cold paths; composes with `memoize` for warm ones). It is exact, but requires an unambiguous rule set: if two patterns partially overlap (e.g. `/a/*/c` vs `/a/b/*` — the most specific match would be ambiguous) or use patterns it cannot analyze (regex params), the **runtime matcher throws at startup** (a misconfigured `preMerge` is a startup error). The **compiler is fail-safe**: it emits a `console.warn` and falls back to plain compilation so the build still produces a correct matcher. Method-scoped and method-agnostic rules, `false` resets, and per-rule `params` behave identically to the default per-request merge (a tested invariant).

### Compiled matcher (`h3-rules/compiler`)

For build-time codegen, serialize normalized rules into a compiled `findRouteRules` function so `rou3` stays out of the runtime bundle:

```ts
import { compileRouteRulesModule } from "h3-rules/compiler";
import { normalizeRouteRules } from "h3-rules";

const code = compileRouteRulesModule(normalizeRouteRules(config), {
  preMerge: true, // optional: bake pre-merged chains into the generated matcher
});
// -> import { headers as __ruleHandlers__$headers } from "h3-rules";
// -> export const findRouteRules = (method, path) => ...;
```

At runtime, wrap it with `createMatcherFromFind(findRouteRules)` (optionally with `{ memoize: true }`). Compiled and runtime matchers produce identical results.

The generated module imports **only the rule handlers the rule set uses** — each is a named export of `h3-rules` (`headers`, `redirect`, `proxy`, `cache`, `basicAuth`), so unused handlers and their dependencies (rou3's matcher always, ocache/ufo when `cache`/`redirect`/`proxy` are unused) tree-shake out of the bundle. To add or override handlers, point `handlersImportId` at a module exporting your handlers by name (e.g. a custom `cache` built with `createCacheRuleHandler(opts)`).

### Extending rule types

`RouteRuleConfig` and `RouteRules` are open interfaces designed for module augmentation. Consumers re-add their own keys with full typing:

```ts
declare module "h3-rules" {
  interface RouteRuleConfig {
    /** Incremental Static Regeneration (handled at build time). */
    isr?: number | boolean;
    /** Add this route to the prerender queue. */
    prerender?: boolean;
  }
  interface RouteRules {
    isr?: number | boolean;
    prerender?: boolean;
  }
}
```

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
