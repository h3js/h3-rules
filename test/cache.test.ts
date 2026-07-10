import { H3 } from "h3";
import type { EventHandler } from "h3";
import { describe, expect, it, vi } from "vitest";
import { routeRules } from "../src/h3.ts";
import type { RouteRuleConfig } from "../src/types.ts";
import { createCacheRuleHandler } from "../src/rules/cache.ts";
import type { CacheRuleOptions } from "../src/rules/cache.ts";

const createApp = (config: Record<string, RouteRuleConfig>, cache?: CacheRuleOptions) => {
  const app = new H3();
  app.use(
    routeRules(config, cache ? { handlers: { cache: createCacheRuleHandler(cache) } } : undefined),
  );
  return app;
};

describe("cache rule", () => {
  it("caches the matched route handler end-to-end (default ocache path)", async () => {
    let calls = 0;
    const app = createApp({ "/cached-default/**": { swr: true, cache: { maxAge: 60 } } });
    app.get("/cached-default/:id", () => ({ calls: ++calls }));

    const first = await app.fetch(new Request("http://test/cached-default/a"));
    expect(await first.json()).toEqual({ calls: 1 });
    const second = await app.fetch(new Request("http://test/cached-default/a"));
    expect(await second.json()).toEqual({ calls: 1 }); // served from cache
    expect(calls).toBe(1);
  });

  it("does not cache without a matched route (falls through to next)", async () => {
    const app = createApp({ "/cached-nomatch/**": { cache: { maxAge: 60 } } });
    // no route registered — middleware must call next() and 404
    const res = await app.fetch(new Request("http://test/cached-nomatch/x"));
    expect(res.status).toBe(404);
  });

  it("cache: false on a nested pattern disables caching", async () => {
    let calls = 0;
    const app = createApp({
      "/cached-off/**": { cache: { maxAge: 60 } },
      "/cached-off/dynamic": { cache: false },
    });
    app.get("/cached-off/dynamic", () => ({ calls: ++calls }));
    await app.fetch(new Request("http://test/cached-off/dynamic"));
    const res = await app.fetch(new Request("http://test/cached-off/dynamic"));
    expect(await res.json()).toEqual({ calls: 2 }); // not cached
  });

  it("honors a full defineCachedHandler replacement", async () => {
    const defineCachedHandler = vi.fn(
      (handler: EventHandler, _opts: unknown): EventHandler =>
        (event) => {
          event.res.headers.set("x-custom-cache", "1");
          return handler(event);
        },
    );
    const app = createApp(
      { "/cached-custom/**": { cache: { maxAge: 5 } } },
      { defineCachedHandler },
    );
    app.get("/cached-custom/:id", () => "ok");

    const res = await app.fetch(new Request("http://test/cached-custom/a"));
    expect(res.headers.get("x-custom-cache")).toBe("1");
    expect(defineCachedHandler).toHaveBeenCalledTimes(1);
    expect(defineCachedHandler.mock.calls[0]![1]).toMatchObject({
      group: "h3-rules/route-rules",
      maxAge: 5,
    });
  });

  it("merges `defaults` under rule options (rule options win)", async () => {
    const defineCachedHandler = vi.fn(
      (handler: EventHandler, _opts: unknown): EventHandler => handler,
    );
    const app = createApp(
      { "/cached-defaults/**": { cache: { maxAge: 5 } } },
      { defineCachedHandler, defaults: { maxAge: 99, staleMaxAge: 10 } },
    );
    app.get("/cached-defaults/:id", () => "ok");
    await app.fetch(new Request("http://test/cached-defaults/a"));
    expect(defineCachedHandler.mock.calls[0]![1]).toMatchObject({
      maxAge: 5, // rule option wins over defaults
      staleMaxAge: 10, // default preserved
    });
  });

  it("wraps the same route exactly once across requests (memoization)", async () => {
    const defineCachedHandler = vi.fn((handler: EventHandler): EventHandler => handler);
    const app = createApp(
      { "/cached-memo/**": { cache: { maxAge: 60 } } },
      { defineCachedHandler },
    );
    app.get("/cached-memo/:id", () => "ok");

    await app.fetch(new Request("http://test/cached-memo/a"));
    await app.fetch(new Request("http://test/cached-memo/a"));
    await app.fetch(new Request("http://test/cached-memo/b"));
    // same rule route + same matched route → single wrap
    expect(defineCachedHandler).toHaveBeenCalledTimes(1);
  });

  it("memoization is instance-scoped, not global", async () => {
    const wrap1 = vi.fn((handler: EventHandler): EventHandler => handler);
    const wrap2 = vi.fn((handler: EventHandler): EventHandler => handler);
    const app1 = createApp(
      { "/cached-inst/**": { cache: { maxAge: 60 } } },
      { defineCachedHandler: wrap1 },
    );
    const app2 = createApp(
      { "/cached-inst/**": { cache: { maxAge: 60 } } },
      { defineCachedHandler: wrap2 },
    );
    app1.get("/cached-inst/:id", () => "one");
    app2.get("/cached-inst/:id", () => "two");

    await app1.fetch(new Request("http://test/cached-inst/a"));
    await app2.fetch(new Request("http://test/cached-inst/a"));
    // each matcher instance wraps independently (no shared/global map)
    expect(wrap1).toHaveBeenCalledTimes(1);
    expect(wrap2).toHaveBeenCalledTimes(1);
  });

  it("lets a `headers` cache-control override win over the cache handler (post-cache order)", async () => {
    // Regression for h3js/h3-rules#5: the cache handler returns its own Response
    // (and ocache computes `cache-control`), so a request-phase header set would
    // be clobbered. `headers` runs post-response (order -1), applying over the
    // cached response on both the miss and the subsequent hit.
    let calls = 0;
    const app = createApp({
      "/cached-headers/**": {
        cache: { swr: true, maxAge: 60 },
        headers: { "cache-control": "public, max-age=1", "x-extra": "1" },
      },
    });
    app.get("/cached-headers/:id", () => ({ calls: ++calls }));

    // miss: handler runs, response cached, but our headers still win
    const first = await app.fetch(new Request("http://test/cached-headers/a"));
    expect(await first.json()).toEqual({ calls: 1 });
    expect(first.headers.get("cache-control")).toBe("public, max-age=1");
    expect(first.headers.get("x-extra")).toBe("1");

    // hit: served from cache (handler not re-run), headers still applied
    const second = await app.fetch(new Request("http://test/cached-headers/a"));
    expect(await second.json()).toEqual({ calls: 1 });
    expect(second.headers.get("cache-control")).toBe("public, max-age=1");
    expect(second.headers.get("x-extra")).toBe("1");
    expect(calls).toBe(1);
  });

  it("never caches or serves cached bodies to unauthorized requests (basicAuth order -1)", async () => {
    let calls = 0;
    const app = createApp({
      "/cached-auth/**": {
        cache: { maxAge: 60 },
        basicAuth: { username: "u", password: "p", realm: "R" },
      },
    });
    app.get("/cached-auth/:id", () => ({ calls: ++calls }));

    // unauthorized before anything is cached: 401, handler never runs
    const unauth = await app.fetch(new Request("http://test/cached-auth/a"));
    expect(unauth.status).toBe(401);
    expect(calls).toBe(0);

    // authorized: handler runs, response is cached
    const auth = { Authorization: "Basic " + btoa("u:p") };
    const ok = await app.fetch(new Request("http://test/cached-auth/a", { headers: auth }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ calls: 1 });

    // entry is cached now — an unauthorized request must still 401,
    // never be served the cached body
    const unauthAfter = await app.fetch(new Request("http://test/cached-auth/a"));
    expect(unauthAfter.status).toBe(401);
    expect(calls).toBe(1);

    // and the cache still serves authorized requests
    const okAgain = await app.fetch(new Request("http://test/cached-auth/a", { headers: auth }));
    expect(await okAgain.json()).toEqual({ calls: 1 });
  });

  // NOTE: keep this test last — the `storage` matcher option mutates ocache's
  // process-global storage (`setStorage`), so it would leak into the
  // default-ocache-path tests above if it ran first.
  it("honors a consumer-provided storage", async () => {
    const store = new Map<string, unknown>();
    const storage = {
      get: vi.fn((key: string) => store.get(key) ?? null),
      set: vi.fn((key: string, value: unknown) => {
        store.set(key, value);
      }),
    };
    let handlerCalls = 0;
    const app = createApp(
      { "/cached-storage/**": { cache: { maxAge: 60 } } },
      { storage: storage as CacheRuleOptions["storage"] },
    );
    app.get("/cached-storage/:id", () => (++handlerCalls, "stored"));

    const first = await app.fetch(new Request("http://test/cached-storage/a"));
    expect(await first.text()).toBe("stored");
    expect(storage.set).toHaveBeenCalled();
    const key = storage.set.mock.calls[0]![0] as string;
    expect(key).toContain("h3-rules/route-rules");

    // second fetch: served from the provided storage, not the handler
    storage.get.mockClear();
    const second = await app.fetch(new Request("http://test/cached-storage/a"));
    expect(await second.text()).toBe("stored");
    expect(storage.get).toHaveBeenCalled();
    expect(handlerCalls).toBe(1);
  });
});
