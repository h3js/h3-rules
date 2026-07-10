// Bundle-size bench (esbuild): what shipping h3-rules costs a consumer, broken
// down per built-in route rule. Run with `pnpm bench:size`.
//
// For each rule in the shared `bench/rules.ts` spec, a minimal single-rule set
// is bundled two ways — the two shipping modes:
//
// - runtime: rules config as data + `normalizeRouteRules` + `createRouteRulesMatcher`
//   (rou3 router built at startup). `preMerge` is a flag on the same code, so
//   its bundle is identical.
// - compiled: `h3-rules/compiler` codegen output (rules baked into a generated
//   module, pre-merged) + `createMatcherFromFind`. No rou3 router in the bundle, and only
//   the used handler + its deps are imported — so the compiled column shows each
//   rule's true tree-shaken footprint (cache→ocache, redirect/proxy→ufo, and
//   headers/cors/basicAuth ship no extra deps).
//
// The per-dep columns (rou3/ocache/ufo) are the bytes each package contributes
// to that bundle. Measured bundles are minified ESM with `h3` external (a peer
// dependency the host app ships either way).
//
// Everything is written to bench/.generated/rules/<rule>/ for inspection.
// Each mode inlines its rules straight into the one entry file — runtime as
// JSON, compiled as the whole `compileRouteRules(..., { matcher: true })` module
// (handler imports + `findRouteRules` + the `createMatcherFromFind` export):
//
// - <mode>.entry.mjs                    — the bundled entry point
// - <mode>.bundle.mjs                   — readable bundle: h3 + ocache external,
//                                         unminified for reading
//
// The measured bundle (minified, h3 external) is built in memory only — we just
// need its byte size — and is not written to disk.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { compileRouteRules } from "../src/compiler.ts";
import { normalizeRouteRules } from "../src/normalize.ts";
import { RULE_BENCHES } from "./rules.ts";

const genDir = fileURLToPath(new URL("./.generated/", import.meta.url));
const srcIndex = fileURLToPath(new URL("../src/index.ts", import.meta.url));

// External deps whose per-bundle contribution the table breaks out.
const DEPS = ["rou3", "ocache", "ufo"];

// Build the runtime + compiled entry files for one rule spec. Each spec gets
// its own `rules/<name>/` directory under bench/.generated/.
function variantsFor(spec) {
  const dir = `rules/${spec.name}/`;
  const normalized = normalizeRouteRules(spec.rules);
  // preMerge: the shipping-mode pairing — compiled sets are static, so they can
  // always pre-merge (bench sets are chain-clean by construction). `matcher:
  // true` folds the `createMatcherFromFind(findRouteRules)` wrapper into the
  // generated module, so `compiled.code` is a complete, directly-usable entry —
  // exactly what a consumer ships.
  const compiled = compileRouteRules(normalized, { preMerge: true, matcher: true });
  return [
    {
      rule: spec.name,
      mode: "runtime",
      dir,
      entry: `${dir}runtime.entry.mjs`,
      files: {
        // Rules inlined as JSON (they're serializable) — the entry is the whole
        // runtime input.
        [`${dir}runtime.entry.mjs`]: [
          `import { createRouteRulesMatcher, normalizeRouteRules } from "h3-rules";`,
          `const rules = ${JSON.stringify(spec.rules)};`,
          `export const matcher = createRouteRulesMatcher(normalizeRouteRules(rules));`,
          ``,
        ].join("\n"),
      },
    },
    {
      rule: spec.name,
      mode: "compiled",
      dir,
      entry: `${dir}compiled.entry.mjs`,
      files: {
        // `matcher: true` makes the codegen a complete module (handler imports +
        // `findRouteRules` + the `createMatcherFromFind` matcher export), so the
        // whole entry is just `compiled.code`.
        [`${dir}compiled.entry.mjs`]: compiled.code,
      },
    },
  ];
}

async function measure(variant) {
  const shared = {
    entryPoints: [genDir + variant.entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    metafile: true,
    alias: { "h3-rules": srcIndex },
    logLevel: "silent",
  };
  // Measured bundle: what the table reports — minified, `h3` external. ocache
  // stays inlined here so the table's ocache column can measure it. Kept
  // in-memory only (we just need its size); not written to disk.
  const measured = await build({ ...shared, minify: true, external: ["h3"] });
  // Readable bundle: unminified with h3 + ocache external, so the shipped
  // h3-rules code can be read directly. Not what the table measures — this is
  // the one written to disk, for inspection.
  const readable = await build({
    ...shared,
    minify: false,
    external: ["h3", "ocache"],
    banner: {
      js: `// ${variant.rule} (${variant.mode}) — readable bundle: h3 + ocache external, unminified.`,
    },
  });
  const output = measured.outputFiles[0].contents;
  await writeFile(
    `${genDir}${variant.dir}${variant.mode}.bundle.mjs`,
    readable.outputFiles[0].contents,
  );
  const inputs = Object.values(measured.metafile.outputs)[0].inputs;
  const sum = (test) =>
    Object.entries(inputs)
      .filter(([file]) => test(file))
      .reduce((total, [, input]) => total + input.bytesInOutput, 0);
  return {
    rule: variant.rule,
    mode: variant.mode,
    minified: output.byteLength,
    gzip: gzipSync(output, { level: 9 }).byteLength,
    deps: Object.fromEntries(
      // Match the package as a path segment — works for both node_modules and the
      // `pnpm link`ed rou3 checkout (`../../rou3/main/…`).
      DEPS.map((dep) => [dep, sum((file) => new RegExp(`(?:^|/)${dep}/`).test(file))]),
    ),
  };
}

function formatTable(rows, columns) {
  const widths = columns.map((column) =>
    Math.max(column.label.length, ...rows.map((row) => column.value(row).length)),
  );
  const line = (cells, pad = " ") =>
    cells.map((cell, index) => cell[index === 0 ? "padEnd" : "padStart"](widths[index], pad));
  return [
    line(columns.map((column) => column.label)).join("  "),
    line(
      columns.map(() => ""),
      "-",
    ).join("  "),
    ...rows.map((row) => line(columns.map((column) => column.value(row))).join("  ")),
  ].join("\n");
}

const kB = (bytes) => `${(bytes / 1024).toFixed(2)} kB`;
// Zero bytes render as "-" so the meaningful per-dep contributions stand out.
const depCell = (bytes) => (bytes ? kB(bytes) : "-");

const variants = RULE_BENCHES.flatMap(variantsFor);

// Regenerate from scratch so renamed/removed rules leave no stale files behind.
await rm(genDir, { recursive: true, force: true });
for (const variant of variants) {
  await mkdir(genDir + variant.dir, { recursive: true });
  for (const [name, contents] of Object.entries(variant.files)) {
    await writeFile(genDir + name, contents);
  }
}

const rows = await Promise.all(variants.map((variant) => measure(variant)));

console.log(
  `h3-rules per-rule bundle size (minified ESM, h3 external, one minimal single-rule set each)\n`,
);
console.log(
  formatTable(rows, [
    { label: "rule", value: (row) => (row.mode === "runtime" ? row.rule : "") },
    { label: "mode", value: (row) => row.mode },
    { label: "minified", value: (row) => kB(row.minified) },
    { label: "gzip", value: (row) => kB(row.gzip) },
    ...DEPS.map((dep) => ({ label: dep, value: (row) => depCell(row.deps[dep]) })),
  ]),
);
console.log(
  `\nrou3/ocache/ufo = bytes each package contributes to that bundle ("-" = tree-shaken out).` +
    `\ncompiled mode drops the rou3 router and imports only the used handler + its deps.` +
    `\nruntime +preMerge shares the runtime bundle (flag only).` +
    `\nbench/.generated/rules/<rule>/ has entries and readable bundles` +
    `\n(*.bundle.mjs, h3 + ocache external, unminified); the measured minified` +
    `\nbundle is sized in memory and not written.`,
);
