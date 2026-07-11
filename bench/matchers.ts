import { cache } from "../src/cache.ts";
import { proxy } from "../src/proxy.ts";
import { compileFindRouteRules } from "../src/compiler.ts";
import {
  createMatcherFromFind,
  createRouteRulesMatcher,
  memoizeRouteRulesMatcher,
} from "../src/match.ts";
import type { FindRouteRules, RouteRulesMatcher } from "../src/match.ts";
import { normalizeRouteRules } from "../src/normalize.ts";
import type { RouteRuleConfig, RuleHandlers } from "../src/types.ts";
import { ruleHandlers } from "../src/rules/index.ts";
import { RULES } from "./fixture.ts";

// The fixtures use cache/swr and proxy rules; the core registry ships neither
// handler (they live in `h3-rules/cache` / `h3-rules/proxy`), so runtime
// matchers register them explicitly and compiled evals bind them like the other
// handlers.
const benchHandlers: RuleHandlers = { ...ruleHandlers, cache, proxy };

export interface BenchVariant {
  name: string;
  matcher: RouteRulesMatcher;
}

// Evaluate `compileFindRouteRules` output into a live `FindRouteRules` by
// binding every bench handler as its `<ns>$<name>` local (a superset of what
// the generated code references — unused params are harmless). This is the exact
// codegen a consumer of `h3-rules/compiler` runs.
function evalCompiledFind(code: string): FindRouteRules {
  // eslint-disable-next-line no-new-func
  return new Function(
    ...Object.keys(benchHandlers).map((name) => `__ruleHandlers__$${name}`),
    `return (${code});`,
  )(...Object.values(benchHandlers)) as FindRouteRules;
}

/**
 * Build all matcher variants over the shared fixture:
 * {runtime, compiled} × {plain, preMerge} × {plain, memoize}.
 *
 * Compiled variants evaluate `compileFindRouteRules` output (same as
 * test/compiler.test.ts) and go through `createMatcherFromFind` — the exact
 * code path a consumer of `h3-rules/compiler` codegen runs.
 *
 * Call once per bench group: memoize variants carry per-instance caches.
 */
export function createBenchMatchers(): BenchVariant[] {
  const normalized = normalizeRouteRules(RULES);
  const variants: BenchVariant[] = [];
  for (const preMerge of [false, true]) {
    const code = compileFindRouteRules(normalized, { preMerge });
    for (const memoize of [false, true]) {
      const suffix = (preMerge ? " +preMerge" : "") + (memoize ? " +memoize" : "");
      variants.push(
        {
          name: `runtime${suffix}`,
          matcher: memoize
            ? memoizeRouteRulesMatcher(
                createRouteRulesMatcher(normalized, { preMerge, handlers: benchHandlers }),
              )
            : createRouteRulesMatcher(normalized, { preMerge, handlers: benchHandlers }),
        },
        {
          name: `compiled${suffix}`,
          matcher: memoize
            ? memoizeRouteRulesMatcher(createMatcherFromFind(evalCompiledFind(code)))
            : createMatcherFromFind(evalCompiledFind(code)),
        },
      );
    }
  }
  return variants;
}

/**
 * Build the two shipping matcher variants (runtime router vs compiled codegen)
 * for a single per-rule rule set — the pair the per-rule RPS groups compare so
 * each built-in rule's match cost stands on its own (no memoize/preMerge, which
 * would flatten every rule to a map lookup / most-specific-layer and hide the
 * per-handler difference). Call once per bench group.
 */
export function createRuleBenchMatchers(rules: Record<string, RouteRuleConfig>): BenchVariant[] {
  const normalized = normalizeRouteRules(rules);
  return [
    {
      name: "runtime",
      matcher: createRouteRulesMatcher(normalized, { handlers: benchHandlers }),
    },
    {
      name: "compiled",
      matcher: createMatcherFromFind(evalCompiledFind(compileFindRouteRules(normalized))),
    },
  ];
}
