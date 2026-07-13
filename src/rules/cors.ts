import { handleCors } from "h3";
import type { CorsOptions } from "h3";
import type { RuleHandler } from "../types.ts";

let warnedCredentialsWildcard = false;

// Post-merge defense for the `credentials: true` + wildcard-origin invariant.
//
// `normalizeRouteRules` rejects that pair per config key, but merge layers
// least→most specific with a *shallow* option merge (`mergeRuleOptions`), so a
// broad `{ credentials: true, origin: [...] }` narrowed by a more specific
// `{ origin: "*" }` re-forms the forbidden combo *after* normalization, which
// never re-runs. h3 would then emit `Access-Control-Allow-Origin: *` together
// with `Access-Control-Allow-Credentials: true` — a response browsers reject.
//
// Neutralize it here (the one point that consumes merged CORS options), matching
// h3's own `createOriginHeaders` wildcard condition exactly: `*` is emitted only
// when `origin` is unset or the scalar `"*"`. Array allowlists never yield a
// wildcard ACAO (h3 reflects specific origins), so a credentialed array origin
// stays intact. Drop `credentials` rather than throw per-request: the result is
// a valid public (non-credentialed) CORS response instead of a browser-rejected
// invalid one.
function safeCorsOptions(options: CorsOptions): CorsOptions {
  const { origin, credentials } = options;
  if (credentials === true && (origin === undefined || origin === "*")) {
    if (!warnedCredentialsWildcard) {
      warnedCredentialsWildcard = true;
      console.warn(
        "[h3-rules] `cors` rule resolved to `credentials: true` with a wildcard origin after merge — dropping `credentials` (an `Access-Control-Allow-Origin: *` + credentials response is rejected by browsers). Set an explicit `origin` allowlist on the more specific rule.",
      );
    }
    return { ...options, credentials: false };
  }
  return options;
}

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
      const preflight = handleCors(event, safeCorsOptions((m.options || {}) as CorsOptions));
      return preflight === false ? next() : preflight;
    },
};
