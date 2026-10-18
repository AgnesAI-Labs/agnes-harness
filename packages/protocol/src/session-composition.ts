/** An ordered selection of already available bundle IDs; never package sources or configuration. */
export function parseSessionBundles(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some(
      (id) =>
        typeof id !== 'string' ||
        !id.trim() ||
        id.length > 512 ||
        Array.from(id).some((character) => {
          const code = character.codePointAt(0) ?? 0
          return code < 32 || code === 127
        }),
    ) ||
    new Set(value).size !== value.length
  )
    throw new TypeError('bundles must be at most 64 unique nonempty bundle IDs')
  return [...value]
}

/** Public agent identity; no inline composition or path grammar. */
export function parseAgentRef(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)#[a-z][a-z0-9.-]*$/.test(
      value,
    )
  )
    throw new TypeError('agent requires package#bundle')
  return value
}
