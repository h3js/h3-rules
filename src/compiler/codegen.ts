import type { RouteRuleEntry } from "../merge.ts";
import type { PreMergedRouteRules } from "../internal/premerge.ts";
import type { MatcherExport } from "./options.ts";
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

/** Default export name for the optional matcher export (`matcher: true`). */
const DEFAULT_MATCHER_EXPORT_NAME = "matcher";

/**
 * Resolve the `matcher` option into the infra import + export-declaration source
 * for the ready-to-use matcher export, or `null` when none is requested.
 * `createMatcherFromFind` (and `memoizeRouteRulesMatcher`, only when memoizing)
 * are imported from `h3-rules`; the export wraps the `findRouteRules` binding the
 * surrounding module declares.
 */
export function compileMatcherExport(
  matcher: MatcherExport | undefined,
): { imports: string; body: string } | null {
  if (!matcher) {
    return null;
  }
  const spec = typeof matcher === "string" ? { name: matcher } : matcher === true ? {} : matcher;
  const name = spec.name || DEFAULT_MATCHER_EXPORT_NAME;
  // The export binds as a top-level identifier in generated code — reject a
  // non-identifier here rather than as a parse error in the consumer's module.
  assertHandlerBinding(name, "matcher export name");
  const { memoize } = spec;
  let expr = "createMatcherFromFind(findRouteRules)";
  if (memoize) {
    // A `{ max }` cap serializes as a second argument; bare `true`/`{}` uses the
    // default cap (no argument), matching memoizeRouteRulesMatcher's default.
    const max = memoize === true ? undefined : memoize.max;
    expr =
      max === undefined
        ? `memoizeRouteRulesMatcher(${expr})`
        : `memoizeRouteRulesMatcher(${expr}, { max: ${JSON.stringify(max)} })`;
  }
  return {
    imports: `import { createMatcherFromFind${
      memoize ? ", memoizeRouteRulesMatcher" : ""
    } } from "h3-rules";`,
    body: `export const ${name} = ${expr};\n`,
  };
}

/**
 * Handler references bind as `<ns>$<name>` identifiers in generated code; a
 * non-identifier would otherwise surface as a parse error in the consumer's
 * generated module, far from the misconfiguration. Used to validate every
 * binding name the compiler emits (`runtimeRules` keys, per-rule `export`
 * names, `handlersImportName`, and the matcher export name).
 */
export function assertHandlerBinding(name: string, what: string): void {
  if (!JS_IDENTIFIER_RE.test(name)) {
    throw new Error(
      `[h3-rules] compiler: ${what} \`${name}\` is not a valid JS identifier — it is used as a binding in generated code`,
    );
  }
}

// ---- Internal ----

const JS_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

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
