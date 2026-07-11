// Matcher throughput bench (mitata, standalone — no vitest). Run with
// `pnpm bench` (`node --expose-gc bench/match.mjs`; `--expose-gc` lets mitata
// run GC between benchmarks for stabler samples).
//
// Groups compare runtime vs compiled matchers and are ordered most → least
// production-relevant; each group header carries its own description line
// (mitata prints group names verbatim, so a `\n` in the title renders as a
// subtitle). Benches use mitata `compact()` one-line output; the variant
// legend is printed once before the run.
//
// The full-fixture groups run the {runtime, compiled} × {preMerge} × {memoize}
// grid; `summary()` prints the relative-speed table. `do_not_optimize` keeps
// the JIT from eliding the discarded match result.

import { bench, compact, do_not_optimize, group, run, summary } from "mitata";
import { PROBES } from "./fixture.ts";
import { createBenchMatchers, createRuleBenchMatchers } from "./matchers.ts";
import { RULE_BENCHES } from "./rules.ts";

const HOT_PATH = ["GET", "/rules/nested/override"];
const HOT_ENCODED = ["GET", "/rules/ba-nested/admin%2fpanel"];

// Compact one-line output has no room for prose, so spell the variant axes
// out once up front.
console.log(`groups are ordered most → least production-relevant. variants:
  runtime    createRouteRulesMatcher (rou3 router — the shipped default)
  compiled   evaluated h3-rules/compiler codegen via createMatcherFromFind
  +preMerge  overlapping rule chains merged at build time instead of per match
  +memoize   memoizeRouteRulesMatcher per-URL cache — measures the cache-hit ceiling
`);

// group() with a subtitle line rendered under the `• title` header.
const describedGroup = (title, description, fn) => group(`${title}\n  ${description}`, fn);

// createBenchMatchers() is called once per group: memoize variants carry
// per-instance caches, so each group gets a fresh (cold) set.
describedGroup(
  `mixed sweep — full fixture, ${PROBES.length} matches/iter`,
  `closest to production (diverse URLs): per-match cost ≈ avg ÷ ${PROBES.length}; +memoize rows = bounded-URL steady state (all cache hits)`,
  () => {
    summary(() => {
      compact(() => {
        for (const { name, matcher } of createBenchMatchers()) {
          bench(name, () => {
            for (const [method, pathname] of PROBES) do_not_optimize(matcher(method, pathname));
          });
        }
      });
    });
  },
);

describedGroup(
  `hot path — 1 match/iter (${HOT_PATH.join(" ")})`,
  "single repeated URL: the clean per-match floor; +memoize rows are the pure cache-hit ceiling (a Map lookup), not matcher cost",
  () => {
    summary(() => {
      compact(() => {
        for (const { name, matcher } of createBenchMatchers()) {
          bench(name, () => do_not_optimize(matcher(HOT_PATH[0], HOT_PATH[1])));
        }
      });
    });
  },
);

describedGroup(
  `hot encoded path — 1 match/iter (${HOT_ENCODED.join(" ")})`,
  "adversarial worst case, rare in legit traffic: pathname canonicalizes differently, forcing the raw+canonical dual lookup + union",
  () => {
    summary(() => {
      compact(() => {
        for (const { name, matcher } of createBenchMatchers()) {
          bench(name, () => do_not_optimize(matcher(HOT_ENCODED[0], HOT_ENCODED[1])));
        }
      });
    });
  },
);

// Per built-in rule: hot match against a minimal single-rule set (runtime vs
// compiled), so each handler's match cost is comparable across rules. Least
// realistic — regression tracking, paired with `pnpm bench:size` (same
// `bench/rules.ts` sets).
for (const [i, { name, rules, probe }] of RULE_BENCHES.entries()) {
  const [method, pathname] = probe;
  describedGroup(
    `rule: ${name} — 1 match/iter (${method} ${pathname})`,
    i === 0
      ? "per-handler micro-bench over a minimal single-rule set (regression tracking, pairs with `pnpm bench:size`) — applies to every `rule:` group below"
      : `single-rule set exercising only \`${name}\``,
    () => {
      summary(() => {
        compact(() => {
          for (const variant of createRuleBenchMatchers(rules)) {
            bench(variant.name, () => do_not_optimize(variant.matcher(method, pathname)));
          }
        });
      });
    },
  );
}

await run();
