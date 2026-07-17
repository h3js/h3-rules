import { resolveDotSegments } from "h3";

// Second decode pass over h3's once-decoded pathname (see .agents/SECURITY.md for
// the full input contract, pinned by `test/h3-decode.test.ts`): h3 already
// resolves dot-segment traversals and leaves only `%2f` opaque, so this closes
// that one residual gap by decoding it too. Other encodings round-trip unchanged.
// Feeds rule matching / auth / scope checks — never use for routing/dispatch.
export function canonicalPath(pathname: string): string {
  return resolveDotSegments(pathname, { decodeSlashes: true });
}

// A run of two-or-more consecutive path separators, counting every form h3's
// `resolveDotSegments` decodes to `/` (mirrors h3's `ENCODED_SEP_RE`) — matching
// runs, not single separators, collapses the empty segments a slash-merging
// downstream would drop without disturbing an opaque single `%2f`.
//
// The `%25`-nesting (`%252f` …) is defense-in-depth for a double-decoding
// downstream (proxy decodes, backend decodes again) — not purely fail-closed,
// since the dual-path union may override with a narrower, weaker rule a
// double-decoding downstream would actually resolve to. Kept because it must
// stay consistent with `canonicalPath`'s own `ENCODED_SEP_RE`-based decoding;
// tightening it is an upstream h3 decision, not a local one. See .agents/SECURITY.md.
const SEPARATOR_RUN_RE = /(?:[/\\]|%(?:25)*(?:2f|5c))(?:[/\\]|%(?:25)*(?:2f|5c))+/gi;

/**
 * Canonical form under a slash-merging downstream (e.g. nginx `merge_slashes`):
 * collapses separator runs before resolving dot segments, so a `..` no longer
 * shielded by an empty `//` segment is caught. Returns `undefined` when collapsing
 * is a no-op — the caller already has the plain canonical reading. Never use the
 * result for routing/dispatch or forwarding.
 */
export function mergedCanonicalPath(pathname: string): string | undefined {
  const merged = pathname.replace(SEPARATOR_RUN_RE, "/");
  return merged === pathname ? undefined : canonicalPath(merged);
}

/**
 * Whether `pathname` stays within `base` once canonicalized. Security-critical:
 * an encoded traversal like `..%2f` must not escape a `/**` proxy/redirect scope
 * once a downstream decodes it. Empty base allows everything.
 *
 * Fails closed under two interpretations — h3's canonical form (preserves empty
 * `//` segments) and the separator-run-collapsed form (the slash-merging-downstream
 * view) — since a `..` next to an empty segment is in-scope under one but a
 * traversal under the other.
 */
export function isPathInScope(pathname: string, base: string): boolean {
  if (!isCanonicalInScope(canonicalPath(pathname), base)) {
    return false;
  }
  const mergedCanonical = mergedCanonicalPath(pathname);
  return mergedCanonical === undefined || isCanonicalInScope(mergedCanonical, base);
}

function isCanonicalInScope(canonical: string, base: string): boolean {
  return !base || canonical === base || canonical.startsWith(base + "/");
}
