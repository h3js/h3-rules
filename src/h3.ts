import { callMiddleware } from "h3";
import type { Middleware } from "h3";
import { createRouteRulesMatcher } from "./match.ts";
import type { RouteRulesMatcherOptions } from "./match.ts";
import { normalizeRouteRules } from "./normalize.ts";
import type { MatchedRouteRules, RouteRuleConfig } from "./types.ts";

declare module "h3" {
  interface H3EventContext {
    /** Merged route rules matched for the current request (set by `routeRules()`). */
    routeRules?: MatchedRouteRules;
  }
}

/**
 * Plug-and-play H3 middleware: matches route rules for each request, exposes the
 * merged rule map as `event.context.routeRules`, and runs matched rule
 * middleware (redirect, proxy, headers, basic auth, cache, …) before the route
 * handler.
 *
 * @example
 * ```ts
 * import { H3, serve } from "h3";
 * import { routeRules } from "h3-rules";
 *
 * const app = new H3();
 * app.use(
 *   routeRules({
 *     "/blog/**": { swr: 60 },
 *     "/old/**": { redirect: { to: "/new/**", status: 301 } },
 *     "/api/**": { cors: true },
 *   }),
 * );
 * ```
 */
export function routeRules(
  config: Record<string, RouteRuleConfig>,
  opts?: RouteRulesMatcherOptions,
): Middleware {
  const matcher = createRouteRulesMatcher(normalizeRouteRules(config), opts);
  return function routeRulesMiddleware(event, next) {
    const { routeRules, routeRuleMiddleware } = matcher(event.req.method, event.url.pathname);
    event.context.routeRules = routeRules;
    return routeRuleMiddleware.length > 0
      ? callMiddleware(event, routeRuleMiddleware, () => next())
      : next();
  };
}
