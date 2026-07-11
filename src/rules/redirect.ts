import { redirect as sendRedirect } from "h3";
import type { RedirectRuleOptions, RuleHandler } from "../types.ts";
import { prepareRuleTarget } from "./_utils.ts";

// Redirect route rule
export const redirect: RuleHandler<"redirect"> = {
  handler: (m) => {
    const options = m.options as RedirectRuleOptions | undefined;
    // Static `to`-derived work happens once per handler; the resolver only
    // performs the request-dependent parts (scope checks, query forwarding).
    const resolveTarget = prepareRuleTarget(options);
    if (!resolveTarget) {
      return function redirectRouteRule() {};
    }
    return function redirectRouteRule(event) {
      return sendRedirect(resolveTarget(event), options?.status);
    };
  },
};
