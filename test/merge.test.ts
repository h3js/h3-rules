import { describe, expect, it, vi } from "vitest";
import { createMatcherFromFind, createRouteRulesMatcher } from "../src/match.ts";
import { mergeMatchedRouteRules } from "../src/merge.ts";
import type { RouteRuleLayer } from "../src/merge.ts";
import { normalizeRouteRules } from "../src/normalize.ts";
import type { RouteRuleConfig } from "../src/types.ts";
import { FIXTURE_HANDLERS } from "./_fixture.ts";

// The cascades below include cache/swr rules; register the fixture handler set
// (the core registry ships no `cache` handler).
const matcher = (config: Record<string, RouteRuleConfig>) =>
  createRouteRulesMatcher(normalizeRouteRules(config), { handlers: FIXTURE_HANDLERS });

describe("merge algorithm", () => {
  it("more specific patterns win (specificity ordering)", () => {
    const match = matcher({
      "/api/**": { headers: { "x-a": "broad" } },
      "/api/x": { headers: { "x-a": "narrow" } },
    });
    expect(match("GET", "/api/x").routeRules.headers!.options).toEqual({ "x-a": "narrow" });
    expect(match("GET", "/api/y").routeRules.headers!.options).toEqual({ "x-a": "broad" });
  });

  it("object options shallow-merge across layers", () => {
    const match = matcher({
      "/api/**": { headers: { "x-a": "1", "x-b": "1" } },
      "/api/x": { headers: { "x-b": "2", "x-c": "2" } },
    });
    expect(match("GET", "/api/x").routeRules.headers!.options).toEqual({
      "x-a": "1",
      "x-b": "2",
      "x-c": "2",
    });
  });

  it("non-object options override", () => {
    const match = matcher({
      "/api/**": { custom: { nested: true } },
      "/api/x": { custom: "flat" },
    });
    expect(match("GET", "/api/x").routeRules.custom!.options).toBe("flat");
  });

  it("`null` options override an inherited object (typeof null quirk)", () => {
    // `typeof null === "object"`: a spread-merge would silently keep the
    // inherited object; `null` must behave like any other non-object override.
    const match = matcher({
      "/api/**": { custom: { x: 1 } },
      "/api/x": { custom: null },
    });
    expect(match("GET", "/api/x").routeRules.custom!.options).toBe(null);
    expect(match("GET", "/api/y").routeRules.custom!.options).toEqual({ x: 1 });
  });

  it("`redirect: false` / `proxy: false` reset inherited rules", () => {
    const match = matcher({
      "/old/**": { redirect: "/new", proxy: "/upstream" },
      "/old/keep/**": { redirect: false, proxy: false },
    });
    const inherited = match("GET", "/old/x");
    expect(inherited.routeRules.redirect).toBeDefined();
    expect(inherited.routeRules.proxy).toBeDefined();
    const reset = match("GET", "/old/keep/x");
    expect(reset.routeRules.redirect).toBeUndefined();
    expect(reset.routeRules.proxy).toBeUndefined();
    expect(reset.routeRuleMiddleware).toHaveLength(0);
  });

  it("params stay undefined when no matched layer carries params", () => {
    // Multi-layer merges must not materialize a phantom `{}` (also keeps plain
    // and preMerge results structurally identical).
    const match = matcher({
      "/a": { headers: { x: "agnostic" } },
      "GET /a": { headers: { x: "get" } },
    });
    const rule = match("GET", "/a").routeRules.headers!;
    expect(rule.options).toEqual({ x: "get" });
    expect(rule.params).toBeUndefined();
  });

  it("`false` resets an inherited rule (noncached cascade)", () => {
    // Mirrors the Nitro fixture `/rules/_/noncached/**` + `/rules/_/noncached/cached`
    const match = matcher({
      "/rules/_/noncached/cached": { swr: true },
      "/rules/_/noncached/**": { swr: false, cache: false },
      "/rules/_/cached/noncached": { cache: false, swr: false },
      "/rules/_/cached/**": { swr: true },
    });
    // `cache: false` on the subtree resets, the more specific rule re-adds
    expect(match("GET", "/rules/_/noncached/cached").routeRules.cache!.options).toEqual({
      swr: true,
    });
    expect(match("GET", "/rules/_/noncached/other").routeRules.cache).toBeUndefined();
    // inherited cache reset by a more specific `false`
    expect(match("GET", "/rules/_/cached/noncached").routeRules.cache).toBeUndefined();
    expect(match("GET", "/rules/_/cached/other").routeRules.cache!.options).toEqual({
      swr: true,
    });
  });

  it("bare `swr: false` disables an inherited swr cache rule", () => {
    // A broad rule expands `swr` -> `cache`; a more specific rule sets bare
    // `swr: false` WITHOUT an explicit `cache: false`. The reset must still fire.
    const match = matcher({
      "/**": { swr: 3600 },
      "/api/test": { swr: false },
    });
    expect(match("GET", "/api/other").routeRules.cache!.options).toMatchObject({
      swr: true,
      maxAge: 3600,
    });
    expect(match("GET", "/api/test").routeRules.cache).toBeUndefined();
  });

  it("`false` on the most specific layer yields no middleware for that rule", () => {
    const match = matcher({
      "/rules/basic-auth/**": { basicAuth: { username: "admin", password: "secret" } },
      "/rules/basic-auth/no-auth/**": { basicAuth: false },
    });
    const on = match("GET", "/rules/basic-auth/test");
    expect(on.routeRules.basicAuth).toBeDefined();
    expect(on.routeRuleMiddleware).toHaveLength(1);
    const off = match("GET", "/rules/basic-auth/no-auth/x");
    expect(off.routeRules.basicAuth).toBeUndefined();
    expect(off.routeRuleMiddleware).toHaveLength(0);
  });

  it("route and params take the more specific match's values (params merged)", () => {
    const match = matcher({
      "/api/:section/**": { custom: { a: 1 } },
      "/api/:section/:id": { custom: { b: 2 } },
    });
    const { routeRules } = match("GET", "/api/users/42");
    expect(routeRules.custom!.route).toBe("/api/:section/:id");
    expect(routeRules.custom!.params).toMatchObject({ section: "users", id: "42" });
    expect(routeRules.custom!.options).toEqual({ a: 1, b: 2 });
  });

  it("middleware is sorted by handler order (basicAuth first)", () => {
    const match = matcher({
      "/app/**": { redirect: "/login", basicAuth: { username: "u", password: "p" } },
    });
    const { routeRules, routeRuleMiddleware } = match("GET", "/app/x");
    expect(routeRuleMiddleware).toHaveLength(2);
    // basicAuth has order -2 (outer to headers at -1): its middleware comes first
    expect(routeRules.basicAuth!.handler!.order).toBe(-2);
    expect(routeRuleMiddleware[0]).toBe(
      routeRuleMiddleware.find((mw) => mw.name === "authRouteRule"),
    );
  });

  it("sorts middleware by numeric handler order (ascending, custom bands mixed with defaults)", () => {
    const mk = (name: string) => ({
      // name the produced middleware so the resulting order is observable
      handler: () => Object.defineProperty(() => undefined, "name", { value: name }),
    });
    const match = createRouteRulesMatcher(
      normalizeRouteRules({
        "/x": { isr: true, custom: true, tags: true, shout: true, "my-rule": true },
      }),
      {
        handlers: {
          isr: { ...mk("isr"), order: 2 },
          custom: { ...mk("custom"), order: -5 }, // outer to all built-ins
          tags: { ...mk("tags"), order: -1 }, // the `headers` band
          shout: mk("shout"), // default 0
          "my-rule": { ...mk("my-rule"), order: 1 },
        },
      },
    );
    const { routeRuleMiddleware } = match("GET", "/x");
    expect(routeRuleMiddleware.map((mw) => mw.name)).toEqual([
      "custom", // -5
      "tags", // -1
      "shout", // 0
      "my-rule", // 1
      "isr", // 2
    ]);
  });

  it("data-only rules are merged but produce no middleware", () => {
    const match = matcher({
      "/blog/**": { prerender: true, isr: 60 },
    });
    const { routeRules, routeRuleMiddleware } = match("GET", "/blog/post");
    expect(routeRules.prerender!.options).toBe(true);
    expect(routeRules.isr!.options).toBe(60);
    expect(routeRuleMiddleware).toHaveLength(0);
  });
});

describe("method-scoped rules", () => {
  it("apply only to their method", () => {
    const match = matcher({
      "GET /api/**": { headers: { "x-m": "get" } },
    });
    expect(match("GET", "/api/x").routeRules.headers!.options).toEqual({ "x-m": "get" });
    expect(match("POST", "/api/x").routeRules.headers).toBeUndefined();
  });

  it("merge after (override) method-agnostic rules for the same pattern", () => {
    const match = matcher({
      "/api/**": { headers: { "x-a": "all", "x-b": "all" } },
      "GET /api/**": { headers: { "x-b": "get" } },
    });
    // GET: agnostic merges first, method-scoped overrides on top
    expect(match("GET", "/api/x").routeRules.headers!.options).toEqual({
      "x-a": "all",
      "x-b": "get",
    });
    // Other methods: agnostic rule only
    expect(match("POST", "/api/x").routeRules.headers!.options).toEqual({
      "x-a": "all",
      "x-b": "all",
    });
  });

  it("method-scoped `false` resets an agnostic rule for that method only", () => {
    const match = matcher({
      "/api/**": { basicAuth: { username: "u", password: "p" } },
      "GET /api/**": { basicAuth: false },
    });
    expect(match("GET", "/api/x").routeRules.basicAuth).toBeUndefined();
    expect(match("POST", "/api/x").routeRules.basicAuth).toBeDefined();
  });

  it("method-agnostic-only rule sets behave identically for all methods", () => {
    const match = matcher({
      "/api/**": { headers: { "x-a": "1" } },
    });
    for (const method of ["GET", "POST", "PUT", "DELETE", ""]) {
      expect(match(method, "/api/x").routeRules.headers!.options).toEqual({ "x-a": "1" });
    }
  });
});

describe("dual-path union (Nitro #4396)", () => {
  it("canonical-path match adds a rule the raw path missed", () => {
    // `/app/admin%2fpanel` is served by the broad rule on the raw path but
    // canonicalizes to `/app/admin/panel`, which the auth rule guards.
    const match = matcher({
      "/app/**": { headers: { "x-app": "1" } },
      "/app/admin/**": { basicAuth: { username: "admin", password: "secret" } },
    });
    const { routeRules } = match("GET", "/app/admin%2fpanel");
    expect(routeRules.headers!.options).toEqual({ "x-app": "1" });
    expect(routeRules.basicAuth!.options).toMatchObject({ username: "admin" });
  });

  it("a %5c separator is canonicalized at the matcher level too", () => {
    // h3/srvx already decode `%5c` in `event.url.pathname`, so the e2e suite
    // cannot reach this branch — pin the matcher-level dual-path handling
    // directly.
    const match = matcher({
      "/app/**": { headers: { "x-app": "1" } },
      "/app/admin/**": { basicAuth: { username: "admin", password: "secret" } },
    });
    const { routeRules } = match("GET", "/app/admin%5cpanel");
    expect(routeRules.headers!.options).toEqual({ "x-app": "1" });
    expect(routeRules.basicAuth!.options).toMatchObject({ username: "admin" });
  });

  it("canonical rule overrides raw on overlap (more specific wins)", () => {
    // Mirrors `/rules/ba-nested/**` (Broad Area) + `/rules/ba-nested/admin/**`
    // (Admin Area): the narrower canonical realm must win.
    const match = matcher({
      "/rules/ba-nested/**": {
        basicAuth: { username: "broad", password: "secret", realm: "Broad Area" },
      },
      "/rules/ba-nested/admin/**": {
        basicAuth: { username: "admin", password: "secret", realm: "Admin Area" },
      },
    });
    const { routeRules } = match("GET", "/rules/ba-nested/admin%2fpanel");
    expect(routeRules.basicAuth!.options).toMatchObject({ realm: "Admin Area" });
  });

  it("a single-segment `false` cannot dodge auth once decoded to multiple segments", () => {
    // Mirrors `/rules/ba-off/*` + `/rules/ba-off/**`: the `false` reset applies
    // to the served path's own resolution, but the canonical path still enables
    // auth.
    const match = matcher({
      "/rules/ba-off/**": {
        basicAuth: { username: "admin", password: "secret", realm: "Off Area" },
      },
      "/rules/ba-off/*": { basicAuth: false },
    });
    // genuine single segment: auth disabled
    expect(match("GET", "/rules/ba-off/a").routeRules.basicAuth).toBeUndefined();
    // encoded separator: canonical two-segment path re-enables auth
    const { routeRules } = match("GET", "/rules/ba-off/a%2fb");
    expect(routeRules.basicAuth!.options).toMatchObject({ realm: "Off Area" });
  });

  it("a `false` reset on the canonical path never strips a rule the raw path resolved", () => {
    // Mirrors `/rules/ba-strip/**` + `/rules/ba-strip/off/**`: the served path
    // (single opaque segment) matches the broad auth rule; the canonical path's
    // `false` (targeting the two-segment subtree) must not delete it.
    const match = matcher({
      "/rules/ba-strip/**": {
        basicAuth: { username: "admin", password: "secret", realm: "Strip Area" },
      },
      "/rules/ba-strip/off/**": { basicAuth: false },
    });
    const { routeRules } = match("GET", "/rules/ba-strip/off%2fx");
    expect(routeRules.basicAuth!.options).toMatchObject({ realm: "Strip Area" });
    // genuine two-segment path: auth disabled as configured
    expect(match("GET", "/rules/ba-strip/off/x").routeRules.basicAuth).toBeUndefined();
  });

  it("a `..` next to an encoded separator cannot dodge a narrower gate on a slash-merging downstream", () => {
    // Report vuln-12006 (HackerOne #3721382): h3's canonical form keeps the
    // empty segment a `..` adjacent to an encoded separator produces
    // (`/api/foo/%2e%2e/%2fadmin/secret` → `/api//admin/secret`), so rou3's
    // per-segment match misses `/api/admin/**` and `basicAuth` never runs — yet a
    // downstream that decodes `%2f` then merges slashes resolves it to
    // `/api/admin/secret`. The matcher must also match the slash-merged canonical
    // reading (`/api/admin/secret`), like `isPathInScope` already does for scope.
    const match = matcher({
      "/api/**": { headers: { "x-app": "1" } },
      "/api/admin/**": { basicAuth: { username: "admin", password: "secret" } },
    });
    // Baseline: the raw and canonical-only variants already fire.
    expect(match("GET", "/api/admin/secret").routeRules.basicAuth).toBeDefined();
    expect(match("GET", "/api/foo/%2e%2e%2fadmin/secret").routeRules.basicAuth).toBeDefined();
    expect(match("GET", "/api/foo/..%2fadmin/secret").routeRules.basicAuth).toBeDefined();
    // The surviving bypass: `..` separated from `%2f` by a literal `/`.
    for (const payload of [
      "/api/foo/%2e%2e/%2fadmin/secret",
      "/api/foo/..%2f%2fadmin/secret",
      "/api/foo/%2e%2e%2f%2fadmin/secret",
      "/api/foo/%2e%2e/%5cadmin/secret",
      "/api/foo/%252e%252e/%252fadmin/secret",
    ]) {
      const { routeRules } = match("GET", payload);
      expect(routeRules.basicAuth, payload).toBeDefined();
      expect(routeRules.basicAuth!.options, payload).toMatchObject({ username: "admin" });
      // union-only: the broad rule the raw path resolved is never stripped.
      expect(routeRules.headers!.options, payload).toEqual({ "x-app": "1" });
    }
  });

  it("the slash-merged lookup never strips a rule the raw path resolved (union-only)", () => {
    // A benign doubled slash whose merged canonical form lands on a `false`-reset
    // subtree must not delete the rule the served path resolved.
    const match = matcher({
      "/api/**": {
        basicAuth: { username: "admin", password: "secret", realm: "Broad" },
      },
      "/api/off/**": { basicAuth: false },
    });
    // Raw path stays a single opaque segment under `/api/**`; the merged reading
    // (`/api/off/x`) hits the reset but union-only must keep the broad rule.
    const { routeRules } = match("GET", "/api/off%2f%2fx");
    expect(routeRules.basicAuth!.options).toMatchObject({ realm: "Broad" });
  });

  it("a single-wildcard rule still applies to a raw path with an encoded separator", () => {
    // Mirrors `/single-headers/*`: h3 serves the raw single-segment path, so
    // rules matched there must not be dropped by canonicalization.
    const match = matcher({
      "/single-headers/*": { headers: { "x-single": "single" } },
    });
    const { routeRules } = match("GET", "/single-headers/a%2fb");
    expect(routeRules.headers!.options).toEqual({ "x-single": "single" });
  });

  it("skips the second lookup when canonical === raw (fast path)", () => {
    const findRouteRules = vi.fn(() => [] as RouteRuleLayer[]);
    const match = createMatcherFromFind(findRouteRules);
    match("GET", "/plain/path");
    expect(findRouteRules).toHaveBeenCalledTimes(1);
    findRouteRules.mockClear();
    match("GET", "/enc%2foded");
    expect(findRouteRules).toHaveBeenCalledTimes(2);
    expect(findRouteRules).toHaveBeenNthCalledWith(2, "GET", "/enc/oded");
  });
});

describe("mergeMatchedRouteRules (pure)", () => {
  const layer = (
    route: string,
    entries: Array<{ name: string; options: unknown }>,
    params?: Record<string, string>,
  ): RouteRuleLayer => ({
    data: entries.map((e) => ({ ...e, route })),
    params,
  });

  it("merges layers least → most specific", () => {
    const merged = mergeMatchedRouteRules([
      layer("/a/**", [{ name: "headers", options: { a: "1" } }]),
      layer("/a/b", [{ name: "headers", options: { a: "2", b: "2" } }]),
    ]);
    expect(merged.headers!.options).toEqual({ a: "2", b: "2" });
    expect(merged.headers!.route).toBe("/a/b");
  });

  it("unions canonical layers without deleting raw rules", () => {
    const merged = mergeMatchedRouteRules(
      [layer("/a/**", [{ name: "headers", options: { a: "raw" } }])],
      [
        layer("/a/**", [{ name: "headers", options: { a: "raw" } }]),
        layer("/a/b/**", [
          { name: "headers", options: false },
          { name: "basicAuth", options: { username: "u" } },
        ]),
      ],
    );
    // canonical `false` resolved within its own pass deletes there, but the
    // union can never delete what the raw path resolved
    expect(merged.headers!.options).toEqual({ a: "raw" });
    expect(merged.basicAuth!.options).toEqual({ username: "u" });
  });

  it("returns empty map for no layers", () => {
    expect(mergeMatchedRouteRules(undefined)).toEqual({});
    expect(mergeMatchedRouteRules([], [])).toEqual({});
  });
});
