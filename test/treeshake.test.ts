import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { describe, expect, it } from "vitest";
import { compileRouteRules } from "../src/compiler.ts";

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
    build.onResolve({ filter: /^h3-rules\/cache$/ }, () => ({
      path: join(SRC, "cache.ts"),
      sideEffects: true,
    }));
    build.onResolve({ filter: /^h3-rules\/proxy$/ }, () => ({
      path: join(SRC, "proxy.ts"),
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
): Promise<{ bytes: number; code: string; inputs: string[]; has: (m: string) => boolean }> {
  const result = await build({
    stdin: { contents, resolveDir: ROOT, loader: "js" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    minify: true,
    write: false,
    metafile: true,
    external: ["h3"],
    alias: {
      "h3-rules": join(SRC, "index.ts"),
      "h3-rules/cache": join(SRC, "cache.ts"),
      "h3-rules/proxy": join(SRC, "proxy.ts"),
    },
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
    code: result.outputFiles[0]!.text,
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

  it("un-memoized createMatcherFromFind shakes out the memoize wrapper", async () => {
    // Memoization is wired in createRouteRulesMatcher, not createMatcherFromFind,
    // so an un-memoized compiled matcher must not bundle memoizeRouteRulesMatcher
    // (~240 B). `.keys().next()` is its FIFO eviction — a marker no other matcher
    // code emits — so its absence pins the wrapper out of the compiled path.
    const out = await bundle(
      `import * as rules from "h3-rules";\nexport const m = rules.createMatcherFromFind(() => []);`,
    );
    expect(out.code).not.toContain(".next(");
  });

  it("the whole h3-rules surface carries no ocache reference", async () => {
    // Retain every export — the core entry must not reference ocache at all;
    // the ocache-backed cache handler lives solely in `h3-rules/cache`.
    const out = await bundle(
      `import * as rules from "h3-rules";\nexport const all = { ...rules };`,
    );
    expect(out.has("ocache")).toBe(false);
    expect(out.has("src/match.ts")).toBe(true); // control: the surface is really retained
  });

  it("h3-rules/cache pulls ocache but not the matcher or ufo", async () => {
    const out = await bundle(`import { cache } from "h3-rules/cache";\nexport const c = cache;`);
    expect(out.has("ocache")).toBe(true);
    expect(out.has("rou3")).toBe(false);
    expect(out.has("ufo")).toBe(false);
    expect(out.has("src/match.ts")).toBe(false);
  });

  it("the whole h3-rules surface carries no proxy handler reference", async () => {
    // Retain every export — the core entry must not reference the `proxy`
    // handler (nor h3's `proxyRequest` it imports); it lives solely in
    // `h3-rules/proxy` so a non-proxying bundle never pulls that machinery in.
    const out = await bundle(
      `import * as rules from "h3-rules";\nexport const all = { ...rules };`,
    );
    expect(out.has("src/proxy.ts")).toBe(false);
    expect(out.has("src/match.ts")).toBe(true); // control: the surface is really retained
  });

  it("h3-rules/proxy resolves the proxy handler without the matcher or rou3", async () => {
    const out = await bundle(`import { proxy } from "h3-rules/proxy";\nexport const p = proxy;`);
    expect(out.has("src/proxy.ts")).toBe(true);
    expect(out.has("rou3")).toBe(false);
    expect(out.has("ocache")).toBe(false);
    expect(out.has("src/match.ts")).toBe(false);
  });

  it("compiled codegen with a proxy rule imports the handler via h3-rules/proxy only", async () => {
    // Positive control for the subpath sourcing: the generated
    // `import { proxy … } from "h3-rules/proxy"` must resolve, while the rou3
    // router still stays out of the compiled bundle.
    const mod = compileRouteRules({ "/api/**": { proxy: "https://up.example/**" } });
    expect(mod.imports).toContain('from "h3-rules/proxy"');
    const out = await bundle(`${mod}\nexport const find = findRouteRules;`);
    expect(out.has("src/proxy.ts")).toBe(true);
    expect(out.has("rou3")).toBe(false);
  });

  it("compiled codegen module shakes unused handler deps", async () => {
    const mod = compileRouteRules({ "/api/**": { headers: { "cache-control": "s-maxage=60" } } });
    const out = await bundle(`${mod}\nexport const find = findRouteRules;`);
    expect(out.has("rou3")).toBe(false);
    expect(out.has("ocache")).toBe(false);
    expect(out.has("ufo")).toBe(false);
    expect(out.bytes).toBeLessThan(2048);
  });

  it("compiled codegen with a cache rule imports ocache via h3-rules/cache only", async () => {
    // Positive control for the subpath sourcing: the generated
    // `import { cache … } from "h3-rules/cache"` must resolve and carry ocache,
    // while the rou3 router still stays out of the compiled bundle.
    const mod = compileRouteRules({ "/api/**": { swr: 60 } });
    expect(mod.imports).toContain('from "h3-rules/cache"');
    const out = await bundle(`${mod}\nexport const find = findRouteRules;`);
    expect(out.has("ocache")).toBe(true);
    expect(out.has("src/cache.ts")).toBe(true);
    expect(out.has("rou3")).toBe(false);
  });
});
