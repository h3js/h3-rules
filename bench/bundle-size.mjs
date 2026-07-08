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
//   module) + `createMatcherFromFind`. No rou3 router in the bundle, and only
//   the used handler + its deps are imported — so the compiled column shows each
//   rule's true tree-shaken footprint (cache→ocache, redirect/proxy→ufo, and
//   headers/cors/basicAuth ship no extra deps).
//
// The per-dep columns (rou3/ocache/ufo) are the bytes each package contributes
// to that bundle. Bundles are minified ESM with `h3` external (a peer dependency
// the host app ships either way). Entries are generated into bench/.generated/.

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { compileRouteRulesModule } from "../src/compiler.ts";
import { normalizeRouteRules } from "../src/normalize.ts";
import { RULE_BENCHES } from "./rules.ts";

const genDir = fileURLToPath(new URL("./.generated/", import.meta.url));
const srcIndex = fileURLToPath(new URL("../src/index.ts", import.meta.url));

// External deps whose per-bundle contribution the table breaks out.
const DEPS = ["rou3", "ocache", "ufo"];

// Build the runtime + compiled entry files for one rule spec. `slug` namespaces
// the generated files so specs don't collide in bench/.generated/.
function variantsFor(spec) {
  const slug = spec.name;
  const normalized = normalizeRouteRules(spec.rules);
  return [
    {
      rule: spec.name,
      mode: "runtime",
      entry: `entry-${slug}-runtime.mjs`,
      files: {
        [`rules-${slug}.data.mjs`]: `export const rules = ${JSON.stringify(spec.rules)};\n`,
        [`entry-${slug}-runtime.mjs`]: [
          `import { createRouteRulesMatcher, normalizeRouteRules } from "h3-rules";`,
          `import { rules } from "./rules-${slug}.data.mjs";`,
          `export const matcher = createRouteRulesMatcher(normalizeRouteRules(rules));`,
          ``,
        ].join("\n"),
      },
    },
    {
      rule: spec.name,
      mode: "compiled",
      entry: `entry-${slug}-compiled.mjs`,
      files: {
        [`rules-${slug}.compiled.mjs`]: compileRouteRulesModule(normalized),
        [`entry-${slug}-compiled.mjs`]: [
          `import { createMatcherFromFind } from "h3-rules";`,
          `import { findRouteRules } from "./rules-${slug}.compiled.mjs";`,
          `export const matcher = createMatcherFromFind(findRouteRules);`,
          ``,
        ].join("\n"),
      },
    },
  ];
}

async function measure(variant) {
  const result = await build({
    entryPoints: [genDir + variant.entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    minify: true,
    write: false,
    metafile: true,
    external: ["h3"],
    alias: { "h3-rules": srcIndex },
    logLevel: "silent",
  });
  const output = result.outputFiles[0].contents;
  const inputs = Object.values(result.metafile.outputs)[0].inputs;
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

await mkdir(genDir, { recursive: true });
for (const variant of variants) {
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
    `\nruntime +preMerge shares the runtime bundle (flag only). Entries: bench/.generated/`,
);
