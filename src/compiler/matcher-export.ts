import type { MatcherMemoizeOptions } from "../match.ts";
import { assertHandlerBinding } from "./binding.ts";

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
