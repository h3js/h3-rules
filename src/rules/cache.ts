import { defineHandler, handleCacheHeaders, toResponse } from "h3";
import type { EventHandler, H3Event } from "h3";
import { defineCachedHandler as ocacheDefineCachedHandler, setStorage } from "ocache";
import type { CachedEventHandlerOptions, StorageInterface } from "ocache";
import type { RuleHandler } from "../types.ts";

/**
 * A `defineCachedHandler`-compatible function: wraps an event handler so its
 * responses are cached. This is the injection point for consumers (e.g. Nitro)
 * that want their own storage / `useStorage()` wiring and cache conventions.
 */
export type DefineCachedHandler = (
  handler: EventHandler,
  opts: CachedEventHandlerOptions,
) => EventHandler;

/**
 * `cache` option for the matcher / `routeRules()`. All fields are optional; the
 * default uses ocache's in-memory storage out of the box.
 */
export interface CacheRuleOptions {
  /**
   * Full replacement for how cached handlers are created. When set, `storage`
   * and `defaults` below are ignored — the consumer owns the wiring. This is
   * what Nitro injects to keep its unstorage + `useStorage()` cache setup.
   */
  defineCachedHandler?: DefineCachedHandler;
  /** ocache storage implementation (minimal `get`/`set`). Applied via `setStorage`. */
  storage?: StorageInterface;
  /** Default ocache options merged into every cache rule (rule options win). */
  defaults?: CachedEventHandlerOptions;
}

const CACHE_GROUP = "h3-rules/route-rules";

// Build the effective `defineCachedHandler` for a matcher instance. Defaults to
// ocache wired with h3's `toResponse` / `handleCacheHeaders` so h3 handler return
// values (objects, streams, …) serialize with full fidelity. No srvx / unstorage
// dependency — global Response and ocache's in-memory storage by default.
function resolveDefineCachedHandler(opts: CacheRuleOptions | undefined): DefineCachedHandler {
  if (opts?.defineCachedHandler) {
    return opts.defineCachedHandler;
  }
  if (opts?.storage) {
    setStorage(opts.storage);
  }
  return (handler, cachedOpts) => {
    const ocacheHandler = ocacheDefineCachedHandler(handler, {
      toResponse: (value, event) => toResponse(value, event as H3Event),
      handleCacheHeaders: (event, conditions) => handleCacheHeaders(event as H3Event, conditions),
      ...cachedOpts,
    });
    return defineHandler((event) => ocacheHandler(event));
  };
}

/**
 * Create the `cache` rule handler for a matcher instance. Memoization of wrapped
 * handlers is **instance-scoped** (a closure `Map`, not a `globalThis` map), so
 * each matcher wraps a given route exactly once across requests.
 */
export function createCacheRuleHandler(opts?: CacheRuleOptions): RuleHandler<"cache"> {
  const defineCached = resolveDefineCachedHandler(opts);
  const defaults = opts?.defaults;
  const cachedHandlers = new Map<string, EventHandler>();

  return (m) =>
    function cacheRouteRule(event, next) {
      if (!event.context.matchedRoute) {
        return next();
      }
      const { handler, route } = event.context.matchedRoute;
      const key = `${m.route}:${route}`;
      let cachedHandler = cachedHandlers.get(key);
      if (!cachedHandler) {
        cachedHandler = defineCached(handler, {
          group: CACHE_GROUP,
          name: key,
          ...defaults,
          ...(m.options as CachedEventHandlerOptions),
        });
        cachedHandlers.set(key, cachedHandler);
      }
      return cachedHandler(event);
    };
}

/**
 * Shared default `cache` rule handler — the registry entry and the named export
 * compiled matchers import (`import { cache … } from "h3-rules"`), so its
 * memoization is module-scoped. Runtime matchers replace it with an
 * instance-scoped handler (see `createRouteRulesMatcher`); compiled consumers
 * needing custom wiring point `handlersImportId` at a module exporting their own
 * `createCacheRuleHandler(opts)` instance as `cache`.
 */
export const cache: RuleHandler<"cache"> = /* @__PURE__ */ createCacheRuleHandler();
