import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { describe, expect, it } from "vitest";
import { compileRouteRulesModule } from "../src/compiler.ts";
import { normalizeRouteRules } from "../src/normalize.ts";

// Pins that the `h3-rules` export surface stays tree-shakeable — both via named
// imports and via namespace member access (`import * as rules from "h3-rules";
// rules.xyz`) — so consumers only pay for what they use: no module-level side
// effects in runtime code, module-scope instantiations `/* @__PURE__ */`, and
// compiled codegen importing exactly the used handlers. Verified by bundling
// real entries with esbuild and asserting which inputs contribute bytes.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

// Marks every h3-rules source module as `sideEffects: true`, neutralizing the
// package-level `"sideEffects": false` shortcut (which lets bundlers drop whole
// unused modules regardless of their contents). Under this plugin, shaking must
// rest on genuinely side-effect-free module scopes and `/* @__PURE__ */`
// annotations alone — so a stray module-level side effect or a dropped PURE
// annotation fails the suite instead of being masked by the package hint.
const forceSideEffects: Plugin = {
  name: "force-side-effects",
  setup(build) {
    build.onResolve({ filter: /^h3-rules$/ }, () => ({
      path: join(SRC, "index.ts"),
      sideEffects: true,
    }));
    // In-repo imports are always relative and carry explicit `.ts` extensions.
    build.onResolve({ filter: /^\.\.?\// }, (args) =>
      args.importer.startsWith(SRC)
        ? { path: join(dirname(args.importer), args.path), sideEffects: true }
        : null,
    );
    // The `h3` peer is external, so esbuild would keep every module's
    // `import … from "h3"` statement as a potential side effect — declare it
    // side-effect free to keep the assertions strict on this repo's modules.
    build.onResolve({ filter: /^h3$/ }, () => ({
      path: "h3",
      external: true,
      sideEffects: false,
    }));
  },
};

async function bundle(
  contents: string,
  opts?: { forceSideEffects?: boolean },
): Promise<{ bytes: number; inputs: string[]; has: (m: string) => boolean }> {
  const result = await build({
    stdin: { contents, resolveDir: ROOT, loader: "js" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    minify: true,
    write: false,
    metafile: true,
    external: ["h3"],
    alias: { "h3-rules": join(SRC, "index.ts") },
    plugins: opts?.forceSideEffects ? [forceSideEffects] : [],
    logLevel: "silent",
  });
  const output = Object.values(result.metafile.outputs)[0]!;
  const contributing = Object.entries(output.inputs)
    .filter(([, input]) => input.bytesInOutput > 0)
    .map(([file]) => file)
    .sort();
  return {
    bytes: result.outputFiles[0]!.contents.byteLength,
    inputs: contributing,
    has: (marker) => contributing.some((file) => file.includes(marker)),
  };
}

describe("tree-shaking (esbuild)", () => {
  it("namespace member access shakes everything unused", async () => {
    const out = await bundle(`import * as rules from "h3-rules";\nexport const h = rules.headers;`);
    expect(out.has("rou3")).toBe(false);
    expect(out.has("ocache")).toBe(false);
    expect(out.has("ufo")).toBe(false);
    expect(out.has("src/match.ts")).toBe(false);
    expect(out.has("src/rules/cache.ts")).toBe(false);
    expect(out.bytes).toBeLessThan(1024);
  });

  it("shaking holds without the package `sideEffects: false` hint", async () => {
    const out = await bundle(
      `import * as rules from "h3-rules";\nexport const h = rules.headers;`,
      { forceSideEffects: true },
    );
    expect(out.has("src/rules/cache.ts")).toBe(false);
    expect(out.has("src/match.ts")).toBe(false);
    expect(out.has("ocache")).toBe(false);
    expect(out.has("rou3")).toBe(false);
  });

  it("named import matches the namespace-access result", async () => {
    const ns = await bundle(`import * as rules from "h3-rules";\nexport const h = rules.headers;`);
    const named = await bundle(`import { headers } from "h3-rules";\nexport const h = headers;`);
    expect(named.inputs).toEqual(ns.inputs);
  });

  it("full runtime matcher pulls rou3 (control for the absence assertions)", async () => {
    // Positive marker control: if metafile paths ever stop matching the
    // `has()` markers, this fails instead of the absence assertions above
    // passing vacuously.
    const out = await bundle(
      `import { createRouteRulesMatcher } from "h3-rules";\nexport const m = createRouteRulesMatcher({});`,
    );
    expect(out.has("rou3")).toBe(true);
    expect(out.has("src/match.ts")).toBe(true);
  });

  it("compiled-matcher wrap keeps rou3 and handler deps out", async () => {
    const out = await bundle(
      `import * as rules from "h3-rules";\nexport const m = rules.createMatcherFromFind(() => []);`,
    );
    expect(out.has("rou3")).toBe(false);
    expect(out.has("ocache")).toBe(false);
    expect(out.has("ufo")).toBe(false);
  });

  it("cache pulls ocache but nothing else", async () => {
    const out = await bundle(`import * as rules from "h3-rules";\nexport const c = rules.cache;`);
    expect(out.has("ocache")).toBe(true);
    expect(out.has("rou3")).toBe(false);
    expect(out.has("ufo")).toBe(false);
  });

  it("compiled codegen module shakes unused handler deps", async () => {
    const mod = compileRouteRulesModule(
      normalizeRouteRules({ "/api/**": { headers: { "cache-control": "s-maxage=60" } } }),
    );
    const out = await bundle(`${mod}\nexport const find = findRouteRules;`);
    expect(out.has("rou3")).toBe(false);
    expect(out.has("ocache")).toBe(false);
    expect(out.has("ufo")).toBe(false);
    expect(out.bytes).toBeLessThan(2048);
  });
});
