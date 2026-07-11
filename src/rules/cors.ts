import { handleCors } from "h3";
import type { CorsOptions } from "h3";
import type { RuleHandler } from "../types.ts";

// CORS route rule — delegates to h3's `handleCors`.
//
// Runs outermost (order: -3, outer to `basicAuth` at -2): a CORS *preflight*
// (`OPTIONS` + `Origin` + `Access-Control-Request-Method`) is answered directly
// with a 204 and the preflight policy headers, short-circuiting before auth,
// redirect, proxy and cache. Browsers send preflights without credentials, so
// gating them behind `basicAuth` would break CORS, and the preflight response
// carries only policy headers (no protected data).
//
// For a normal request `handleCors` appends the CORS response headers (to both
// `res` and `errHeaders`, so they survive an inner throw) and returns `false`,
// and the chain continues. A user `headers` rule (order -1, `.set`) still wins
// over any header CORS `.append`ed here.
export const cors: RuleHandler<"cors"> = {
  order: -3,
  handler: (m) =>
    function corsRouteRule(event, next) {
      const preflight = handleCors(event, (m.options || {}) as CorsOptions);
      return preflight === false ? next() : preflight;
    },
};
