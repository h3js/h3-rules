/**
 * Default `runtimeRules` preset: every built-in rule handler imported from
 * `h3-rules` under its own name — except the opt-in subpath handlers `cache`
 * (`h3-rules/cache`) and `proxy` (`h3-rules/proxy`), so their dependencies
 * (ocache, h3's `proxyRequest`) only enter a compiled bundle when the rule is
 * used. A caller's `runtimeRules` is merged **over** this (see
 * {@link resolveRuntimeRules}), so consumers only list additions and overrides —
 * they never need to re-declare the built-ins. Keep the key set in sync with
 * `ruleHandlers` (src/rules/index.ts) plus the two subpath handlers.
 */
export const DEFAULT_RUNTIME_RULES: Readonly<Record<string, RuntimeRuleImport>> = Object.freeze({
  headers: "h3-rules",
  redirect: "h3-rules",
  proxy: "h3-rules/proxy",
  cache: "h3-rules/cache",
  basicAuth: "h3-rules",
  cors: "h3-rules",
});

/**
 * Rule names with a built-in runtime handler (the {@link DEFAULT_RUNTIME_RULES}
 * key set). Data-only / custom rules are serialized without a `handler`
 * reference.
 */
export const RUNTIME_RULE_NAMES: readonly string[] = Object.freeze(
  Object.keys(DEFAULT_RUNTIME_RULES),
);

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
 * The effective runtime-rule set: the caller's `runtimeRules` merged over
 * {@link DEFAULT_RUNTIME_RULES}, so the built-ins stay registered unless the
 * caller overrides a specific one. (Returns the frozen preset directly when the
 * caller passes nothing, avoiding a per-call allocation.)
 */
export function resolveRuntimeRules(
  runtimeRules: Record<string, RuntimeRuleImport> | undefined,
): Readonly<Record<string, RuntimeRuleImport>> {
  return runtimeRules ? { ...DEFAULT_RUNTIME_RULES, ...runtimeRules } : DEFAULT_RUNTIME_RULES;
}

/** Whether `name` is registered as a runtime rule (own key of the `runtimeRules` record). */
export function isRuntimeRule(
  name: string,
  runtimeRules: Record<string, RuntimeRuleImport>,
): boolean {
  return Object.hasOwn(runtimeRules, name);
}

/**
 * Resolve a runtime rule's `{ source, export }` for its `<ns>$<name>` binding —
 * a bare-string entry is the source (export defaults to the rule name), an
 * object entry may also override the export. Caller must have checked
 * {@link isRuntimeRule} first.
 */
export function resolveRuntimeRule(
  name: string,
  runtimeRules: Record<string, RuntimeRuleImport>,
): { source: string; export: string } {
  const entry = runtimeRules[name]!;
  return typeof entry === "string"
    ? { source: entry, export: name }
    : { source: entry.source, export: entry.export ?? name };
}
