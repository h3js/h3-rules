const JS_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Handler references bind as `<ns>$<name>` identifiers in generated code; a
 * non-identifier would otherwise surface as a parse error in the consumer's
 * generated module, far from the misconfiguration. Used to validate every
 * binding name the compiler emits (`runtimeRules` keys, per-rule `export`
 * names, `handlersImportName`, and the matcher export name).
 */
export function assertHandlerBinding(name: string, what: string): void {
  if (!JS_IDENTIFIER_RE.test(name)) {
    throw new Error(
      `[h3-rules] compiler: ${what} \`${name}\` is not a valid JS identifier — it is used as a binding in generated code`,
    );
  }
}
