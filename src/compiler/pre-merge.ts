import { createRulesRouter } from "../match.ts";
import type { RouteRules } from "../types.ts";
import type { CompileRouteRulesOptions } from "./options.ts";

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
export function resolveEffectivePreMerge(
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
