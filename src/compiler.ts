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

/**
 * Where a runtime rule's handler is imported from in generated code: either a
 * bare module id or `{ source, export }`. With the bare-string form the
 * `source` module **must have a named export whose identifier equals the rule
 * key** (`cache: "#nitro/cache"` ⇒ `import { cache } from "#nitro/cache"`); use
 * the object form's `export` when the export is named something else. The
 * `source` is always explicit — there is no ambient default module.
 *
 * ```ts
 * // merged over the built-in preset — only list additions/overrides:
 * runtimeRules: {
 *   cache: "#nitro/cache",                                 // module exports `cache`
 *   isr: { source: "#nitro/rules", export: "handleISR" },  // export named differently
 * }
 * ```
 */
export type RuntimeRuleImport = string | RuntimeRuleImportSpec;

export interface RuntimeRuleImportSpec {
  /** Module the handler is imported from. */
  source: string;
  /**
   * Named export of the handler within `source`. Must be a valid JS identifier
   * (it becomes an import binding in generated code). Omit it only when the
   * export is named exactly as the rule key — the default is the rule key
   * itself, so `source` must then export a member under that name.
   * @default the rule key
   */
  export?: string;
}

/**
 * Default `runtimeRules` preset: every built-in rule handler imported from
 * `h3-rules` under its own name. A caller's `runtimeRules` is merged **over**
 * this (see {@link resolveRuntimeRules}), so consumers only list additions and
 * overrides — they never need to re-declare the built-ins.
 */
export const DEFAULT_RUNTIME_RULES: Readonly<Record<string, RuntimeRuleImport>> = Object.freeze(
  Object.fromEntries(RUNTIME_RULE_NAMES.map((name) => [name, "h3-rules"])),
);

/**
 * The effective runtime-rule set: the caller's `runtimeRules` merged over
 * {@link DEFAULT_RUNTIME_RULES}, so the built-ins stay registered unless the
 * caller overrides a specific one. (Returns the frozen preset directly when the
 * caller passes nothing, avoiding a per-call allocation.)
 */
function resolveRuntimeRules(
  opts: CompileRouteRulesOptions,
): Readonly<Record<string, RuntimeRuleImport>> {
  return opts.runtimeRules
    ? { ...DEFAULT_RUNTIME_RULES, ...opts.runtimeRules }
    : DEFAULT_RUNTIME_RULES;
}

/** Whether `name` is registered as a runtime rule (own key of the `runtimeRules` record). */
function isRuntimeRule(name: string, runtimeRules: Record<string, RuntimeRuleImport>): boolean {
  return Object.hasOwn(runtimeRules, name);
}

/**
 * Resolve a runtime rule's `{ source, export }` for its `<ns>$<name>` binding —
 * a bare-string entry is the source (export defaults to the rule name), an
 * object entry may also override the export. Caller must have checked
 * {@link isRuntimeRule} first.
 */
function resolveRuntimeRule(
  name: string,
  runtimeRules: Record<string, RuntimeRuleImport>,
): { source: string; export: string } {
  const entry = runtimeRules[name]!;
  return typeof entry === "string"
    ? { source: entry, export: name }
    : { source: entry.source, export: entry.export ?? name };
}

export interface CompileRouteRulesOptions {
  /** Base URL prefix for all rule patterns (trailing slash trimmed). */
  baseURL?: string;
  /**
   * Identifier prefix for imported handlers in generated code (handler `name`
   * binds as `<prefix>$<name>`).
   * @default "__ruleHandlers__"
   */
  handlersImportName?: string;
  /**
   * Runtime rules that reference a handler (bound `<ns>$<name>`) in generated
   * code, keyed by rule name. Each value is a {@link RuntimeRuleImport} — a
   * module id, or `{ source, export }`. Merged **over**
   * {@link DEFAULT_RUNTIME_RULES}, so you only list custom handlers and
   * built-in source overrides; the built-ins stay registered otherwise. Keys
   * bind as JS identifiers in generated code, so they must be valid identifiers.
   * @default DEFAULT_RUNTIME_RULES
   */
  runtimeRules?: Record<string, RuntimeRuleImport>;
  /**
   * Pre-merge each pattern's subsumption chain at compile time so per-request
   * resolution takes only the most specific matched layer instead of merging
   * all layers. Exact — but requires a **chain-clean** rule set. Pre-merge is a
   * throughput optimization, not a correctness requirement, so — unlike the
   * runtime matcher, which throws — the compiler is **fail-safe**: if the rule
   * set is not chain-clean (two patterns partially overlap or cannot be
   * analyzed), it emits a `console.warn` and falls back to plain compilation
   * instead of failing the build.
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
  // code by name, not here. preMerge is resolved fail-safe: a rule set that is
  // not chain-clean falls back to plain compilation (see the option docs) —
  // resolved identically in compileHandlersImport so imports and references
  // stay in sync.
  const router = createRulesRouter(rules, {}, opts.baseURL, resolveEffectivePreMerge(rules, opts));
  const runtimeRules = resolveRuntimeRules(opts);
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
  preMerge = false,
): string[] {
  const runtimeRules = resolveRuntimeRules(opts);
  const used = new Set<string>();
  for (const key in rules) {
    for (const [name, options] of Object.entries(rules[key]!)) {
      // preMerge resolves `false` resets at compile time, so they never
      // reference a handler in the output; plain mode serializes them with one.
      // `preMerge` is the *effective* mode (post-fallback), not `opts.preMerge`,
      // so a fallen-back compile imports the handlers plain mode references.
      if (
        options !== undefined &&
        (options !== false || !preMerge) &&
        isRuntimeRule(name, runtimeRules)
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
 * tree-shakeable. Each handler's source comes from its `runtimeRules` entry
 * (`h3-rules` for the built-ins via {@link DEFAULT_RUNTIME_RULES}; consumers
 * like Nitro point individual rules at their own module to add/override
 * handlers), and each source's module must have a named export per handler.
 */
export function compileHandlersImport(
  rules: Record<string, RouteRules>,
  opts: CompileRouteRulesOptions = {},
): string {
  const ns = opts.handlersImportName || "__ruleHandlers__";
  const runtimeRules = resolveRuntimeRules(opts);
  // Resolve preMerge the same way compileFindRouteRules does so a fallen-back
  // compile imports exactly the handlers its generated code references.
  const names = usedRuleHandlerNames(rules, opts, resolveEffectivePreMerge(rules, opts));
  if (names.length === 0) {
    return "";
  }
  assertHandlerBinding(ns, "handlersImportName");
  // Group each used handler's `<export> as <ns>$<name>` specifier under its
  // source module — a rule can override where its handler comes from, so one
  // import statement per distinct source. `names` is sorted, so the specifiers
  // land in binding order within each group; sources are sorted below for a
  // deterministic statement order.
  const bySource = new Map<string, string[]>();
  for (const name of names) {
    assertHandlerBinding(name, "runtime rule name");
    const { source, export: exportName } = resolveRuntimeRule(name, runtimeRules);
    assertHandlerBinding(exportName, "runtime rule export");
    let specs = bySource.get(source);
    if (!specs) {
      bySource.set(source, (specs = []));
    }
    specs.push(`${exportName} as ${ns}$${name}`);
  }
  return [...bySource.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([source, specs]) => `import { ${specs.join(", ")} } from ${JSON.stringify(source)};`)
    .join("\n");
}

/**
 * Compile a normalized rule set into a complete ESM module exporting
 * `findRouteRules`.
 */
export function compileRouteRulesModule(
  rules: Record<string, RouteRules>,
  opts: CompileRouteRulesOptions = {},
): string {
  // Resolve preMerge once up front (warning on fallback here) and hand the
  // sub-calls the already-resolved mode, so a non-chain-clean rule set warns a
  // single time rather than once per sub-call.
  const resolved: CompileRouteRulesOptions = {
    ...opts,
    preMerge: resolveEffectivePreMerge(rules, opts),
  };
  const handlersImport = compileHandlersImport(rules, resolved);
  return `${handlersImport ? handlersImport + "\n" : ""}export const findRouteRules = ${compileFindRouteRules(rules, resolved)};\n`;
}

/**
 * Resolve the effective `preMerge` for compilation. Pre-merge requires a
 * chain-clean rule set; unlike the runtime matcher (where a misconfigured
 * `preMerge` is a startup error the developer should see), the compiler treats
 * pre-merge as an optional throughput optimization and is **fail-safe**: if the
 * pre-merge analysis rejects the rule set (partial overlap, unanalyzable
 * pattern), it warns and reports plain mode so the build still produces a
 * correct (un-pre-merged) matcher. Resolved identically wherever the compiler
 * branches on preMerge so generated code, handler imports, and used-handler
 * names stay consistent.
 */
function resolveEffectivePreMerge(
  rules: Record<string, RouteRules>,
  opts: CompileRouteRulesOptions,
): boolean {
  if (!opts.preMerge) {
    return false;
  }
  try {
    // Building the router runs the pre-merge analysis, which throws on a
    // non-chain-clean rule set (see preMergeRuleLayers). The router itself is
    // rebuilt by the caller; this is only a validity probe.
    createRulesRouter(rules, {}, opts.baseURL, true);
    return true;
  } catch (error) {
    console.warn(
      `[h3-rules] compiler: preMerge could not be applied — falling back to plain compilation.\n  ${(error as Error).message}`,
    );
    return false;
  }
}

// Serialize a pre-merged layer wrapper (preMerge mode).
function serializePreMergedRouteRules(
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

// Serialize the rule entries registered for one pattern (one rou3 layer's
// `.data`) — equivalent to Nitro's `serializeRouteRule()`. Options must be
// JSON-serializable in compiled mode; anything JSON cannot round-trip throws
// (see `assertSerializableOptions`).
function serializeRouteRuleEntries(
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
