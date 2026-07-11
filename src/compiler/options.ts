import type { MatcherMemoizeOptions } from "../match.ts";
import { normalizeRouteRules } from "../normalize.ts";
import type { RouteRuleConfig, RouteRules } from "../types.ts";
import type { RuntimeRuleImport } from "./runtime-rules.ts";

/** Default identifier prefix for imported handlers (`<prefix>$<name>` bindings). */
export const DEFAULT_HANDLERS_IMPORT_NAME = "__ruleHandlers__";

/**
 * Rule-set input accepted by the compiler entrypoints: authored config
 * ({@link RouteRuleConfig} values — shortcuts and string forms included) or an
 * already-normalized rule set ({@link RouteRules} values, e.g. from a consumer
 * that normalizes for its own purposes).
 */
export type RouteRulesInput = Record<string, RouteRuleConfig | RouteRules>;

// The compiler runs at build time, so unlike the runtime matcher (which takes
// pre-normalized rules to keep normalization out of runtime bundles) every
// public entrypoint normalizes its own input — raw config would otherwise
// silently mis-compile (an unexpanded `swr` shortcut compiles as a data-only
// rule with no cache handler import). `normalizeRouteRules` is idempotent (a
// pinned contract — see test/normalize.test.ts), so already-normalized input
// passes through unchanged.
export function normalizeInput(config: RouteRulesInput): Record<string, RouteRules> {
  return normalizeRouteRules(config as Record<string, RouteRuleConfig>);
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
 * Controls the optional ready-to-use matcher export {@link compileRouteRules}
 * appends alongside `findRouteRules`. `false`/omitted emits no matcher (the
 * default — take `findRouteRules` and wrap it yourself). Otherwise the module
 * also exports a matcher wrapping the compiled `findRouteRules`:
 *
 * - `true` — `export const matcher = createMatcherFromFind(findRouteRules)`.
 * - a string — same, but named after the string (e.g. `"routeRulesMatcher"`).
 * - `{ name?, memoize? }` — rename the export and/or bake in memoization
 *   (`memoizeRouteRulesMatcher(createMatcherFromFind(findRouteRules))`; pass
 *   `memoize: { max }` to tune the cap). `memoizeRouteRulesMatcher` is imported
 *   **only** when `memoize` is set, so an un-memoized matcher export still
 *   tree-shakes it away.
 *
 * `createMatcherFromFind` (and, with `memoize`, `memoizeRouteRulesMatcher`) is
 * imported from `h3-rules` and counts toward {@link CompiledRouteRules.imports}.
 */
export type MatcherExport =
  | boolean
  | string
  | { name?: string; memoize?: boolean | MatcherMemoizeOptions };

/**
 * {@link compileRouteRules} options — {@link CompileRouteRulesOptions} plus the
 * whole-module-only `matcher` knob. The lower-level `compileFindRouteRules` /
 * `compileHandlersImport` entrypoints emit only their one fragment, so they take
 * the base options; `matcher` is meaningful only when assembling the full module.
 */
export interface CompileModuleOptions extends CompileRouteRulesOptions {
  /**
   * Also emit a ready-to-use matcher export wrapping the compiled
   * `findRouteRules`, so the generated module is directly usable without a
   * hand-written `createMatcherFromFind` wrapper. See {@link MatcherExport}.
   * @default false
   */
  matcher?: MatcherExport;
}

/**
 * Compiled `findRouteRules` module, split into its two composable parts so a
 * caller can either take the whole module ({@link code}, or interpolate the
 * result as a string via `toString()`) or weave it into a larger module —
 * hoisting {@link imports} alongside its own and inlining {@link body} — without
 * re-parsing the source.
 */
export interface CompiledRouteRules {
  /**
   * Handler import statements the generated code references — one per distinct
   * source, in deterministic order (the {@link compileHandlersImport} output).
   * Empty string for a data-only rule set that references no runtime handler.
   * When a matcher export is requested ({@link CompileModuleOptions.matcher}),
   * the `createMatcherFromFind` / `memoizeRouteRulesMatcher` import is appended.
   */
  imports: string;
  /**
   * The `export const findRouteRules = …;` declaration on its own (no imports),
   * followed by the `export const <name> = …;` matcher declaration when a
   * matcher export is requested. References the handler bindings {@link imports}
   * brings into scope.
   */
  body: string;
  /** The complete module source — {@link imports} then {@link body}. Same as `toString()`. */
  code: string;
  /** The complete module source ({@link code}), so the result interpolates as a string. */
  toString(): string;
}
