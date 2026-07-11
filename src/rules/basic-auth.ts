import { requireBasicAuth } from "h3";
import type { BasicAuthOptions } from "h3";
import type { RuleHandler } from "../types.ts";

// basicAuth route rule
// Runs first (order: -2, outer to `headers` at -1 and everything else at 0) so
// unauthorized requests are neither redirected/proxied/cached nor carry
// `headers` — on auth failure it throws before any inner rule runs.
export const basicAuth: RuleHandler<"basicAuth"> = {
  order: -2,
  handler: (m) =>
    async function authRouteRule(event, next) {
      if (!m.options) {
        return;
      }
      await requireBasicAuth(event, m.options as BasicAuthOptions);
      return next();
    },
};
