// Matcher throughput bench (mitata, standalone — no vitest). Run with
// `pnpm bench` (`node --expose-gc bench/match.mjs`; `--expose-gc` lets mitata
// run GC between benchmarks for stabler samples).
//
// Groups compare runtime vs compiled matchers:
//
// - "mixed sweep": one iter = all probe paths; per-match rate = iters/s × PROBES.length.
// - "hot path": one iter = one match; the rate IS the per-match ceiling.
// - "hot encoded path": same, but the pathname canonicalizes differently, so
//   non-memoized variants pay the dual-path (raw + canonical) lookup + union.
// - "rule: <name>": per built-in rule, one hot match against a minimal
//   single-rule set (runtime vs compiled) — isolates each handler's match cost.
//   Pair with `pnpm bench:size` (same `bench/rules.ts` sets).
//
// The full-fixture groups run the {runtime, compiled} × {preMerge} × {memoize}
// grid; `summary()` prints the relative-speed table. `do_not_optimize` keeps the
// JIT from eliding the discarded match result.

import { bench, do_not_optimize, group, run, summary } from "mitata";
import { PROBES } from "./fixture.ts";
import { createBenchMatchers, createRuleBenchMatchers } from "./matchers.ts";
import { RULE_BENCHES } from "./rules.ts";

const HOT_PATH = ["GET", "/rules/nested/override"];
const HOT_ENCODED = ["GET", "/rules/ba-nested/admin%2fpanel"];

// createBenchMatchers() is called once per group: memoize variants carry
// per-instance caches, so each group gets a fresh (cold) set.
group("mixed sweep (27 matches/op)", () => {
  summary(() => {
    for (const { name, matcher } of createBenchMatchers()) {
      bench(name, () => {
        for (const [method, pathname] of PROBES) do_not_optimize(matcher(method, pathname));
      });
    }
  });
});

group("hot path (1 match/op)", () => {
  summary(() => {
    for (const { name, matcher } of createBenchMatchers()) {
      bench(name, () => do_not_optimize(matcher(HOT_PATH[0], HOT_PATH[1])));
    }
  });
});

group("hot encoded path (1 match/op, dual-path)", () => {
  summary(() => {
    for (const { name, matcher } of createBenchMatchers()) {
      bench(name, () => do_not_optimize(matcher(HOT_ENCODED[0], HOT_ENCODED[1])));
    }
  });
});

// Per built-in rule: hot match against a minimal single-rule set (runtime vs
// compiled), so each handler's match cost is comparable across rules.
for (const { name, rules, probe } of RULE_BENCHES) {
  const [method, pathname] = probe;
  group(`rule: ${name} (1 match/op)`, () => {
    summary(() => {
      for (const variant of createRuleBenchMatchers(rules)) {
        bench(variant.name, () => do_not_optimize(variant.matcher(method, pathname)));
      }
    });
  });
}

await run();
