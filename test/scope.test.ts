import { describe, expect, it } from "vitest";
import {
  canonicalPath,
  isPathInScope,
  isTriviallyCanonical,
  mergedCanonicalPath,
} from "../src/internal/scope.ts";

// An encoded traversal like `..%2f` must
// not let a request escape a `/**` proxy/redirect scope once the downstream
// decodes it. (Ported verbatim from Nitro test/unit/route-rules.test.ts.)
describe("isPathInScope", () => {
  it("accepts in-scope paths", () => {
    expect(isPathInScope("/api/orders/list.json", "/api/orders")).toBe(true);
    expect(isPathInScope("/api/orders/", "/api/orders")).toBe(true);
    expect(isPathInScope("/api/orders", "/api/orders")).toBe(true);
  });

  it("rejects encoded slash traversal (%2f)", () => {
    expect(isPathInScope("/api/orders/..%2fadmin%2fconfig.json", "/api/orders")).toBe(false);
    expect(isPathInScope("/api/orders/..%2Fadmin", "/api/orders")).toBe(false);
  });

  it("rejects encoded backslash traversal (%5c / %5C)", () => {
    expect(isPathInScope("/api/orders/..%5cadmin", "/api/orders")).toBe(false);
    expect(isPathInScope("/api/orders/..%5Cadmin", "/api/orders")).toBe(false);
  });

  it("rejects uppercase-encoded dot-segments (%2E%2E)", () => {
    expect(isPathInScope("/api/orders/%2E%2E%2Fadmin", "/api/orders")).toBe(false);
  });

  it("rejects double-encoded traversal (%252e / %252f)", () => {
    // `resolveDotSegments` decodes separators/dots at any `%25`-nesting depth —
    // exactly what a downstream that percent-decodes more than once would see.
    expect(isPathInScope("/api/orders/..%252fadmin", "/api/orders")).toBe(false);
    expect(isPathInScope("/api/orders/%252e%252e%252fadmin", "/api/orders")).toBe(false);
  });

  it("rejects literal traversal above scope", () => {
    expect(isPathInScope("/api/orders/../admin", "/api/orders")).toBe(false);
    expect(isPathInScope("/api/orders/../../etc/passwd", "/api/orders")).toBe(false);
  });

  it("rejects traversal landing exactly on the scope's parent", () => {
    expect(isPathInScope("/api/orders/..", "/api/orders")).toBe(false);
    expect(isPathInScope("/api/orders/%2e%2e", "/api/orders")).toBe(false);
  });

  it("keeps traversal confined within scope", () => {
    expect(isPathInScope("/api/orders/foo/../bar", "/api/orders")).toBe(true);
    expect(isPathInScope("/api/orders/foo%2f..%2fbar", "/api/orders")).toBe(true);
  });

  it("rejects a mid-path doubled-slash that escapes on a slash-merging downstream", () => {
    // h3's canonicalization preserves the empty `//` segment, so a following
    // `..` is shielded and the path looks in-scope. But a downstream that merges
    // consecutive slashes (nginx `merge_slashes`) drops the empty first, letting
    // the `..` traverse out. `isPathInScope` collapses separator runs to a single
    // `/` — the *maximal-traversal* reading, equivalent to a downstream that
    // decodes then merges then resolves — so this must fail closed in every
    // equivalent shape.
    expect(isPathInScope("/api/orders/a//..%2f..%2fc", "/api/orders")).toBe(false);
    expect(isPathInScope("/api/orders/a//b//..%2f..%2f..%2fsecret", "/api/orders")).toBe(false);
    expect(isPathInScope("/api/orders/a//..%5c..%5cc", "/api/orders")).toBe(false); // backslash
    expect(isPathInScope("/api/orders/a//..%252f..%252fc", "/api/orders")).toBe(false); // double-enc
    expect(isPathInScope("/api/orders/a%2f%2f..%2f..%2fc", "/api/orders")).toBe(false); // encoded empty
  });

  it("still allows empty segments that resolve within scope", () => {
    // A doubled slash is only a problem when it shields a traversal; a benign
    // `//` whose merged form stays in scope must not be rejected.
    expect(isPathInScope("/api/orders/a//b%2f..%2f..%2fc", "/api/orders")).toBe(true);
    expect(isPathInScope("/api/orders//list.json", "/api/orders")).toBe(true);
  });

  it("does not confuse sibling prefix with scope", () => {
    expect(isPathInScope("/api/ordersX/list.json", "/api/orders")).toBe(false);
  });

  it("allows anything for an empty base (catch-all /**)", () => {
    expect(isPathInScope("/anything/here", "")).toBe(true);
  });
});

// Used to match route rules: encoded separators must be decoded so a request
// cannot dodge a narrower rule (e.g. a `basicAuth` gate) that a broader rule
// would still serve once the downstream decodes them back to `/`.
describe("canonicalPath", () => {
  it("decodes encoded path separators", () => {
    expect(canonicalPath("/app/admin%2fpanel")).toBe("/app/admin/panel");
    expect(canonicalPath("/app/admin%2Fpanel")).toBe("/app/admin/panel");
    expect(canonicalPath("/app/admin%5cpanel")).toBe("/app/admin/panel");
    expect(canonicalPath("/app/admin%5Cpanel")).toBe("/app/admin/panel");
  });

  it("resolves traversal revealed by decoding", () => {
    expect(canonicalPath("/api/orders/..%2fadmin")).toBe("/api/admin");
  });

  it("resolves double-encoded traversal (%252f)", () => {
    expect(canonicalPath("/api/orders/..%252fadmin")).toBe("/api/admin");
  });

  it("collapses a leading `//` (never protocol-relative)", () => {
    expect(canonicalPath("//evil.com")).toBe("/evil.com");
  });

  it("passes malformed percent sequences through opaquely (no throw)", () => {
    expect(canonicalPath("/a%2")).toBe("/a%2");
    expect(canonicalPath("/a%zz/b")).toBe("/a%zz/b");
  });

  it("resolves plain dot segments", () => {
    expect(canonicalPath("/a/./b")).toBe("/a/b");
    expect(canonicalPath("/a/b/../c")).toBe("/a/c");
  });

  it("leaves a plain path untouched", () => {
    expect(canonicalPath("/app/admin/panel")).toBe("/app/admin/panel");
  });

  it("keeps a dotted filename on the fast path", () => {
    // A `.` inside a segment cannot change the path, so an asset request (the
    // hot path) must not pay for the split/normalize/join.
    expect(canonicalPath("/assets/app.1a2b.js")).toBe("/assets/app.1a2b.js");
  });

  it("keeps %20 / non-ASCII encodings in sync with event.url.pathname", () => {
    // srvx keeps `%20` and percent-encoded non-ASCII opaque in
    // `event.url.pathname` (it is not `decodeURI`-d), so canonicalization must
    // leave them encoded too — decoding would desync the canonical path from
    // how route rules are matched.
    expect(canonicalPath("/foo%20bar")).toBe("/foo%20bar");
    expect(canonicalPath("/caf%C3%A9/x")).toBe("/caf%C3%A9/x");
  });

  it("keeps non-separator reserved encodings opaque", () => {
    expect(canonicalPath("/a%3Ab")).toBe("/a%3Ab");
  });
});

// The matcher / isPathInScope fast path: `isTriviallyCanonical(p)` must imply
// that BOTH alternate readings are no-ops — otherwise the fast path would skip
// a canonicalization step and an encoded path could dodge a rule (an auth/scope
// bypass, not a perf bug). h3 pins the predicate against `resolveDotSegments`
// identity; this suite pins the derivation this package layers on top.
describe("isTriviallyCanonical", () => {
  it("accepts common request paths", () => {
    expect(isTriviallyCanonical("/")).toBe(true);
    expect(isTriviallyCanonical("/api/users/123")).toBe(true);
    expect(isTriviallyCanonical("/assets/app.1a2b.js")).toBe(true);
    expect(isTriviallyCanonical("/.well-known/security.txt")).toBe(true);
    expect(isTriviallyCanonical("/foo%20bar/a%3Ab")).toBe(true);
  });

  it("rejects every path with an alternate reading", () => {
    expect(isTriviallyCanonical("/a/../b")).toBe(false);
    expect(isTriviallyCanonical("/a/%2e%2e/b")).toBe(false);
    expect(isTriviallyCanonical("/app/admin%2fpanel")).toBe(false);
    expect(isTriviallyCanonical("/app/admin%5Cpanel")).toBe(false);
    expect(isTriviallyCanonical("/a%252fb")).toBe(false);
    expect(isTriviallyCanonical("/a\\b")).toBe(false);
    expect(isTriviallyCanonical("/a//b")).toBe(false);
    expect(isTriviallyCanonical("//evil.com")).toBe(false);
  });

  it("implies canonical identity AND no merged reading (seeded fuzz)", () => {
    const FRAGMENTS = [
      "/",
      "//",
      "\\",
      ".",
      "..",
      "...",
      "%2e",
      "%2E",
      "%252e",
      "%2e%2e",
      "%2f",
      "%5C",
      "%252f",
      "a",
      "app.js",
      ".well-known",
      "..b",
      "a%2eb",
      "%20",
      "%25",
      "%",
      "admin",
      "%2e.",
      ".%2e",
      "%25%32%66",
    ];
    let seed = 4321;
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff) / 0x7f_ff_ff_ff;
    for (let i = 0; i < 50_000; i++) {
      let path = rand() < 0.9 ? "/" : "";
      const length = 1 + Math.floor(rand() * 6);
      for (let j = 0; j < length; j++) {
        path += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
      }
      if (isTriviallyCanonical(path)) {
        if (canonicalPath(path) !== path || mergedCanonicalPath(path) !== undefined) {
          expect.fail(
            `isTriviallyCanonical(${JSON.stringify(path)}) but an alternate reading exists`,
          );
        }
      } else {
        // Not required for safety (false negatives only cost a slow-path
        // call), but the strict predicate should never be lazier than the two
        // readings it guards — a divergence here means the derivation comment
        // in scope.ts is stale.
        if (canonicalPath(path) === path && mergedCanonicalPath(path) === undefined) {
          expect.fail(
            `isTriviallyCanonical(${JSON.stringify(path)}) is false but both readings are no-ops`,
          );
        }
      }
    }
  });
});
