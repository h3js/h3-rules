import { compareRoutes } from "rou3";
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
  overridePredicate: string,
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
  // Pass the baked override predicate as the 2nd argument so the ready-to-use
  // compiled matcher applies the same specificity guard as the runtime
  // `createRouteRulesMatcher` — a broader canonical/merged pattern can never
  // downgrade a narrower rule the served path resolved (see
  // {@link compileOverridePredicate}).
  let expr = `createMatcherFromFind(findRouteRules, ${overridePredicate})`;
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
 * Emit the source of the dual-path override predicate the compiled `matcher`
 * export passes to `createMatcherFromFind` — the compiled counterpart of the
 * runtime `canOverrideRoute` guard. It answers, for two matched pattern strings,
 * whether the incoming (canonical / slash-merged) reading may override an
 * already-resolved rule of the same name: only when its pattern is equal to, or
 * strictly more specific than, the current one — so a broader canonical pattern
 * can never downgrade a narrower rule the served path resolved.
 *
 * The rou3 containment relation is baked into a static table **at build time**
 * (`compareRoutes` runs here, never in the emitted output), so the compiled
 * matcher keeps rou3 out of the runtime bundle. `routes` is the set of registered
 * pattern strings — the only values that can reach the predicate as a matched
 * entry's `route`. Sorted for deterministic (byte-stable) output.
 */
export function compileOverridePredicate(routes: string[]): string {
  // Ordered pairs `current → [incoming, …]` where `incoming` may override
  // `current`: `compareRoutes(current, incoming)` is `"superset"` (current
  // broader) or `"equal"`. Identical routes are handled by the emitted `a === b`
  // fast path; every other relation (`subset`/`disjoint`/`partial`) is absent
  // from the table, so the predicate fails closed and keeps the served rule.
  const sorted = [...routes].sort();
  const allowed = new Map<string, string[]>();
  for (const current of sorted) {
    for (const incoming of sorted) {
      if (current === incoming) {
        continue;
      }
      const rel = compareRoutes(current, incoming);
      if (rel === "superset" || rel === "equal") {
        let list = allowed.get(current);
        if (!list) {
          allowed.set(current, (list = []));
        }
        list.push(incoming);
      }
    }
  }
  // No overlapping registered patterns: only an identical route may override
  // (exactly the runtime guard's behavior), so a bare identity check suffices.
  if (allowed.size === 0) {
    return "(a, b) => a === b";
  }
  const entries = [...allowed]
    .map(([current, list]) => `[${JSON.stringify(current)}, new Set(${JSON.stringify(list)})]`)
    .join(", ");
  return `/* @__PURE__ */ (() => { const t = new Map([${entries}]); return (a, b) => a === b || (t.get(a)?.has(b) ?? false); })()`;
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
      // `JSON.stringify` emits an own enumerable `__proto__` as a `"__proto__"`
      // member, but the compiler embeds that JSON as a JS **object literal**, where
      // a `"__proto__"` key is the prototype-setter production (ECMA-262
      // `__proto__` PropertyDefinition) — not a data property. So the compiled
      // object would silently drop the key and adopt a new prototype, diverging
      // from the runtime matcher (which carries it as data). This is the one place
      // JSON and JS-literal semantics disagree; refuse it rather than diverge.
      if (key === "__proto__") {
        throw new Error(
          `[h3-rules] compiler: \`${entry.name}\` rule for \`${entry.route}\` has a \`__proto__\` key at \`${path}\` — it cannot be embedded as a JS object literal without changing the object's prototype (its JSON.stringify output would diverge from the runtime matcher); rename or remove it`,
        );
      }
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
