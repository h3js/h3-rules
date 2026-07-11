# AGENTS.md

Keep AGENTS.md updated with project status.

`h3-rules`: declarative route rules (redirect, proxy, headers, cache, basicAuth, cors) for H3 v2. Runtime matcher (rou3) + build-time compiler subpath (`h3-rules/compiler`).

Invariants live in `.agents/` — read them before changing matching, merging, or the compiler:

- [`.agents/SECURITY.md`](.agents/SECURITY.md) — security invariants (do not weaken).
- [`.agents/INVARIANTS.md`](.agents/INVARIANTS.md) — behavioral invariants and cross-file contracts to keep in sync.

## Commands

- `pnpm test` — lint + typecheck + vitest w/ coverage (run before committing)
- `pnpm fmt` — fix lint/format (oxlint + oxfmt); CI fails on unformatted files
- `pnpm build` — obuild; entries: `src/index.ts`, `src/cache.ts`, `src/proxy.ts`, `src/compiler.ts`
- `pnpm bench` — matcher throughput (standalone [mitata](https://github.com/evanwashere/mitata), no vitest: `node --expose-gc bench/match.mjs`); `--expose-gc` lets mitata GC between benchmarks for stabler samples. mitata is a devDependency for this bench only.
- `pnpm bench:size` — per-built-in-rule consumer bundle sizes (esbuild, `bench/bundle-size.mjs`), measuring compiled-mode per-rule tree-shaking. esbuild is a devDependency for this bench only. Keep `bench/rules.ts` in sync when adding a built-in rule.

## Constraints

As we are in the initial phase, breaking changes and API refinements ARE ACCEPTABLE and prefered over hacks.

- Runtime code must stay runtime-agnostic: Web APIs only, no `node:*` imports, no side effects, no unstorage/srvx dependencies. Runtime deps are exactly `rou3`, `ufo`; `h3` is a **peer** (pinned `^2.0.1-rc.23` — minimum version exporting `resolveDotSegments`, required by `canonicalPath`). `ocache` is an **optional peer** imported only by the `h3-rules/cache` subpath (`src/cache.ts`, the ocache-backed `cache` handler + h3 response glue) — keep every ocache import (runtime _and_ type) confined there; core code uses the vendored `CacheRuleOptions` schema (`src/types.ts`, ocache-compat pinned in `test/types.test-d.ts`).
- Keep `rou3/compiler` imports confined to `src/compiler.ts` / `src/compiler/*` so they stay out of runtime bundles. `src/compiler.ts` is a thin barrel over `src/compiler/*`, split in dependency order (`options.ts` public types + input normalization → `runtime-rules.ts` handler-import registry → `codegen.ts` string emission → `compile.ts` entrypoints + preMerge resolution) — the public export surface stays identical.
- The export surface must stay **tree-shakeable**, including namespace member access (`import * as rules from "h3-rules"; rules.xyz`): no module-level side effects in runtime code, `/* @__PURE__ */` on module-scope instantiations (e.g. the shared `cache` instance). `test/treeshake.test.ts` pins this with esbuild metafile assertions (named + namespace imports, compiled codegen output, a positive rou3-present control), including a forced-`sideEffects: true` variant — the package-level `"sideEffects": false` hint would otherwise let bundlers drop unused modules regardless of content, masking a stray module-scope side effect or a lost `@__PURE__`.
- ocache storage is process-global (`setStorage`) — the `h3-rules/cache` factory's `storage` option mutates it; per-instance isolation is only possible via a `defineCachedHandler` injection (core `createCacheRuleHandler`).
- There is **no default `cache` / `proxy` handler**: both are opt-in subpath exports so their deps stay out of bundles that don't use them (`cache`→ocache; `proxy`→h3's `proxyRequest`, in `src/proxy.ts` / `h3-rules/proxy`). `createRouteRulesMatcher` throws when rules use `cache`/`swr` or `proxy` with no matching entry in the handler registry (explicit `handlers: { cache: undefined }` / `{ proxy: undefined }` opts into data-only). The compiler sources both from their subpath (`DEFAULT_RUNTIME_RULES` via `SUBPATH_RULE_SOURCES`), so compiled bundles pull each rule's dep only when that rule exists. `redirect` stays a core registry handler — it shares `resolveRuleTarget` (ufo) with `proxy` but not `proxyRequest`.
- `src/index.ts` (and the `src/cache.ts` / `src/proxy.ts` subpath entries) are the explicit export surface — no barrel re-export sprawl; keep modules small and single-purpose. Modules with no public exports live in `src/internal/` (`key.ts`, `premerge.ts`, `scope.ts`); everything exported from `src/index.ts` must be README-documented API or a type reachable from one. (`scope.ts` was public pre-release; re-export `canonicalPath`/`isPathInScope` if a consumer needs the hardened scope check for custom handlers.)
