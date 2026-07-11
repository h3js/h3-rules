import type { EventHandler } from "h3";
import type { CacheRuleOptions, RuleHandler } from "../types.ts";

/**
 * Wraps an event handler so its responses are cached. This is the core
 * injection point: `h3-rules` itself ships no caching implementation — the
 * ocache-backed one lives in `h3-rules/cache` (optional `ocache` peer), and
 * consumers with their own cache conventions (e.g. Nitro's unstorage /
 * `useStorage()` wiring) inject theirs here instead.
 *
 * `opts` is the merged rule options plus the generated `group`/`name` key —
 * advanced implementation options passed through `defaults` reach it as extra
 * properties (typed at the call site, e.g. ocache's in `h3-rules/cache`).
 */
export type DefineCachedHandler = (handler: EventHandler, opts: CacheRuleOptions) => EventHandler;

/**
 * Options for {@link createCacheRuleHandler}. `defineCachedHandler` is
 * required — the core has no default caching implementation.
 */
export interface CacheRuleHandlerOptions {
  /** Creates the cached wrapper for a matched route handler. */
  defineCachedHandler: DefineCachedHandler;
  /** Default options merged into every cache rule (rule options win). */
  defaults?: CacheRuleOptions;
}

const CACHE_GROUP = "h3-rules/route-rules";

/**
 * Create the `cache` rule handler for a matcher instance from an injected
 * `defineCachedHandler`. Memoization of wrapped handlers is **instance-scoped**
 * (a closure `Map`, not a `globalThis` map), so each matcher wraps a given
 * route exactly once across requests.
 *
 * For the ready-made ocache-backed handler, use `h3-rules/cache` instead:
 * its `cache` export / `createCacheRuleHandler(opts)` wire ocache with h3's
 * `toResponse` / `handleCacheHeaders` glue.
 */
export function createCacheRuleHandler(opts: CacheRuleHandlerOptions): RuleHandler<"cache"> {
  const defineCached = opts.defineCachedHandler;
  const defaults = opts.defaults;
  const cachedHandlers = new Map<string, EventHandler>();

  return {
    handler: (m) =>
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
            ...m.options,
          });
          cachedHandlers.set(key, cachedHandler);
        }
        return cachedHandler(event);
      },
  };
}
