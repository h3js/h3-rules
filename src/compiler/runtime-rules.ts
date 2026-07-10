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
