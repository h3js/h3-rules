# Changelog


## v0.1.0

[compare changes](https://github.com/h3js/h3-rules/compare/v0.0.1...v0.1.0)

### 🚀 Enhancements

- **compiler:** Make preMerge fail-safe (warn + fall back instead of throwing) ([b2d6f23](https://github.com/h3js/h3-rules/commit/b2d6f23))
- Real h3 cors handler ([12d8e0b](https://github.com/h3js/h3-rules/commit/12d8e0b))
- ⚠️  Apply cross-cutting review fixes (validity, spec, perf, simplicity) ([a2db926](https://github.com/h3js/h3-rules/commit/a2db926))

### 🩹 Fixes

- **normalize:** Treat bare `swr: false` as a `cache` reset marker ([#1](https://github.com/h3js/h3-rules/pull/1))
- **headers:** Apply post-cache so a `cache-control` override wins ([#5](https://github.com/h3js/h3-rules/pull/5))

### 💅 Refactors

- ⚠️  Improve compiler imports ([3e49d12](https://github.com/h3js/h3-rules/commit/3e49d12))
- Merge default roules with custom ones with compiler ([b0e3503](https://github.com/h3js/h3-rules/commit/b0e3503))
- ⚠️  Refine api ([ac17792](https://github.com/h3js/h3-rules/commit/ac17792))
- Restructure compiler ([6050ad2](https://github.com/h3js/h3-rules/commit/6050ad2))
- Improve handlers format with object shape ([d9c2cb1](https://github.com/h3js/h3-rules/commit/d9c2cb1))
- ⚠️  Treeshakable cache ([c8a06ef](https://github.com/h3js/h3-rules/commit/c8a06ef))
- Treeshakable proxy ([86b584d](https://github.com/h3js/h3-rules/commit/86b584d))

### 🌊 Types

- Drop `RouteRuleConfig `index signature so config typos are compile errors ([c21f9d2](https://github.com/h3js/h3-rules/commit/c21f9d2))

### 🏡 Chore

- Update ocache to 0.2 ([b7eb178](https://github.com/h3js/h3-rules/commit/b7eb178))
- Update deps ([d3f3eb6](https://github.com/h3js/h3-rules/commit/d3f3eb6))
- Update bundle size bench ([8462e18](https://github.com/h3js/h3-rules/commit/8462e18))
- Update deps ([cfac7f9](https://github.com/h3js/h3-rules/commit/cfac7f9))

#### ⚠️ Breaking Changes

- ⚠️  Apply cross-cutting review fixes (validity, spec, perf, simplicity) ([a2db926](https://github.com/h3js/h3-rules/commit/a2db926))
- ⚠️  Improve compiler imports ([3e49d12](https://github.com/h3js/h3-rules/commit/3e49d12))
- ⚠️  Refine api ([ac17792](https://github.com/h3js/h3-rules/commit/ac17792))
- ⚠️  Treeshakable cache ([c8a06ef](https://github.com/h3js/h3-rules/commit/c8a06ef))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.0.1

