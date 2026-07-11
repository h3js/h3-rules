import { proxyRequest } from "h3";
import type { ProxyRuleOptions, RuleHandler } from "../types.ts";
import { resolveRuleTarget } from "./_utils.ts";

// Proxy route rule
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
