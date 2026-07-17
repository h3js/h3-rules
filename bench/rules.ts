import type { RouteRuleConfig } from "../src/types.ts";

// A data-only rule carries arbitrary metadata under a custom key with no
// registered handler — the consumer reads it off `event.context.routeRules`,
// nothing runs. Custom keys are compile errors on the closed `RouteRuleConfig`
// until augmented (README "Extending rule types"); this augmentation is exactly
// what such a consumer writes, and lets the `dataOnly` spec below type-check.
declare module "../src/types.ts" {
  interface RouteRuleConfig {
    meta?: Record<string, unknown>;
  }
}

/**
 * Per-rule bench spec: a minimal rule set exercising exactly one rule — a
 * built-in handler, or the handler-less `dataOnly` floor — plus a hot probe
 * that matches it. Shared by the RPS bench (`bench/match.mjs`) and the
 * bundle-size bench (`bench/bundle-size.mjs`) so both report the same per-rule
 * breakdown and the two benches cannot drift on which rules exist.
 *
 * Each set is a single pattern (chain-clean by construction — nothing to
 * pre-merge) and JSON-serializable (the bundle bench compiles + embeds it).
 * `deps` names the external runtime packages the handler pulls in, so the
 * bundle table's per-dep columns can be read against expectations:
 * `cache`→ocache (via the opt-in `h3-rules/cache` handler; ocache is an
 * optional peer), `redirect`/`proxy`→ufo (proxy's handler is the opt-in
 * `h3-rules/proxy` subpath, which also pulls h3's `proxyRequest` — h3 is an
 * external peer either way), and `headers`/`cors`/`basicAuth`/`dataOnly` ship
 * no extra deps. `dataOnly` has no handler at all — its compiled bundle is the
 * absolute floor (rules baked as JSON, no handler import, rou3 dropped).
 */
export interface RuleBenchSpec {
  /**
   * Rule label + `.generated/` dir name. For built-ins this is the rule name
   * (matches the handler + its named export); `dataOnly` labels the
   * handler-less floor case (its custom key is `meta`).
   */
  name: string;
  /** External runtime deps the handler pulls in (empty = h3 peer only). */
  deps: string[];
  /** Minimal rule set exercising only this rule. */
  rules: Record<string, RouteRuleConfig>;
  /** Hot probe `[method, pathname]` that matches the rule. */
  probe: [method: string, pathname: string];
}

export const RULE_BENCHES: RuleBenchSpec[] = [
  {
    name: "headers",
    deps: [],
    rules: { "/api/**": { headers: { "cache-control": "s-maxage=60" } } },
    probe: ["GET", "/api/resource"],
  },
  {
    // Delegates to h3's `handleCors` — no extra runtime deps (h3 is a peer).
    name: "cors",
    deps: [],
    rules: { "/api/**": { cors: true } },
    probe: ["GET", "/api/resource"],
  },
  {
    name: "redirect",
    deps: ["ufo"],
    rules: { "/old/**": { redirect: "/new/**" } },
    probe: ["GET", "/old/page"],
  },
  {
    name: "proxy",
    deps: ["ufo"],
    rules: { "/api/**": { proxy: "/upstream/**" } },
    probe: ["GET", "/api/resource"],
  },
  {
    name: "cache",
    deps: ["ocache"],
    rules: { "/api/**": { swr: 60 } },
    probe: ["GET", "/api/resource"],
  },
  {
    name: "basicAuth",
    deps: [],
    rules: {
      "/admin/**": { basicAuth: { username: "admin", password: "secret", realm: "Admin" } },
    },
    probe: ["GET", "/admin/panel"],
  },
  {
    // No handler: a custom `meta` key the matcher resolves as data only (read
    // off `event.context.routeRules`, nothing runs). The compiled bundle floor
    // — rules baked as JSON, no handler import, no rou3.
    name: "dataOnly",
    deps: [],
    rules: { "/api/**": { meta: { tier: "premium" } } },
    probe: ["GET", "/api/resource"],
  },
];
