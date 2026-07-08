import { withLeadingSlash } from "ufo";

// Recognized HTTP method tokens for the optional `"METHOD /path"` key prefix.
// A key whose first token is not one of these is treated as a plain path.
const HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "CONNECT",
  "TRACE",
]);

const METHOD_KEY_RE = /^([A-Za-z]+)\s+(\/.*)$/;

export interface ParsedRouteKey {
  /** Uppercased HTTP method, or `""` for a method-agnostic (all-methods) rule. */
  method: string;
  /** Path pattern with a guaranteed leading slash. */
  path: string;
}

/**
 * Parse a route-rule key into `{ method, path }`.
 *
 * - `"GET /api/**"` → `{ method: "GET", path: "/api/**" }`
 * - `"/api/**"`     → `{ method: "", path: "/api/**" }`
 *
 * The method token is optional; only a recognized HTTP method (matched
 * case-insensitively, then uppercased) followed by a single space and a
 * slash-prefixed path is treated as method-scoped.
 * Everything else is a plain path key. `withLeadingSlash` is applied to the path
 * part only.
 */
export function parseRouteKey(key: string): ParsedRouteKey {
  const match = METHOD_KEY_RE.exec(key);
  if (match) {
    const method = match[1]!.toUpperCase();
    if (HTTP_METHODS.has(method)) {
      return { method, path: withLeadingSlash(match[2]!) };
    }
  }
  return { method: "", path: withLeadingSlash(key) };
}

/** Re-serialize a parsed key into its canonical `"METHOD /path"` / `"/path"` form. */
export function formatRouteKey(method: string, path: string): string {
  return method ? `${method} ${path}` : path;
}
