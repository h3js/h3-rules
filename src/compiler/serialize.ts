import type { RouteRuleEntry } from "../merge.ts";
import type { PreMergedRouteRules } from "../internal/premerge.ts";
import { assertHandlerBinding } from "./binding.ts";
import { isRuntimeRule, type RuntimeRuleImport } from "./runtime-rules.ts";

/** Serialize a pre-merged layer wrapper (preMerge mode). */
export function serializePreMergedRouteRules(
  data: PreMergedRouteRules,
  ns: string,
  runtimeRules: Record<string, RuntimeRuleImport>,
): string {
  return `{route:${JSON.stringify(data.route)},rules:${serializeRouteRuleEntries(
    data.rules,
    ns,
    runtimeRules,
  )}}`;
}

/**
 * Serialize the rule entries registered for one pattern (one rou3 layer's
 * `.data`) — equivalent to Nitro's `serializeRouteRule()`. Options must be
 * JSON-serializable in compiled mode; anything JSON cannot round-trip throws
 * (see `assertSerializableOptions`).
 */
export function serializeRouteRuleEntries(
  entries: (RouteRuleEntry & { paramRoutes?: string[] })[],
  ns: string,
  runtimeRules: Record<string, RuntimeRuleImport>,
): string {
  return `[${entries
    .map((entry) => {
      const runtime = isRuntimeRule(entry.name, runtimeRules);
      if (runtime) {
        assertHandlerBinding(entry.name, "runtime rule name");
      }
      assertSerializableOptions(entry.options, entry, "options");
      return [
        `name:${JSON.stringify(entry.name)}`,
        `route:${JSON.stringify(entry.route)}`,
        entry.method && `method:${JSON.stringify(entry.method)}`,
        runtime && `handler:${ns}$${entry.name}`,
        `options:${JSON.stringify(entry.options)}`,
        entry.paramRoutes && `paramRoutes:${JSON.stringify(entry.paramRoutes)}`,
      ]
        .filter(Boolean)
        .join(",");
    })
    .map((fields) => `{${fields}}`)
    .join(",")}]`;
}

// `JSON.stringify` silently drops functions and nested `undefined` and mangles
// class instances (`Date` → string, `RegExp` → `{}`), which would make the
// compiled matcher diverge from the runtime matcher with no error. Reject
// anything JSON cannot round-trip at compile time instead.
function assertSerializableOptions(value: unknown, entry: RouteRuleEntry, path: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      assertSerializableOptions(item, entry, `${path}[${i}]`);
    }
    return;
  }
  const proto = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (proto === Object.prototype || proto === null) {
    for (const [key, item] of Object.entries(value as object)) {
      assertSerializableOptions(item, entry, `${path}.${key}`);
    }
    return;
  }
  const kind =
    typeof value === "object" ? (value as object).constructor?.name || "object" : typeof value;
  throw new Error(
    `[h3-rules] compiler: \`${entry.name}\` rule for \`${entry.route}\` has a non-JSON-serializable value at \`${path}\` (${kind}) — compiled rule options must survive a JSON round-trip`,
  );
}
