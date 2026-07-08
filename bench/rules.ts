import type { RouteRuleConfig } from "../src/types.ts";

/**
 * Per-built-in-rule bench spec: a minimal rule set exercising exactly one
 * built-in rule handler, plus a hot probe that matches it. Shared by the RPS
 * bench (`bench/match.bench.ts`) and the bundle-size bench
 * (`bench/bundle-size.mjs`) so both report the same per-rule breakdown and the
 * two benches cannot drift on which rules exist.
 *
 * Each set is a single pattern (chain-clean by construction — nothing to
 * pre-merge) and JSON-serializable (the bundle bench compiles + embeds it).
 * `deps` names the external runtime packages the handler pulls in, so the
 * bundle table's per-dep columns can be read against expectations:
 * `cache`→ocache, `redirect`/`proxy`→ufo, and `headers`/`cors`/`basicAuth`
 * ship no extra deps (h3 is an external peer either way).
 */
export interface RuleBenchSpec {
  /** Built-in rule name (matches the handler + its named export). */
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
    // Shortcut that normalizes into a `headers` rule — same footprint as headers.
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
];
