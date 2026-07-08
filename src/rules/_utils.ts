import { HTTPError } from "h3";
import type { H3Event } from "h3";
import { joinURL, parseURL, withQuery, withoutBase } from "ufo";
import { isPathInScope } from "../internal/scope.ts";
import type { ProxyRuleOptions, RedirectRuleOptions } from "../types.ts";

/**
 * Resolve the target URL for a `redirect`/`proxy` rule, or `undefined` when the
 * rule has no target.
 *
 * For `/**` wildcard targets, forwards `event.url.pathname`: encoded separators
 * (`%2f`/`%5c`) stay opaque, so the target receives the original separators and
 * resolves the resource the client requested — like nginx `proxy_pass
 * $request_uri`, not the path-decoding `proxy_pass <uri>/` form. The scope check
 * canonicalizes (decodes `%2f`/`%5c`, resolves `..`) to reject traversal that
 * only surfaces once the downstream decodes those separators.
 */
export function resolveRuleTarget(
  event: H3Event,
  options: RedirectRuleOptions | ProxyRuleOptions | undefined,
): string | undefined {
  const target = options?.to;
  if (!target) {
    return;
  }
  if (target.endsWith("/**")) {
    const baseTarget = target.slice(0, -3);
    let targetPath = event.url.pathname + event.url.search;
    const base = options?.base;
    if (base) {
      // The scope check canonicalizes; the forwarded path stays raw. When the
      // raw path does not literally sit under `base` (encoded separator inside
      // the base region, or a canonical-only match via dot segments), the base
      // cannot be faithfully stripped from the raw path — fail closed instead
      // of forwarding it unstripped.
      const rawPath = event.url.pathname;
      if (!isPathInScope(rawPath, base) || !(rawPath === base || rawPath.startsWith(base + "/"))) {
        throw new HTTPError({ status: 400 });
      }
      targetPath = withoutBase(targetPath, base);
    } else if (targetPath.startsWith("//")) {
      targetPath = targetPath.replace(/^\/+/, "/");
    }
    const resolved = joinURL(baseTarget, targetPath);
    // Enforce scope on the *final* forwarded target, not just the incoming
    // path. Repeated/leading slashes or `/./` segments can make the incoming
    // path canonicalize inside `base` (an empty segment absorbing a `..`), yet
    // once the base is stripped and the remainder rejoined — `joinURL`
    // collapses those empty segments — the `..%2f` resolves outside the
    // target's own base the moment a downstream decodes the separator. Checking
    // the bytes we actually forward closes that pre-vs-post-join divergence.
    let baseTargetPath = parseURL(baseTarget).pathname;
    if (baseTargetPath.endsWith("/")) {
      baseTargetPath = baseTargetPath.slice(0, -1);
    }
    if (!isPathInScope(parseURL(resolved).pathname, baseTargetPath)) {
      throw new HTTPError({ status: 400 });
    }
    return resolved;
  }
  if (event.url.search) {
    return withQuery(target, Object.fromEntries(event.url.searchParams));
  }
  return target;
}
