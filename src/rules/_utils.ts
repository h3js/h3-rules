import { HTTPError } from "h3";
import type { H3Event } from "h3";
import { joinURL, parseURL, withoutBase } from "ufo";
import { isPathInScope } from "../internal/scope.ts";
import type { ProxyRuleOptions, RedirectRuleOptions } from "../types.ts";

/**
 * Per-request resolver for a `redirect`/`proxy` rule target, produced once per
 * handler by {@link prepareRuleTarget}.
 */
export type RuleTargetResolver = (event: H3Event) => string;

/**
 * Prepare the target resolver for a `redirect`/`proxy` rule, or `undefined`
 * when the rule has no target. Everything derived solely from the rule's static
 * options (`to` / `base`) is computed here, once per handler closure; the
 * returned resolver performs only the request-dependent work (scope checks,
 * query forwarding).
 *
 * For `/**` wildcard targets, the resolver forwards `event.url.pathname`:
 * encoded separators (`%2f`/`%5c`) stay opaque, so the target receives the
 * original separators and resolves the resource the client requested — like
 * nginx `proxy_pass $request_uri`, not the path-decoding `proxy_pass <uri>/`
 * form. The scope check canonicalizes (decodes `%2f`/`%5c`, resolves `..`) to
 * reject traversal that only surfaces once the downstream decodes those
 * separators.
 *
 * For non-wildcard targets, the raw request query string is forwarded with
 * full fidelity (duplicate keys, ordering, and percent-encoding preserved):
 * the target's own baked-in query params are kept first, and the request's
 * params are appended after them.
 */
export function prepareRuleTarget(
  options: RedirectRuleOptions | ProxyRuleOptions | undefined,
): RuleTargetResolver | undefined {
  const target = options?.to;
  if (!target) {
    return;
  }

  if (target.endsWith("/**")) {
    const baseTarget = target.slice(0, -3);
    const base = options?.base;
    // The target's own base path (`to` minus `/**`), used to scope-check the
    // final forwarded target below.
    let baseTargetPath = parseURL(baseTarget).pathname;
    if (baseTargetPath.endsWith("/")) {
      baseTargetPath = baseTargetPath.slice(0, -1);
    }
    return (event) => {
      let targetPath = event.url.pathname + event.url.search;
      if (base) {
        // The scope check canonicalizes; the forwarded path stays raw. When the
        // raw path does not literally sit under `base` (encoded separator inside
        // the base region, or a canonical-only match via dot segments), the base
        // cannot be faithfully stripped from the raw path — fail closed instead
        // of forwarding it unstripped.
        const rawPath = event.url.pathname;
        if (
          !isPathInScope(rawPath, base) ||
          !(rawPath === base || rawPath.startsWith(base + "/"))
        ) {
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
      if (!isPathInScope(parseURL(resolved).pathname, baseTargetPath)) {
        throw new HTTPError({ status: 400 });
      }
      return resolved;
    };
  }

  // Non-wildcard target: append the raw request search string (never an
  // object round-trip through URLSearchParams, which would collapse duplicate
  // keys and re-encode values). Split a `#fragment` off the static target so
  // appended params land in the query, not the fragment.
  const hashIndex = target.indexOf("#");
  const targetBase = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const targetHash = hashIndex === -1 ? "" : target.slice(hashIndex);
  const joiner = targetBase.includes("?")
    ? targetBase.endsWith("?") || targetBase.endsWith("&")
      ? ""
      : "&"
    : "?";
  return (event) => {
    const search = event.url.search;
    if (!search) {
      return target;
    }
    return targetBase + joiner + search.slice(1) + targetHash;
  };
}

/**
 * Resolve the target URL for a `redirect`/`proxy` rule, or `undefined` when the
 * rule has no target. One-shot convenience over {@link prepareRuleTarget} —
 * rule handlers prepare once per closure instead.
 */
export function resolveRuleTarget(
  event: H3Event,
  options: RedirectRuleOptions | ProxyRuleOptions | undefined,
): string | undefined {
  return prepareRuleTarget(options)?.(event);
}
