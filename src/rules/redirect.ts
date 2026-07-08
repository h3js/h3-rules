import { redirect as sendRedirect } from "h3";
import type { RedirectRuleOptions, RuleHandler } from "../types.ts";
import { resolveRuleTarget } from "./_utils.ts";

// Redirect route rule
export const redirect: RuleHandler<"redirect"> = (m) =>
  function redirectRouteRule(event) {
    const options = m.options as RedirectRuleOptions | undefined;
    const target = resolveRuleTarget(event, options);
    if (!target) {
      return;
    }
    return sendRedirect(target, options?.status);
  };
