import { compileRouterToString } from "rou3/compiler";
import { createRulesRouter } from "./match.ts";
import type { RouteRuleEntry } from "./merge.ts";
import type { PreMergedRouteRules } from "./internal/premerge.ts";
import type { RouteRules } from "./types.ts";

/**
 * Rule names with a runtime handler in `h3-rules`. Data-only / custom rules are
 * serialized without a `handler` reference. Keep in sync with `ruleHandlers`
 * (src/rules/index.ts).
 */
export const RUNTIME_RULE_NAMES: readonly string[] = Object.freeze([
  "headers",
  "redirect",
  "proxy",
  "cache",
  "basicAuth",
]);

export interface CompileRouteRulesOptions {
  /** Base URL prefix for all rule patterns (trailing slash trimmed). */
  baseURL?: string;
  /**
   * Module id the generated code imports rule handlers from. Must expose a
   * named export per runtime rule name (`h3-rules` exports the built-ins).
   * @default "h3-rules"
   */
  handlersImportId?: string;
  /**
   * Identifier prefix for imported handlers in generated code (handler `name`
   * binds as `<prefix>$<name>`).
   * @default "__ruleHandlers__"
   */
  handlersImportName?: string;
  /**
   * Rule names that reference a runtime handler (`<ns>.<name>`) in generated
   * code. Extend when registering custom handlers on the runtime side. Names
   * bind as JS identifiers in generated code, so they must be valid identifiers.
   * @default RUNTIME_RULE_NAMES
   */
  runtimeRules?: readonly string[];
  /**
   * Pre-merge each pattern's subsumption chain at compile time so per-request
   * resolution takes only the most specific matched layer instead of merging
   * all layers. Exact — but requires a **chain-clean** rule set: throws at
   * compile time if two patterns partially overlap or cannot be analyzed.
   */
  preMerge?: boolean;
}

/**
 * Compile a **normalized** rule set (see `normalizeRouteRules`) into the source
 * of a `findRouteRules(method, pathname)` function expression (rou3/compiler
 * `matchAll` output). Rule entries reference handler constructors as
 * `<handlersImportName>$<name>` local bindings — pair with
 * {@link compileHandlersImport} (which imports exactly those names), and wrap
 * with `createMatcherFromFind` at runtime:
 *
 * ```js
 * // generated module
 * import { headers as __ruleHandlers__$headers } from "h3-rules";
 * export const findRouteRules = <compileFindRouteRules(rules)>;
 * ```
 */
export function compileFindRouteRules(
  rules: Record<string, RouteRules>,
  opts: CompileRouteRulesOptions = {},
): string {
  // Build the exact same router as the runtime matcher (including method-scoped
  // precedence combination and optional chain pre-merge) so compiled and
  // runtime matchers behave identically. Handlers are attached in generated
  // code by name, not here.
  const router = createRulesRouter(rules, {}, opts.baseURL, opts.preMerge);
  const runtimeRules = opts.runtimeRules || RUNTIME_RULE_NAMES;
  const ns = opts.handlersImportName || "__ruleHandlers__";
  assertHandlerBinding(ns, "handlersImportName");
  return compileRouterToString(router, undefined, {
    matchAll: true,
    serialize: (data) =>
      Array.isArray(data)
        ? serializeRouteRuleEntries(data as RouteRuleEntry[], ns, runtimeRules)
        : serializePreMergedRouteRules(data as PreMergedRouteRules, ns, runtimeRules),
  });
}

/**
 * The runtime rule names a **normalized** rule set actually uses (sorted) — the
 * exact handlers {@link compileFindRouteRules} references and
 * {@link compileHandlersImport} imports. Internal helper of
 * {@link compileHandlersImport}; the selected names are observable through its
 * emitted import string.
 */
function usedRuleHandlerNames(
  rules: Record<string, RouteRules>,
  opts: CompileRouteRulesOptions = {},
): string[] {
  const runtimeRules = opts.runtimeRules || RUNTIME_RULE_NAMES;
  const used = new Set<string>();
  for (const key in rules) {
    for (const [name, options] of Object.entries(rules[key]!)) {
      // preMerge resolves `false` resets at compile time, so they never
      // reference a handler in the output; plain mode serializes them with one.
      if (
        options !== undefined &&
        (options !== false || !opts.preMerge) &&
        runtimeRules.includes(name)
      ) {
        used.add(name);
      }
    }
  }
  return [...used].sort();
}

/**
 * Import statement for the rule handlers used by compiled output: imports
 * **exactly** the handlers the rule set references (empty string if none), so
 * unused handlers — and their dependencies (e.g. ocache for `cache`) — stay
 * tree-shakeable. The handlers module (`handlersImportId`) must have a named
 * export per runtime rule name (`h3-rules` exports the built-ins; consumers
 * like Nitro point this at their own module to add/override handlers).
 */
export function compileHandlersImport(
  rules: Record<string, RouteRules>,
  opts: CompileRouteRulesOptions = {},
): string {
  const ns = opts.handlersImportName || "__ruleHandlers__";
  const id = opts.handlersImportId || "h3-rules";
  const names = usedRuleHandlerNames(rules, opts);
  if (names.length === 0) {
    return "";
  }
  assertHandlerBinding(ns, "handlersImportName");
  for (const name of names) {
    assertHandlerBinding(name, "runtime rule name");
  }
  return `import { ${names.map((name) => `${name} as ${ns}$${name}`).join(", ")} } from ${JSON.stringify(id)};`;
}

/**
 * Compile a normalized rule set into a complete ESM module exporting
 * `findRouteRules`.
 */
export function compileRouteRulesModule(
  rules: Record<string, RouteRules>,
  opts: CompileRouteRulesOptions = {},
): string {
  const handlersImport = compileHandlersImport(rules, opts);
  return `${handlersImport ? handlersImport + "\n" : ""}export const findRouteRules = ${compileFindRouteRules(rules, opts)};\n`;
}

// Serialize a pre-merged layer wrapper (preMerge mode).
function serializePreMergedRouteRules(
  data: PreMergedRouteRules,
  ns: string,
  runtimeRules: readonly string[],
): string {
  return `{route:${JSON.stringify(data.route)},rules:${serializeRouteRuleEntries(
    data.rules,
    ns,
    runtimeRules,
  )}}`;
}

// Serialize the rule entries registered for one pattern (one rou3 layer's
// `.data`) — equivalent to Nitro's `serializeRouteRule()`. Options must be
// JSON-serializable in compiled mode; anything JSON cannot round-trip throws
// (see `assertSerializableOptions`).
function serializeRouteRuleEntries(
  entries: (RouteRuleEntry & { paramRoutes?: string[] })[],
  ns: string,
  runtimeRules: readonly string[],
): string {
  return `[${entries
    .map((entry) => {
      if (runtimeRules.includes(entry.name)) {
        assertHandlerBinding(entry.name, "runtime rule name");
      }
      assertSerializableOptions(entry.options, entry, "options");
      return [
        `name:${JSON.stringify(entry.name)}`,
        `route:${JSON.stringify(entry.route)}`,
        entry.method && `method:${JSON.stringify(entry.method)}`,
        runtimeRules.includes(entry.name) && `handler:${ns}$${entry.name}`,
        `options:${JSON.stringify(entry.options)}`,
        entry.paramRoutes && `paramRoutes:${JSON.stringify(entry.paramRoutes)}`,
      ]
        .filter(Boolean)
        .join(",");
    })
    .map((fields) => `{${fields}}`)
    .join(",")}]`;
}

const JS_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

// Handler references bind as `<ns>$<name>` identifiers in generated code; a
// non-identifier would otherwise surface as a parse error in the consumer's
// generated module, far from the misconfiguration.
function assertHandlerBinding(name: string, what: string): void {
  if (!JS_IDENTIFIER_RE.test(name)) {
    throw new Error(
      `[h3-rules] compiler: ${what} \`${name}\` is not a valid JS identifier — it is used as a binding in generated code`,
    );
  }
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
