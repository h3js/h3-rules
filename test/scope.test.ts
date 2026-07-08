import { describe, expect, it } from "vitest";
import { canonicalPath, isPathInScope } from "../src/internal/scope.ts";

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
