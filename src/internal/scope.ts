import { resolveDotSegments } from "h3";

// Canonicalize a request pathname for route-rule matching and scope checks.
//
// Delegates to h3's `resolveDotSegments`, which decodes `%2f`/`%5c` separators
// (`decodeSlashes`) and `%2e` dot segments — at any `%25`-nesting depth — then
// resolves the revealed `.`/`..` without escaping above root. Other encodings
// (`%20`, non-ASCII, `%3A`, …) stay opaque, so the result keeps the same
// representation as the un-decoded `event.url.pathname` and matches rules
// consistently.
//
// `decodeSlashes` is required here (unlike routing/dispatch): the result gates
// auth and feeds proxy/redirect scope checks, where a downstream decodes
// `%2f` → `/` and would otherwise let an encoded separator dodge a narrower rule
// (e.g. a `basicAuth` gate) or escape a `/**` scope that the served path would
// match. Never use the result for routing/dispatch.
export function canonicalPath(pathname: string): string {
  return resolveDotSegments(pathname, { decodeSlashes: true });
}

// A run of two-or-more consecutive path separators, counting every form h3's
// `resolveDotSegments` decodes to `/`: literal `/`/`\` and `%2f`/`%5c` at any
// `%25`-nesting depth (mirrors h3's `ENCODED_SEP_RE`). Matching runs — not
// single separators — lets us collapse the empty segments a slash-merging
// downstream would drop, without disturbing opaque single `%2f`s.
const SEPARATOR_RUN_RE = /(?:[/\\]|%(?:25)*(?:2f|5c))(?:[/\\]|%(?:25)*(?:2f|5c))+/gi;

/**
 * Canonical form under a slash-merging downstream: collapse separator runs (the
 * empty `//` segments h3's canonical form preserves) *before* resolving dot
 * segments, so a `..` adjacent to an encoded separator is no longer shielded by
 * an empty segment. Returns `undefined` when collapsing is a no-op (no separator
 * run to merge) — the caller already has the plain canonical reading.
 *
 * This is the matcher's counterpart to the second interpretation `isPathInScope`
 * uses for scope: a downstream that decodes `%2f` then merges slashes (nginx
 * `merge_slashes`, or any backend that normalizes) resolves the empty segments,
 * so a narrower rule (e.g. a `basicAuth` gate) guarding that resolved path must
 * still match. Never use the result for routing/dispatch or forwarding.
 */
export function mergedCanonicalPath(pathname: string): string | undefined {
  const merged = pathname.replace(SEPARATOR_RUN_RE, "/");
  return merged === pathname ? undefined : canonicalPath(merged);
}

/**
 * Whether `pathname` stays within `base` once canonicalized. Security-critical:
 * an encoded traversal like `..%2f` must not let a request escape a `/**`
 * proxy/redirect scope once the downstream decodes it. An empty base allows
 * everything.
 *
 * Checks two interpretations and fails closed if *either* escapes:
 *  1. h3's canonical form, which preserves empty `//` segments (RFC/WHATWG).
 *  2. The same with separator runs collapsed — the view a slash-merging
 *     downstream (e.g. nginx `merge_slashes`) resolves.
 *
 * These diverge when a `..` sits adjacent to an empty segment: h3 lets the empty
 * shield the `..` (stays in scope), but a downstream that drops the empty first
 * lets the `..` traverse out. Collapsing separator runs is the maximal-traversal
 * reading, so requiring it in scope too closes that gap.
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
