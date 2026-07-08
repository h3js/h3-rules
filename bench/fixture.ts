import type { RouteRuleConfig } from "../src/types.ts";

/**
 * Representative rule set exercising merging, cascades, wildcards, method
 * scoping, auth ordering, params, and data-only rules — same shape as the
 * test fixtures (chain-clean by construction, so `preMerge` variants build).
 * Keep JSON-serializable: the bundle-size bench embeds it as a data module.
 */
export const RULES: Record<string, RouteRuleConfig> = {
  "/rules/headers": { headers: { "cache-control": "s-maxage=60" } },
  "/rules/cors": { cors: true, headers: { "access-control-allow-methods": "GET" } },
  "/rules/redirect": { redirect: "/base" },
  "/rules/redirect/obj": { redirect: { to: "https://h3.dev/", status: 308 } },
  "/rules/redirect/wildcard/**": { redirect: "https://h3.dev/**" },
  "/rules/nested/**": { redirect: "/base", headers: { "x-test": "test" } },
  "/rules/nested/override": { redirect: { to: "/other" } },
  "/rules/_/noncached/cached": { swr: true },
  "/rules/_/noncached/**": { swr: false, cache: false, isr: false },
  "/rules/_/cached/noncached": { cache: false, swr: false, isr: false },
  "/rules/_/cached/**": { swr: true },
  "/api/proxy/**": { proxy: "/api/echo" },
  "/rules/basic-auth/**": {
    basicAuth: { username: "admin", password: "secret", realm: "Secure Area" },
  },
  "/rules/basic-auth/no-auth/**": { basicAuth: false },
  "/rules/ba-nested/**": { basicAuth: { username: "broad", password: "s", realm: "Broad" } },
  "/rules/ba-nested/admin/**": { basicAuth: { username: "admin", password: "s", realm: "Admin" } },
  "/rules/ba-off/**": { basicAuth: { username: "admin", password: "s", realm: "Off" } },
  "/rules/ba-off/*": { basicAuth: false },
  "/blog/**": { prerender: true, isr: 60 },
  "GET /api/cached/**": { swr: 60 },
  "/api/cached/**": { headers: { "x-all": "1" } },
  "/params/:section/**": { custom: { a: 1 } },
  "/params/:section/:id": { custom: { b: 2 } },
  "/**": { headers: { "x-catch": "all" } },
};

/**
 * Probe grid: method × path over interesting cases — deep merges, wildcards,
 * params, method fallbacks, encoded separators (dual-path lookups), misses.
 */
export const PROBES: Array<[method: string, pathname: string]> = [
  ["GET", "/rules/headers"],
  ["GET", "/rules/cors"],
  ["GET", "/rules/redirect"],
  ["GET", "/rules/redirect/obj"],
  ["GET", "/rules/redirect/wildcard/docs"],
  ["GET", "/rules/nested/override"],
  ["GET", "/rules/nested/base"],
  ["GET", "/rules/_/noncached/cached"],
  ["GET", "/rules/_/noncached/other"],
  ["GET", "/rules/_/cached/noncached"],
  ["GET", "/rules/_/cached/other"],
  ["POST", "/api/proxy/hello"],
  ["GET", "/rules/basic-auth/test"],
  ["GET", "/rules/basic-auth/no-auth/x"],
  ["GET", "/rules/ba-nested/admin%2fpanel"],
  ["GET", "/rules/ba-off/a"],
  ["GET", "/rules/ba-off/a%2fb"],
  ["GET", "/blog/post"],
  ["GET", "/api/cached/x"],
  ["POST", "/api/cached/x"],
  ["DELETE", "/api/cached/x"],
  ["GET", "/params/users/42"],
  ["POST", "/params/users/42"],
  ["GET", "/params/users/42/nested"],
  ["GET", "/params/users"],
  ["GET", "/unmatched-by-specific/x"],
  ["GET", "/"],
];
