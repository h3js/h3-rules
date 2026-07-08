import type { RuleHandler } from "../types.ts";

// Headers route rule
export const headers: RuleHandler<"headers"> = (m) =>
  function headersRouteRule(event) {
    for (const [key, value] of Object.entries(m.options || {})) {
      event.res.headers.set(key, value);
    }
  };
