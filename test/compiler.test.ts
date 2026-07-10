import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_RULES,
  RUNTIME_RULE_NAMES,
  compileFindRouteRules,
  compileHandlersImport,
  compileRouteRulesModule,
} from "../src/compiler.ts";
import * as h3Rules from "../src/index.ts";
import { createMatcherFromFind, createRouteRulesMatcher } from "../src/match.ts";
import type { FindRouteRules, RouteRulesMatcher } from "../src/match.ts";
import { normalizeRouteRules } from "../src/normalize.ts";
import { ruleHandlers } from "../src/rules/index.ts";
import type { RouteRuleConfig } from "../src/types.ts";
import { FIXTURE, PROBES, snapshotResult } from "./_fixture.ts";

// Bind every registry handler as its `<ns>$<name>` local (superset of what any
// generated code references — unused params are harmless; the "references
// exactly the handlers the import emits" test below guards against the
// generated code depending on a binding the real import would not provide).
function evaluateFind(code: string): FindRouteRules {
  const params = Object.keys(ruleHandlers).map((name) => `__ruleHandlers__$${name}`);
  // eslint-disable-next-line no-new-func
  return new Function(...params, `return (${code});`)(
    ...Object.values(ruleHandlers),
  ) as FindRouteRules;
}

function evaluateCompiled(rules: Record<string, RouteRuleConfig>): RouteRulesMatcher {
  return createMatcherFromFind(evaluateFind(compileFindRouteRules(normalizeRouteRules(rules))));
}

describe("compiler parity", () => {
  const runtime = createRouteRulesMatcher(normalizeRouteRules(FIXTURE));
  const compiled = evaluateCompiled(FIXTURE);

  it.each(PROBES)("compiled === runtime for %s %s", (method, pathname) => {
    const runtimeResult = runtime(method, pathname);
    const compiledResult = compiled(method, pathname);
    expect(snapshotResult(compiledResult)).toEqual(snapshotResult(runtimeResult));
  });

  it("compiled method-scoped overrides match runtime (agnostic fallback)", () => {
    // Regression (rou3#190): compiled matchAll used to push BOTH the
    // method-scoped and the agnostic registration of a pattern, letting the
    // duplicate agnostic layer re-override method-scoped values.
    const rules = normalizeRouteRules({
      "/api/**": { headers: { "x-b": "all" } },
      "GET /api/**": { headers: { "x-b": "get" } },
    });
    const runtime = createRouteRulesMatcher(rules);
    const compiled = evaluateCompiled({
      "/api/**": { headers: { "x-b": "all" } },
      "GET /api/**": { headers: { "x-b": "get" } },
    });
    expect(compiled("GET", "/api/x").routeRules.headers!.options).toEqual({ "x-b": "get" });
    expect(snapshotResult(compiled("GET", "/api/x"))).toEqual(
      snapshotResult(runtime("GET", "/api/x")),
    );
    expect(snapshotResult(compiled("POST", "/api/x"))).toEqual(
      snapshotResult(runtime("POST", "/api/x")),
    );
  });

  it("compiled matcher works with baseURL", () => {
    const rules = normalizeRouteRules({ "/x": { headers: { "x-a": "1" } } });
    const runtimeBase = createRouteRulesMatcher(rules, { baseURL: "/base/" });
    const code = compileFindRouteRules(rules, { baseURL: "/base/" });
    const compiledBase = createMatcherFromFind(evaluateFind(code));
    for (const path of ["/base/x", "/x", "/base/other"]) {
      expect(snapshotResult(compiledBase("GET", path))).toEqual(
        snapshotResult(runtimeBase("GET", path)),
      );
    }
  });
});

describe("generated code shape", () => {
  it("references runtime handlers by name and skips data-only rules", () => {
    const code = compileFindRouteRules(
      normalizeRouteRules({
        "/a/**": { redirect: "/b", prerender: true },
      }),
    );
    expect(code).toContain("handler:__ruleHandlers__$redirect");
    expect(code).toContain('name:"prerender"');
    expect(code).not.toContain("handler:__ruleHandlers__$prerender");
  });

  it("serializes method scope", () => {
    const code = compileFindRouteRules(
      normalizeRouteRules({ "GET /a/**": { headers: { a: "1" } } }),
    );
    expect(code).toContain('method:"GET"');
  });

  it("references exactly the handler bindings the import emits", () => {
    // The eval harness above binds every registry handler, so it cannot catch
    // generated code referencing a `__ruleHandlers__$x` binding that
    // `compileHandlersImport` never imports (a ReferenceError in every real
    // consumer module). Pin set-equality between references and imports.
    for (const opts of [undefined, { preMerge: true }] as const) {
      const rules = normalizeRouteRules(FIXTURE);
      const code = compileFindRouteRules(rules, opts);
      const bindings = (source: string) =>
        [...new Set([...source.matchAll(/__ruleHandlers__\$(\w+)/g)].map((m) => m[1]!))].sort();
      expect(bindings(code)).toEqual(bindings(compileHandlersImport(rules, opts)));
    }
  });

  it("imports exactly the handlers the rule set uses", () => {
    const rules = normalizeRouteRules({
      "/a/**": { redirect: "/b", prerender: true },
      "/b/**": { headers: { a: "1" } },
      // `false` resets are serialized with their handler — they count as used.
      "/b/off": { basicAuth: false },
    });
    expect(compileHandlersImport(rules)).toBe(
      'import { basicAuth as __ruleHandlers__$basicAuth, headers as __ruleHandlers__$headers, redirect as __ruleHandlers__$redirect } from "h3-rules";',
    );
  });

  it("emits no handlers import for data-only rule sets", () => {
    const rules = normalizeRouteRules({ "/a": { prerender: true } });
    expect(compileHandlersImport(rules)).toBe("");
    const mod = compileRouteRulesModule(rules);
    expect(mod).not.toContain("import");
    expect(mod.startsWith("export const findRouteRules = ")).toBe(true);
    const matcher = createMatcherFromFind(evaluateFind(compileFindRouteRules(rules)));
    expect(matcher("GET", "/a").routeRules.prerender!.options).toBe(true);
  });

  it("is parameterized on the handler binding prefix and per-rule source", () => {
    const rules = normalizeRouteRules({ "/a": { redirect: "/b" } });
    expect(compileHandlersImport(rules)).toBe(
      'import { redirect as __ruleHandlers__$redirect } from "h3-rules";',
    );
    expect(
      compileHandlersImport(rules, {
        runtimeRules: { redirect: "#my/rules" },
        handlersImportName: "__rr__",
      }),
    ).toBe('import { redirect as __rr__$redirect } from "#my/rules";');
    const code = compileFindRouteRules(rules, { handlersImportName: "__rr__" });
    expect(code).toContain("handler:__rr__$redirect");
  });

  it("DEFAULT_RUNTIME_RULES presets every built-in to the h3-rules source", () => {
    expect(Object.keys(DEFAULT_RUNTIME_RULES).sort()).toEqual([...RUNTIME_RULE_NAMES].sort());
    for (const name of RUNTIME_RULE_NAMES) {
      expect(DEFAULT_RUNTIME_RULES[name]).toBe("h3-rules");
    }
  });

  it("supports custom runtime rule names via a bare-string source", () => {
    const rules = normalizeRouteRules({ "/a": { shout: "x" } });
    const opts = { runtimeRules: { shout: "h3-rules" } };
    expect(compileFindRouteRules(rules, opts)).toContain("handler:__ruleHandlers__$shout");
    expect(compileHandlersImport(rules, opts)).toBe(
      'import { shout as __ruleHandlers__$shout } from "h3-rules";',
    );
  });

  it("sources a rule handler from a per-rule { source, export } override", () => {
    // A custom rule handler living in its own module under a different export
    // name, alongside a built-in kept on the h3-rules source via the preset.
    const rules = normalizeRouteRules({ "/a/**": { redirect: "/b", isr: 60 } });
    const opts = {
      runtimeRules: {
        ...DEFAULT_RUNTIME_RULES,
        isr: { source: "#nitro/rules", export: "handleISR" },
      },
    };
    expect(compileFindRouteRules(rules, opts)).toContain("handler:__ruleHandlers__$isr");
    // One import per source, sources sorted; export aliased to the `<ns>$<name>`
    // binding the generated code references.
    expect(compileHandlersImport(rules, opts)).toBe(
      'import { handleISR as __ruleHandlers__$isr } from "#nitro/rules";\n' +
        'import { redirect as __ruleHandlers__$redirect } from "h3-rules";',
    );
  });

  it("overrides a built-in's source module (export defaults to the rule name)", () => {
    const rules = normalizeRouteRules({ "/a/**": { cache: { maxAge: 60 }, headers: { a: "1" } } });
    const opts = { runtimeRules: { ...DEFAULT_RUNTIME_RULES, cache: "#nitro/cache" } };
    expect(compileHandlersImport(rules, opts)).toBe(
      'import { cache as __ruleHandlers__$cache } from "#nitro/cache";\n' +
        'import { headers as __ruleHandlers__$headers } from "h3-rules";',
    );
  });

  it("groups multiple handlers sharing a source into one import statement", () => {
    const rules = normalizeRouteRules({
      "/a/**": { redirect: "/b", isr: true, prerender: true },
    });
    const opts = {
      runtimeRules: {
        redirect: "#nitro/rules",
        isr: { source: "#nitro/rules", export: "handleISR" },
        prerender: "#nitro/rules",
      },
    };
    // All three share `#nitro/rules` → a single import, specifiers in binding order.
    expect(compileHandlersImport(rules, opts)).toBe(
      'import { handleISR as __ruleHandlers__$isr, prerender as __ruleHandlers__$prerender, redirect as __ruleHandlers__$redirect } from "#nitro/rules";',
    );
  });

  it("throws when a per-rule export is not a valid JS identifier", () => {
    const rules = normalizeRouteRules({ "/a": { redirect: "/b" } });
    const opts = { runtimeRules: { redirect: { source: "h3-rules", export: "not valid" } } };
    expect(() => compileHandlersImport(rules, opts)).toThrow(/valid JS identifier/);
  });

  it("emits a complete module", () => {
    const mod = compileRouteRulesModule(normalizeRouteRules({ "/a": { redirect: "/b" } }));
    expect(mod).toContain('import { redirect as __ruleHandlers__$redirect } from "h3-rules";');
    expect(mod).toContain("export const findRouteRules = ");
  });

  it("default RUNTIME_RULE_NAMES matches the ruleHandlers registry", () => {
    expect([...RUNTIME_RULE_NAMES].sort()).toEqual(Object.keys(ruleHandlers).sort());
  });

  it("every runtime rule handler is a named export of h3-rules", () => {
    // The default handlers import id is "h3-rules": generated named imports
    // must resolve to the exact registry handlers.
    for (const name of RUNTIME_RULE_NAMES) {
      expect((h3Rules as Record<string, unknown>)[name], name).toBe(ruleHandlers[name]);
    }
  });

  it("preMerge does not import handlers only referenced by resolved `false` resets", () => {
    // preMerge applies `false` resets at compile time, so they never appear in
    // (or reference a handler from) the generated entries.
    const rules = normalizeRouteRules({ "/a/**": { basicAuth: false, headers: { a: "1" } } });
    expect(compileHandlersImport(rules)).toBe(
      'import { basicAuth as __ruleHandlers__$basicAuth, headers as __ruleHandlers__$headers } from "h3-rules";',
    );
    expect(compileHandlersImport(rules, { preMerge: true })).toBe(
      'import { headers as __ruleHandlers__$headers } from "h3-rules";',
    );
    expect(compileFindRouteRules(rules, { preMerge: true })).not.toContain("$basicAuth");
  });
});

describe("fail-safe preMerge", () => {
  // A non-chain-clean rule set (partial overlap) with a `false` reset on a
  // runtime rule: preMerge would resolve the reset away (no `$basicAuth`), plain
  // mode serializes it with its handler. If the fallback desynced find codegen
  // from the handlers import, generated code would reference an un-imported
  // binding — so this fixture also guards the import/reference contract.
  const NON_CHAIN_CLEAN = {
    "/a/*/c": { headers: { a: "1" }, basicAuth: false },
    "/a/b/*": { headers: { b: "2" } },
  } as const;

  it("compileHandlersImport falls back to plain handler set (imports the reset's handler)", () => {
    const rules = normalizeRouteRules(NON_CHAIN_CLEAN);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // preMerge requested but not applicable → plain mode → `basicAuth: false`
      // is serialized with its handler, so its import must be present.
      expect(compileHandlersImport(rules, { preMerge: true })).toBe(
        'import { basicAuth as __ruleHandlers__$basicAuth, headers as __ruleHandlers__$headers } from "h3-rules";',
      );
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/preMerge.*falling back/s));
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps find references and handler imports in sync when falling back", () => {
    const rules = normalizeRouteRules(NON_CHAIN_CLEAN);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const code = compileFindRouteRules(rules, { preMerge: true });
      const bindings = (source: string) =>
        [...new Set([...source.matchAll(/__ruleHandlers__\$(\w+)/g)].map((m) => m[1]!))].sort();
      expect(bindings(code)).toEqual(bindings(compileHandlersImport(rules, { preMerge: true })));
      // The fallback emits the plain `$basicAuth` handler for the reset.
      expect(bindings(code)).toContain("basicAuth");
    } finally {
      warn.mockRestore();
    }
  });

  it("compileRouteRulesModule warns once and emits a working plain module", () => {
    const rules = normalizeRouteRules(NON_CHAIN_CLEAN);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mod = compileRouteRulesModule(rules, { preMerge: true });
      // Resolved once up front, not once per sub-call.
      expect(warn).toHaveBeenCalledTimes(1);
      // Import and codegen agree: the module evaluates without a ReferenceError.
      expect(mod).toContain("__ruleHandlers__$basicAuth");
      const findSrc = mod
        .slice(mod.indexOf("=") + 1)
        .trim()
        .replace(/;\s*$/, "");
      const compiled = createMatcherFromFind(evaluateFind(findSrc));
      const plain = createRouteRulesMatcher(rules);
      for (const path of ["/a/b/c", "/a/x/c", "/a/b/x"]) {
        expect(snapshotResult(compiled("GET", path))).toEqual(snapshotResult(plain("GET", path)));
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe("compile-time validation", () => {
  it("throws on function-valued options (silently dropped by JSON)", () => {
    const rules = normalizeRouteRules({
      "/api/**": { proxy: { to: "/upstream/**", onResponse: () => {} } },
    });
    expect(() => compileFindRouteRules(rules)).toThrow(/non-JSON-serializable.*onResponse/);
  });

  it("throws on class instances that JSON mangles (Date, RegExp)", () => {
    expect(() =>
      compileFindRouteRules(normalizeRouteRules({ "/a": { custom: { at: new Date(0) } } })),
    ).toThrow(/non-JSON-serializable.*Date/);
    expect(() =>
      compileFindRouteRules(normalizeRouteRules({ "/a": { custom: { pattern: /x/ } } })),
    ).toThrow(/non-JSON-serializable.*RegExp/);
  });

  it("throws on nested undefined (silently dropped by JSON)", () => {
    expect(() =>
      compileFindRouteRules(normalizeRouteRules({ "/a": { custom: { a: undefined } } })),
    ).toThrow(/non-JSON-serializable/);
  });

  it("accepts JSON-safe options including `false` resets and null", () => {
    const rules = normalizeRouteRules({
      "/a/**": { cache: false, custom: { n: null, deep: [{ ok: true }] } },
    });
    expect(() => compileFindRouteRules(rules)).not.toThrow();
  });

  it("throws when a handler binding is not a valid JS identifier", () => {
    // Handler references bind as `<ns>$<name>` identifiers in generated code —
    // fail at compile time, not with a parse error in the consumer's module.
    const rules = normalizeRouteRules({ "/a": { "my-rule": "x" } });
    const opts = { runtimeRules: { "my-rule": "h3-rules" } };
    expect(() => compileHandlersImport(rules, opts)).toThrow(/valid JS identifier/);
    expect(() => compileFindRouteRules(rules, opts)).toThrow(/valid JS identifier/);
    expect(() =>
      compileFindRouteRules(normalizeRouteRules({ "/a": { redirect: "/b" } }), {
        handlersImportName: "not valid",
      }),
    ).toThrow(/valid JS identifier/);
  });
});
