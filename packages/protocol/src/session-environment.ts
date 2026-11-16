/**
 * A session's own environment: directories put first on its commands' PATH, variables set, and variables removed. It is
 * applied after the platform has reduced a command's environment to its floor, so it can add to that floor but never
 * bring back what the platform leaves out: a variable whose name looks like a credential can be removed, never set.
 * Only the bundled application's client may give a session one (see the daemon's admission).
 */
export type SessionEnvironment = Readonly<{
  pathPrepend?: readonly string[]
  set?: Readonly<Record<string, string>>
  unset?: readonly string[]
}>

/** Bounds of a session environment, in entries and UTF-16 units. */
export const SESSION_ENVIRONMENT_LIMITS = Object.freeze({
  pathEntries: 8,
  variables: 32,
  nameLength: 128,
  valueLength: 4096,
  totalLength: 16384,
})

/** The names a session environment may never set: credentials, which the platform keeps out of every command. */
export const CREDENTIAL_VARIABLE = /KEY|PASSWORD|SECRET|TOKEN/i
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Variables the platform owns: PATH changes only through `pathPrepend`, and the platform's own prefixes not at all. */
const RESERVED = /^(PATH|AGNES_.*|AGH_.*)$/i

const invalid = (reason: string): never => {
  throw new TypeError(`session environment ${reason}`)
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: string): boolean => !/[\0\n\r]/.test(value)

function names(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return invalid(`${field} must be a list`)
  if (value.length > SESSION_ENVIRONMENT_LIMITS.variables)
    invalid(`${field} has more than ${SESSION_ENVIRONMENT_LIMITS.variables} names`)
  for (const name of value) {
    if (typeof name !== 'string' || !NAME.test(name) || name.length > SESSION_ENVIRONMENT_LIMITS.nameLength)
      invalid(`${field} has an invalid variable name`)
    if (RESERVED.test(name)) invalid(`${field} names ${name}, which the platform owns`)
  }
  if (new Set(value).size !== value.length) invalid(`${field} repeats a name`)
  return [...(value as string[])]
}

/**
 * Checks and copies a session environment: at most 8 absolute PATH directories (without a PATH separator), at most 32
 * variables to set and 32 to remove, each name a shell variable name of at most 128 characters, each value at most 4096
 * characters without NUL or line breaks, and 16384 characters in all. PATH, `AGNES_*` and `AGH_*` are refused in both
 * lists, a credential-shaped name (KEY, PASSWORD, SECRET, TOKEN) is refused in `set`, and no name may be both set and
 * removed.
 * @throws TypeError naming what is wrong.
 */
export function parseSessionEnvironment(value: unknown): SessionEnvironment {
  if (!record(value)) return invalid('must be an object')
  const extra = Object.keys(value).filter((key) => !['pathPrepend', 'set', 'unset'].includes(key))
  if (extra.length) invalid(`has unknown fields: ${extra.join(', ')}`)
  if (JSON.stringify(value).length > SESSION_ENVIRONMENT_LIMITS.totalLength)
    invalid(`is longer than ${SESSION_ENVIRONMENT_LIMITS.totalLength} characters`)
  const out: { pathPrepend?: string[]; set?: Record<string, string>; unset?: string[] } = {}
  if (value.pathPrepend !== undefined) {
    const paths = value.pathPrepend
    if (!Array.isArray(paths) || paths.length > SESSION_ENVIRONMENT_LIMITS.pathEntries)
      invalid(`pathPrepend must list at most ${SESSION_ENVIRONMENT_LIMITS.pathEntries} directories`)
    for (const path of paths as unknown[])
      if (
        typeof path !== 'string' ||
        path.length > SESSION_ENVIRONMENT_LIMITS.valueLength ||
        !text(path) ||
        !/^(\/|[A-Za-z]:[\\/])/.test(path) ||
        /[:;]/.test(path.replace(/^[A-Za-z]:/, ''))
      )
        invalid('pathPrepend must hold absolute directories without a PATH separator')
    out.pathPrepend = [...(paths as string[])]
  }
  if (value.set !== undefined) {
    if (!record(value.set)) return invalid('set must be an object')
    const entries = Object.entries(value.set)
    names(
      entries.map(([name]) => name),
      'set',
    )
    for (const [name, entry] of entries) {
      if (CREDENTIAL_VARIABLE.test(name)) invalid(`set names ${name}, which looks like a credential`)
      if (typeof entry !== 'string' || entry.length > SESSION_ENVIRONMENT_LIMITS.valueLength || !text(entry))
        invalid(`set gives ${name} an invalid value`)
    }
    out.set = Object.fromEntries(entries as [string, string][])
  }
  if (value.unset !== undefined) out.unset = names(value.unset, 'unset')
  if (out.unset?.some((name) => out.set && Object.hasOwn(out.set, name)))
    invalid('both sets and removes a variable')
  return Object.freeze({
    ...(out.pathPrepend ? { pathPrepend: Object.freeze(out.pathPrepend) } : {}),
    ...(out.set ? { set: Object.freeze(out.set) } : {}),
    ...(out.unset ? { unset: Object.freeze(out.unset) } : {}),
  })
}
