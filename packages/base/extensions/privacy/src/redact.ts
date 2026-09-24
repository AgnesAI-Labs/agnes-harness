export type RedactRules = {
  secrets: boolean
  paths: { home?: string; workspaceRoot?: string; username?: string } | false
  pii: boolean
  custom: Array<{ pattern: string; flags?: string; replace: string }>
}

export const DEFAULT_RULES: RedactRules = {
  secrets: true,
  paths: {},
  pii: true,
  custom: [],
}

type HitMap = Record<string, number>

const SIMPLE_SECRETS: ReadonlyArray<readonly [string, RegExp]> = [
  ['aws', /AKIA[0-9A-Z]{16}/g],
  ['github', /gh[pousr]_[A-Za-z0-9]{36,}/g],
  ['jwt', /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g],
  ['sk', /sk-[A-Za-z0-9_-]{16,}/g],
]

const PII: ReadonlyArray<readonly [string, RegExp]> = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['phone', /(?<!\d)1[3-9]\d{9}(?!\d)/g],
  ['id', /(?<!\d)\d{17}[\dXx](?!\d)/g],
]

const JSON_SECRET_DOUBLE = /("secret:\/\/[^"\s]+"\s*:\s*")([^"]+)(")/g
const JSON_SECRET_SINGLE = /('secret:\/\/[^'\s]+'\s*:\s*')([^']+)(')/g
const ASSIGNED_SECRET = /(secret:\/\/[^\s"'=:]+\s*=\s*)("[^"]+"|'[^']+'|[^\s,;}]+)/g

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function addHits(hits: HitMap, kind: string, count: number): void {
  if (count > 0) hits[kind] = (hits[kind] ?? 0) + count
}

function replaceCount(
  text: string,
  pattern: RegExp,
  replacement: (...match: string[]) => string,
): { text: string; count: number } {
  let count = 0
  pattern.lastIndex = 0
  const result = text.replace(pattern, (...args: unknown[]) => {
    count++
    const captures = args.slice(0, -2) as string[]
    return replacement(...captures)
  })
  return { text: result, count }
}

function redactSecretReferences(text: string): { text: string; count: number } {
  let out = text
  let count = 0
  for (const pattern of [JSON_SECRET_DOUBLE, JSON_SECRET_SINGLE]) {
    const result = replaceCount(out, pattern, (_whole, before, _value, after) => {
      return `${before}[REDACTED:secret]${after}`
    })
    out = result.text
    count += result.count
  }
  const assigned = replaceCount(out, ASSIGNED_SECRET, (_whole, before, value) => {
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : ''
    return `${before}${quote}[REDACTED:secret]${quote}`
  })
  return { text: assigned.text, count: count + assigned.count }
}

function replaceLiteralPath(
  text: string,
  value: string,
  replacement: string,
): { text: string; count: number } {
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
  const normalized = value.length > 1 ? value.replace(windows ? /[\\/]+$/ : /\/+$/, '') : value
  if (!normalized || normalized === '/') return { text, count: 0 }
  const source = windows
    ? normalized.split(/[\\/]/).map(escapeRegExp).join('(?:\\\\\\\\|\\\\|/)')
    : escapeRegExp(normalized)
  const boundary = windows ? '(?=$|[\\\\/\\s"\',;:)])' : '(?=$|/)'
  return replaceCount(text, new RegExp(`${source}${boundary}`, windows ? 'gi' : 'g'), () => replacement)
}

/** Applies the fixed privacy waterfall: secrets, paths, PII, then caller-supplied rules. */
export function redactText(text: string, rules: RedactRules): { text: string; hits: HitMap } {
  const hits: HitMap = {}
  let out = text

  if (rules.secrets) {
    const references = redactSecretReferences(out)
    out = references.text
    addHits(hits, 'secret', references.count)
    for (const [kind, pattern] of SIMPLE_SECRETS) {
      const result = replaceCount(out, pattern, () => `[REDACTED:${kind}]`)
      out = result.text
      addHits(hits, kind, result.count)
    }
  }

  if (rules.paths) {
    const paths = rules.paths
    if (paths.workspaceRoot) {
      const result = replaceLiteralPath(out, paths.workspaceRoot, '<workspace>')
      out = result.text
      addHits(hits, 'path:workspace', result.count)
    }
    if (paths.home) {
      const result = replaceLiteralPath(out, paths.home, '~')
      out = result.text
      addHits(hits, 'path:home', result.count)
    }
    if (paths.username) {
      const pattern = new RegExp(`/(?:Users|home)/${escapeRegExp(paths.username)}(?=$|/)`, 'g')
      const result = replaceCount(out, pattern, () => '~')
      out = result.text
      addHits(hits, 'path:username', result.count)
    }
  }

  if (rules.pii) {
    for (const [kind, pattern] of PII) {
      const result = replaceCount(out, pattern, () => `[REDACTED:${kind}]`)
      out = result.text
      addHits(hits, kind, result.count)
    }
  }

  for (const custom of rules.custom) {
    const flags = custom.flags?.includes('g') ? custom.flags : `${custom.flags ?? ''}g`
    const pattern = new RegExp(custom.pattern, flags)
    const result = replaceCount(out, pattern, () => custom.replace)
    out = result.text
    addHits(hits, `custom:${custom.pattern}`, result.count)
  }

  return { text: out, hits }
}

/** Returns a redacted JSON-shaped copy. Object keys are identifiers and deliberately stay unchanged. */
export function redact<T>(value: T, rules: RedactRules): T {
  if (typeof value === 'string') return redactText(value, rules).text as T
  if (Array.isArray(value)) return value.map((item) => redact(item, rules)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redact(item, rules)]),
    ) as T
  }
  return value
}
