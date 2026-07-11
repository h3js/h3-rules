import type { RouterContext } from "rou3";
import { compileRouterToString } from "rou3/compiler";
import { createRulesRouter } from "../match.ts";
import type { RouteRuleEntry } from "../merge.ts";
import { normalizeRouteRules } from "../normalize.ts";
import type { PreMergedRouteRules } from "../internal/premerge.ts";
import type { RouteRuleConfig, RouteRules } from "../types.ts";
import {
  assertHandlerBinding,
  compileMatcherExport,
  serializePreMergedRouteRules,
  serializeRouteRuleEntries,
} from "./codegen.ts";
import {
  DEFAULT_HANDLERS_IMPORT_NAME,
  type CompileModuleOptions,
  type CompileRouteRulesOptions,
  type CompiledRouteRules,
} from "./options.ts";
import {
  isRuntimeRule,
  resolveRuntimeRule,
  resolveRuntimeRules,
  type RuntimeRuleImport,
} from "./runtime-rules.ts";

/**
 * Compile a rule set into a complete ESM module exporting `findRouteRules`
 * (and, with {@link CompileModuleOptions.matcher}, a ready-to-use matcher).
 * Input is normalized internally — pass authored config (shortcuts included)
 * or an already-normalized rule set. Returns a {@link CompiledRouteRules}:
 * `code` (or `String(…)`) is the whole module; `imports`/`body` are its two
 * halves for callers that compose the codegen into a larger module.
 */
export function compileRouteRules(
  config: Record<string, RouteRuleConfig>,
  opts: CompileModuleOptions = {},
): CompiledRouteRules {
  // Resolve input, preMerge, and the runtime-rule registry once; both emitters
  // read the same context, so handler imports structurally cannot desync from
  // the handler references in the generated `findRouteRules`, and a preMerge
  // fallback warns exactly once per call.
  const ctx = resolveCompileCtx(config, opts);
  const handlerImports = emitHandlersImport(ctx);
  // Optional matcher export: its infra import joins the handler imports (both
  // hoistable), its declaration follows `findRouteRules` in the body (it
  // references that local binding). `null` when no matcher is requested.
  const matcherExport = compileMatcherExport(opts.matcher);
  const imports = [handlerImports, matcherExport?.imports].filter(Boolean).join("\n");
  const find = `export const findRouteRules = ${emitFindRouteRules(ctx)};\n`;
  const body = matcherExport ? find + matcherExport.body : find;
  const code = `${imports ? imports + "\n" : ""}${body}`;
  return { imports, body, code, toString: () => code };
}

/**
 * Compile a rule set into the source of a `findRouteRules(method, pathname)`
 * function expression (rou3/compiler `matchAll` output). Input is normalized
 * internally, identically to {@link compileRouteRules} — pass authored config
 * directly. Rule entries reference handler constructors as
 * `<handlersImportName>$<name>` local bindings — pair with
 * {@link compileHandlersImport} (which imports exactly those names), and wrap
 * with `createMatcherFromFind` at runtime:
 *
 * ```js
 * // generated module
 * import { headers as __ruleHandlers__$headers } from "h3-rules";
 * export const findRouteRules = <compileFindRouteRules(config)>;
 * ```
 */
export function compileFindRouteRules(
  config: Record<string, RouteRuleConfig>,
  opts: CompileRouteRulesOptions = {},
): string {
  return emitFindRouteRules(resolveCompileCtx(config, opts));
}

/**
 * Import statement for the rule handlers used by compiled output: imports
 * **exactly** the handlers the rule set references (empty string if none), so
 * unused handlers — and their dependencies (e.g. ocache for `cache`) — stay
 * tree-shakeable. Each handler's source comes from its `runtimeRules` entry
 * (`h3-rules` for the built-ins via {@link DEFAULT_RUNTIME_RULES}, except
 * `cache` from `h3-rules/cache`; consumers like Nitro point individual rules
 * at their own module to add/override handlers), and each source's module must
 * have a named export per handler.
 * Input is normalized internally, identically to {@link compileFindRouteRules},
 * so the import reflects the handlers the normalized rules actually reference
 * (e.g. an `swr` shortcut counts as `cache`).
 */
export function compileHandlersImport(
  config: Record<string, RouteRuleConfig>,
  opts: CompileRouteRulesOptions = {},
): string {
  return emitHandlersImport(resolveCompileCtx(config, opts));
}

// ---- Internal ----

/**
 * Everything the fragment emitters need, resolved exactly once per public
 * entrypoint call: normalized rules, effective preMerge mode (post fail-safe
 * fallback — with the successfully pre-merged router kept for reuse), the
 * effective runtime-rule registry, and the validated handler-binding namespace.
 * Both emitters read this shared context, so generated handler references and
 * the handlers import can never disagree.
 */
interface CompileCtx {
  /** Normalized rule set (see the normalization note in {@link resolveCompileCtx}). */
  rules: Record<string, RouteRules>;
  /** Effective preMerge mode — `opts.preMerge` after the fail-safe fallback. */
  preMerge: boolean;
  /**
   * The pre-merged router built by the preMerge validity probe, kept so
   * {@link emitFindRouteRules} does not rebuild it (the pre-merge analysis is
   * the expensive part of router construction). Unset in plain mode.
   */
  router?: RouterContext<RouteRuleEntry[] | PreMergedRouteRules>;
  /** Caller's `runtimeRules` merged over {@link DEFAULT_RUNTIME_RULES}. */
  runtimeRules: Readonly<Record<string, RuntimeRuleImport>>;
  /** Validated handler-binding namespace (`<ns>$<name>` bindings). */
  ns: string;
  baseURL?: string;
}

/**
 * Resolve the shared compile context for one public entrypoint call.
 *
 * Input normalization: the compiler runs at build time, so unlike the runtime
 * matcher (which takes pre-normalized rules to keep normalization out of
 * runtime bundles) every public entrypoint normalizes its own input — raw
 * config would otherwise silently mis-compile (an unexpanded `swr` shortcut
 * compiles as a data-only rule with no cache handler import).
 * `normalizeRouteRules` is idempotent (a pinned contract — see
 * test/normalize.test.ts), so already-normalized input passes through
 * unchanged.
 *
 * preMerge resolution: pre-merge requires a chain-clean rule set; unlike the
 * runtime matcher (where a misconfigured `preMerge` is a startup error the
 * developer should see), the compiler treats pre-merge as an optional
 * throughput optimization and is **fail-safe**: if the pre-merge analysis
 * rejects the rule set (partial overlap, unanalyzable pattern), it warns once
 * and falls back to plain compilation so the build still produces a correct
 * (un-pre-merged) matcher. The probe *is* the pre-merged router build, so on
 * success the router is kept on the context instead of being rebuilt.
 */
function resolveCompileCtx(
  config: Record<string, RouteRuleConfig>,
  opts: CompileRouteRulesOptions,
): CompileCtx {
  // Normalization is idempotent including key order (pinned contracts — see
  // test/normalize.test.ts and the byte-equality compile test in
  // test/compiler.test.ts), so authored and pre-normalized input compile to
  // byte-identical output from a single pass.
  const rules = normalizeRouteRules(config);
  const ns = opts.handlersImportName || DEFAULT_HANDLERS_IMPORT_NAME;
  assertHandlerBinding(ns, "handlersImportName");
  const ctx: CompileCtx = {
    rules,
    preMerge: false,
    runtimeRules: resolveRuntimeRules(opts.runtimeRules),
    ns,
    baseURL: opts.baseURL,
  };
  if (opts.preMerge) {
    try {
      // Building the router runs the pre-merge analysis, which throws on a
      // non-chain-clean rule set (see preMergeRuleLayers).
      ctx.router = createRulesRouter(rules, {}, opts.baseURL, true);
      ctx.preMerge = true;
    } catch (error) {
      console.warn(
        `[h3-rules] compiler: preMerge could not be applied — falling back to plain compilation.\n  ${(error as Error).message}`,
      );
    }
  }
  return ctx;
}

/**
 * Emit the `findRouteRules` function-expression source for a resolved context.
 * Builds the exact same router as the runtime matcher (including method-scoped
 * precedence combination and optional chain pre-merge) so compiled and runtime
 * matchers behave identically — reusing the context's pre-merged router when
 * the preMerge probe succeeded. Handlers are attached in generated code by
 * name, not here.
 */
function emitFindRouteRules(ctx: CompileCtx): string {
  const router = ctx.router ?? createRulesRouter(ctx.rules, {}, ctx.baseURL, ctx.preMerge);
  return compileRouterToString(router, undefined, {
    matchAll: true,
    serialize: (data) =>
      Array.isArray(data)
        ? serializeRouteRuleEntries(data as RouteRuleEntry[], ctx.ns, ctx.runtimeRules)
        : serializePreMergedRouteRules(data as PreMergedRouteRules, ctx.ns, ctx.runtimeRules),
  });
}

/**
 * Emit the handlers import statement(s) for a resolved context: exactly the
 * handlers {@link emitFindRouteRules} references for the same context (empty
 * string if none).
 */
function emitHandlersImport(ctx: CompileCtx): string {
  const names = usedRuleHandlerNames(ctx);
  if (names.length === 0) {
    return "";
  }
  // Group each used handler's `<export> as <ns>$<name>` specifier under its
  // source module — a rule can override where its handler comes from, so one
  // import statement per distinct source. `names` is sorted, so the specifiers
  // land in binding order within each group; sources are sorted below for a
  // deterministic statement order.
  const bySource = new Map<string, string[]>();
  for (const name of names) {
    assertHandlerBinding(name, "runtime rule name");
    const { source, export: exportName } = resolveRuntimeRule(name, ctx.runtimeRules);
    assertHandlerBinding(exportName, "runtime rule export");
    let specs = bySource.get(source);
    if (!specs) {
      bySource.set(source, (specs = []));
    }
    specs.push(`${exportName} as ${ctx.ns}$${name}`);
  }
  return [...bySource.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([source, specs]) => `import { ${specs.join(", ")} } from ${JSON.stringify(source)};`)
    .join("\n");
}

/**
 * The runtime rule names a resolved context actually uses (sorted) — the exact
 * handlers {@link emitFindRouteRules} references and {@link emitHandlersImport}
 * imports.
 */
function usedRuleHandlerNames(ctx: CompileCtx): string[] {
  const used = new Set<string>();
  for (const key in ctx.rules) {
    for (const [name, options] of Object.entries(ctx.rules[key]!)) {
      // preMerge resolves `false` resets at compile time, so they never
      // reference a handler in the output; plain mode serializes them with one.
      // `ctx.preMerge` is the *effective* mode (post-fallback), so a fallen-back
      // compile imports the handlers plain mode references.
      if (
        options !== undefined &&
        (options !== false || !ctx.preMerge) &&
        isRuntimeRule(name, ctx.runtimeRules)
      ) {
        used.add(name);
      }
    }
  }
  return [...used].sort();
}
