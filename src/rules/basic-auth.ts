import { requireBasicAuth } from "h3";
import type { BasicAuthOptions } from "h3";
import type { RuleHandler } from "../types.ts";

// basicAuth route rule
// Must run before `redirect`/`proxy`/`cache` (order: -1) so unauthorized
// requests are neither redirected nor proxied.
export const basicAuth: RuleHandler<"basicAuth"> = /* @__PURE__ */ Object.assign(
  ((m) =>
    async function authRouteRule(event, next) {
      if (!m.options) {
        return;
      }
      await requireBasicAuth(event, m.options as BasicAuthOptions);
      return next();
    }) satisfies RuleHandler<"basicAuth">,
  { order: -1 },
);
