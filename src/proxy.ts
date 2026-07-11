// `h3-rules/proxy` — the `proxy` rule handler. Like `h3-rules/cache`, this is an
// **opt-in** subpath: it is the only h3-rules module that imports h3's
// `proxyRequest` (the request-forwarding machinery), so rule sets that don't
// proxy never pull it into their bundle. Rule sets using `proxy` register this
// handler explicitly (`handlers: { proxy }`); the core registry ships none, and
// `createRouteRulesMatcher` throws when a `proxy` rule is used without one.

import { proxyRequest } from "h3";
import type { ProxyRuleOptions, RuleHandler } from "./types.ts";
import { resolveRuleTarget } from "./rules/_utils.ts";

/**
 * Proxy rule handler: forwards the request to the rule's `to` target. For `/**`
 * wildcard targets the raw `event.url.pathname` is forwarded (encoded
 * separators stay opaque) after the shared scope check — see
 * {@link resolveRuleTarget}. Registered per matcher (`handlers: { proxy }`); no
 * shared instance is needed since the handler holds no state.
 */
export const proxy: RuleHandler<"proxy"> = {
  handler: (m) =>
    function proxyRouteRule(event) {
      const options = m.options as ProxyRuleOptions | undefined;
      const target = resolveRuleTarget(event, options);
      if (!target) {
        return;
      }
      return proxyRequest(event, target, { ...options });
    },
};
