import type { RuleHandler } from "../types.ts";

// Headers route rule.
//
// Runs post-response (order: -1, outer to `cache`/`redirect`/`proxy` at 0): it
// awaits `next()` and only then sets the headers, so they land on the *final*
// response even when an inner rule short-circuits the chain. `cache` returns
// its own Response without calling `next()`, and ocache overwrites
// `cache-control` on the cached entry — a request-phase set would be consumed
// by the cache handler's inner `toResponse` and clobbered (h3js/h3-rules#5).
// Setting on a fresh `event.res` after the cache handler is done lets h3's
// outer `prepareResponse` merge these over the (cached) response headers, so a
// user `cache-control` wins.
//
// `basicAuth` (order -2) is outer to this, so it gates first: on auth failure it
// throws before `headers` runs, so unauthorized responses never carry these.
export const headers: RuleHandler<"headers"> = {
  order: -1,
  handler: (m) =>
    async function headersRouteRule(event, next) {
      const response = await next();
      for (const [key, value] of Object.entries(m.options || {})) {
        event.res.headers.set(key, value);
      }
      return response;
    },
};
