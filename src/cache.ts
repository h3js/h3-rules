// `h3-rules/cache` — the ocache-backed `cache` rule handler. This is the only
// h3-rules module that imports ocache (an **optional** peer dependency):
// rule sets using `cache`/`swr` register a handler from here, everything else
// never pulls ocache into the bundle. Consumers with their own caching
// conventions skip this module entirely and inject a `defineCachedHandler`
// into the core `createCacheRuleHandler` (`h3-rules`) instead.

import { defineHandler, handleCacheHeaders, toResponse } from "h3";
import type { H3Event } from "h3";
import { defineCachedHandler as ocacheDefineCachedHandler, setStorage } from "ocache";
import type { CachedEventHandlerOptions, StorageInterface } from "ocache";
import { createCacheRuleHandler as createCoreCacheRuleHandler } from "./rules/cache.ts";
import type { RuleHandler } from "./types.ts";

/**
 * Options for the ocache-backed {@link createCacheRuleHandler}. All fields are
 * optional; the default uses ocache's in-memory storage out of the box.
 */
export interface OcacheRuleHandlerOptions {
  /** ocache storage implementation (minimal `get`/`set`). Applied via `setStorage`. */
  storage?: StorageInterface;
  /**
   * Default ocache options merged into every cache rule (rule options win).
   * Fully typed against ocache — implementation hooks (`getKey`, `shouldCache`,
   * `getMaxAge`, …) that the declarative rule schema excludes go here.
   */
  defaults?: CachedEventHandlerOptions;
}

/**
 * Create an ocache-backed `cache` rule handler: ocache wired with h3's
 * `toResponse` / `handleCacheHeaders` so h3 handler return values (objects,
 * streams, …) serialize with full fidelity. No srvx / unstorage dependency —
 * global `Response` and ocache's in-memory storage by default.
 *
 * Memoization of wrapped handlers is instance-scoped (see the core
 * `createCacheRuleHandler` in `h3-rules`) — create one handler per matcher.
 *
 * Note: ocache storage is process-global — `storage` mutates it via
 * `setStorage`, affecting every ocache consumer in the process.
 */
export function createCacheRuleHandler(opts?: OcacheRuleHandlerOptions): RuleHandler<"cache"> {
  if (opts?.storage) {
    setStorage(opts.storage);
  }
  return createCoreCacheRuleHandler({
    defineCachedHandler: (handler, cachedOpts) => {
      const ocacheHandler = ocacheDefineCachedHandler(handler, {
        toResponse: (value, event) => toResponse(value, event as H3Event),
        handleCacheHeaders: (event, conditions) => handleCacheHeaders(event as H3Event, conditions),
        ...cachedOpts,
      });
      return defineHandler((event) => ocacheHandler(event));
    },
    defaults: opts?.defaults,
  });
}

/**
 * Shared default ocache-backed `cache` rule handler — the named export
 * compiled matchers import (`import { cache } from "h3-rules/cache"`, the
 * `DEFAULT_RUNTIME_RULES` source for `cache`), so its memoization is
 * module-scoped. Runtime matchers register it explicitly
 * (`handlers: { cache }`); for custom wiring point `runtimeRules`
 * (`{ cache: "#your/cache" }`) / `handlers` at your own instance instead.
 */
export const cache: RuleHandler<"cache"> = /* @__PURE__ */ createCacheRuleHandler();
