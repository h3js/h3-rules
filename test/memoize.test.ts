import { H3 } from "h3";
import { describe, expect, it, vi } from "vitest";
import { routeRules } from "../src/h3.ts";
import {
  createMatcherFromFind,
  createRouteRulesMatcher,
  memoizeRouteRulesMatcher,
} from "../src/match.ts";
import type { RouteRuleLayer } from "../src/merge.ts";
import { normalizeRouteRules } from "../src/normalize.ts";
import type { RouteRuleConfig } from "../src/types.ts";

const RULES: Record<string, RouteRuleConfig> = {
  "/**": { headers: { "x-catch": "all" } },
  "/api/**": { cors: true },
  "/api/:section/:id": { custom: { a: 1 } },
  "/admin/**": { basicAuth: { username: "a", password: "b" } },
};

describe("memoizeRouteRulesMatcher", () => {
  it("returns results identical to the unmemoized matcher", () => {
    const plain = createRouteRulesMatcher(normalizeRouteRules(RULES));
    const memoized = createRouteRulesMatcher(normalizeRouteRules(RULES), { memoize: true });
    for (const [method, path] of [
      ["GET", "/api/users/42"],
      ["GET", "/api/users/42"], // repeat (memo hit)
      ["POST", "/api/users/42"], // method is part of the key
      ["GET", "/admin/panel"],
      ["GET", "/admin%2fpanel"], // encoded separator still resolves dual-path
      ["GET", "/plain"],
    ] as const) {
      const a = plain(method, path);
      const b = memoized(method, path);
      expect(Object.keys(b.routeRules)).toEqual(Object.keys(a.routeRules));
      for (const name of Object.keys(a.routeRules)) {
        expect(b.routeRules[name]!.options).toEqual(a.routeRules[name]!.options);
        expect(b.routeRules[name]!.params).toEqual(a.routeRules[name]!.params);
        expect(b.routeRules[name]!.route).toBe(a.routeRules[name]!.route);
      }
      expect(b.routeRuleMiddleware).toHaveLength(a.routeRuleMiddleware.length);
    }
  });

  it("resolves each method + pathname only once", () => {
    const find = vi.fn(() => [] as RouteRuleLayer[]);
    const matcher = createMatcherFromFind(find, { memoize: true });
    matcher("GET", "/a");
    matcher("GET", "/a");
    matcher("GET", "/a");
    expect(find).toHaveBeenCalledTimes(1);
    matcher("POST", "/a"); // different method → separate entry
    expect(find).toHaveBeenCalledTimes(2);
    matcher("GET", "/b");
    expect(find).toHaveBeenCalledTimes(3);
  });

  it("memo entries are keyed on the raw pathname, never the canonical one", () => {
    // `/x/off/a` (auth reset by `/x/off/**`) and `/x/off%2fa` (raw single
    // opaque segment: the canonical `false` may not strip the broad auth rule)
    // canonicalize to the same path but must resolve differently. Keying the
    // memo on the canonical path collapses them into one entry: whichever is
    // requested first wins — an auth bypass for the encoded path in one order,
    // a spurious 401 for the legitimately auth-free path in the other.
    const rules = normalizeRouteRules({
      "/x/**": { basicAuth: { username: "a", password: "b" } },
      "/x/off/**": { basicAuth: false },
    });
    for (const order of [
      ["/x/off/a", "/x/off%2fa"],
      ["/x/off%2fa", "/x/off/a"],
    ]) {
      const memoized = createRouteRulesMatcher(rules, { memoize: true });
      for (const path of order) memoized("GET", path);
      expect(memoized("GET", "/x/off/a").routeRules.basicAuth).toBeUndefined();
      expect(memoized("GET", "/x/off%2fa").routeRules.basicAuth).toBeDefined();
    }
  });

  it("returns the same result object for repeat requests (shared)", () => {
    const matcher = createRouteRulesMatcher(normalizeRouteRules(RULES), { memoize: true });
    expect(matcher("GET", "/api/x")).toBe(matcher("GET", "/api/x"));
  });

  it("evicts FIFO past the entry cap and re-resolves evicted paths", () => {
    let calls = 0;
    const memoized = memoizeRouteRulesMatcher(
      () => (calls++, { routeRules: {}, routeRuleMiddleware: [] }),
      { max: 2 },
    );
    memoized("GET", "/1"); // calls=1
    memoized("GET", "/2"); // calls=2 (cap reached)
    memoized("GET", "/3"); // calls=3, evicts /1
    expect(calls).toBe(3);
    memoized("GET", "/3"); // hit
    expect(calls).toBe(3);
    memoized("GET", "/1"); // evicted → re-resolved
    expect(calls).toBe(4);
  });

  it("defaults the entry cap to 1024", () => {
    let calls = 0;
    const memoized = memoizeRouteRulesMatcher(
      () => (calls++, { routeRules: {}, routeRuleMiddleware: [] }),
    );
    for (let i = 0; i < 1024; i++) memoized("GET", `/p/${i}`);
    expect(calls).toBe(1024);
    memoized("GET", "/p/0"); // still memoized at exactly the cap
    expect(calls).toBe(1024);
    memoized("GET", "/p/1024"); // 1025th entry evicts the oldest (/p/0)
    memoized("GET", "/p/0"); // → re-resolved
    expect(calls).toBe(1026);
  });

  it("a non-positive cap disables memoization (not a cap of 1)", () => {
    for (const max of [0, -1]) {
      let calls = 0;
      const memoized = memoizeRouteRulesMatcher(
        () => (calls++, { routeRules: {}, routeRuleMiddleware: [] }),
        { max },
      );
      memoized("GET", "/a");
      memoized("GET", "/a");
      expect(calls).toBe(2);
    }
  });

  it("works end-to-end through routeRules() with memoize enabled", async () => {
    const app = new H3();
    app.use(routeRules(RULES, { memoize: true }));
    app.get("/api/:section/:id", (event) => ({
      params: event.context.routeRules?.custom?.params,
      cors: event.res.headers.get("access-control-allow-origin"),
    }));
    for (let i = 0; i < 3; i++) {
      const res = await app.fetch(new Request("http://test/api/users/42"));
      expect(await res.json()).toEqual({ params: { section: "users", id: "42" }, cors: "*" });
    }
    // encoded separator still hits the canonical auth gate when memoized
    const guarded = await app.fetch(new Request("http://test/admin%2fpanel"));
    expect(guarded.status).toBe(401);
    const guardedAgain = await app.fetch(new Request("http://test/admin%2fpanel"));
    expect(guardedAgain.status).toBe(401);
  });
});
