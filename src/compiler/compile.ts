import { compileRouterToString } from "rou3/compiler";
import { createRulesRouter } from "../match.ts";
import type { RouteRuleEntry } from "../merge.ts";
import type { PreMergedRouteRules } from "../internal/premerge.ts";
import type { RouteRules } from "../types.ts";
import { assertHandlerBinding } from "./binding.ts";
import { compileMatcherExport } from "./matcher-export.ts";
import {
  DEFAULT_HANDLERS_IMPORT_NAME,
  normalizeInput,
  type CompileModuleOptions,
  type CompileRouteRulesOptions,
  type CompiledRouteRules,
  type RouteRulesInput,
} from "./options.ts";
import { resolveEffectivePreMerge } from "./pre-merge.ts";
import { isRuntimeRule, resolveRuntimeRule, resolveRuntimeRules } from "./runtime-rules.ts";
import { serializePreMergedRouteRules, serializeRouteRuleEntries } from "./serialize.ts";

/**
 * Compile a rule set into the source of a `findRouteRules(method, pathname)`
 * function expression (rou3/compiler `matchAll` output). Input is normalized
 * internally (see {@link RouteRulesInput}) — pass authored config directly.
 * Rule entries reference handler constructors as `<handlersImportName>$<name>`
 * local bindings — pair with {@link compileHandlersImport} (which imports
 * exactly those names), and wrap with `createMatcherFromFind` at runtime:
 *
 * ```js
 * // generated module
 * import { headers as __ruleHandlers__$headers } from "h3-rules";
 * export const findRouteRules = <compileFindRouteRules(config)>;
 * ```
 */
export function compileFindRouteRules(
  config: RouteRulesInput,
  opts: CompileRouteRulesOptions = {},
): string {
  const rules = normalizeInput(config);
  // Build the exact same router as the runtime matcher (including method-scoped
  // precedence combination and optional chain pre-merge) so compiled and
  // runtime matchers behave identically. Handlers are attached in generated
  // code by name, not here. preMerge is resolved fail-safe: a rule set that is
  // not chain-clean falls back to plain compilation (see the option docs) —
  // resolved identically in compileHandlersImport so imports and references
  // stay in sync.
  const router = createRulesRouter(rules, {}, opts.baseURL, resolveEffectivePreMerge(rules, opts));
  const runtimeRules = resolveRuntimeRules(opts.runtimeRules);
  const ns = opts.handlersImportName || DEFAULT_HANDLERS_IMPORT_NAME;
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
 * {@link compileHandlersImport} imports.
 */
function usedRuleHandlerNames(
  rules: Record<string, RouteRules>,
  opts: CompileRouteRulesOptions = {},
  preMerge = false,
): string[] {
  const runtimeRules = resolveRuntimeRules(opts.runtimeRules);
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
 * Input is normalized internally (see {@link RouteRulesInput}), identically to
 * {@link compileFindRouteRules}, so the import reflects the handlers the
 * normalized rules actually reference (e.g. an `swr` shortcut counts as
 * `cache`).
 */
export function compileHandlersImport(
  config: RouteRulesInput,
  opts: CompileRouteRulesOptions = {},
): string {
  const rules = normalizeInput(config);
  const ns = opts.handlersImportName || DEFAULT_HANDLERS_IMPORT_NAME;
  const runtimeRules = resolveRuntimeRules(opts.runtimeRules);
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
 * Compile a rule set into a complete ESM module exporting `findRouteRules`
 * (and, with {@link CompileModuleOptions.matcher}, a ready-to-use matcher).
 * Input is normalized internally (see {@link RouteRulesInput}) — pass authored
 * config directly. Returns a {@link CompiledRouteRules}: `code` (or `String(…)`)
 * is the whole module; `imports`/`body` are its two halves for callers that
 * compose the codegen into a larger module.
 */
export function compileRouteRules(
  config: RouteRulesInput,
  opts: CompileModuleOptions = {},
): CompiledRouteRules {
  // Normalize once up front; the sub-calls re-normalize the already-normalized
  // set, which is an idempotent no-op.
  const rules = normalizeInput(config);
  // Resolve preMerge once up front (warning on fallback here) and hand the
  // sub-calls the already-resolved mode, so a non-chain-clean rule set warns a
  // single time rather than once per sub-call.
  const resolved: CompileModuleOptions = {
    ...opts,
    preMerge: resolveEffectivePreMerge(rules, opts),
  };
  const handlerImports = compileHandlersImport(rules, resolved);
  // Optional matcher export: its infra import joins the handler imports (both
  // hoistable), its declaration follows `findRouteRules` in the body (it
  // references that local binding). `null` when no matcher is requested.
  const matcherExport = compileMatcherExport(opts.matcher);
  const imports = [handlerImports, matcherExport?.imports].filter(Boolean).join("\n");
  const find = `export const findRouteRules = ${compileFindRouteRules(rules, resolved)};\n`;
  const body = matcherExport ? find + matcherExport.body : find;
  const code = `${imports ? imports + "\n" : ""}${body}`;
  return { imports, body, code, toString: () => code };
}
