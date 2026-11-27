import { ExtensionError } from './errors.js'
import { API_VERSION } from './version.js'
export type Semver = { major: number; minor: number; patch: number; pre?: string }
export function parseSemver(version: string): Semver | null {
  if (typeof version !== 'string') return null
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(
    version,
  )
  if (
    !m ||
    m[4]?.split('.').some((p) => !p || (/^\d+$/.test(p) && p.length > 1 && p.startsWith('0'))) ||
    m[5]?.split('.').some((p) => !p)
  )
    return null
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return {
    major: major as number,
    minor: minor as number,
    patch: patch as number,
    ...(m[4] ? { pre: m[4] } : {}),
  }
}
const tuple = (a: Semver, b: Semver) => a.major - b.major || a.minor - b.minor || a.patch - b.patch
function cmp(a: Semver, b: Semver): number {
  const delta = tuple(a, b)
  if (delta || a.pre === b.pre) return delta
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  const left = a.pre.split('.'),
    right = b.pre.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i],
      y = right[i]
    if (x === y) continue
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y)
    if (xn !== yn) return xn ? -1 : 1
    if (xn && x.length !== y.length) return x.length - y.length
    return x < y ? -1 : 1
  }
  return 0
}
function admits(op: string, base: Semver, v: Semver, partial: boolean): boolean {
  const delta = cmp(v, base)
  switch (op) {
    case '=':
      return delta === 0
    case '>':
      return delta > 0
    case '>=':
      return delta >= 0
    case '<':
      return delta < 0
    case '<=':
      return delta <= 0
    case '~':
      return delta >= 0 && v.major === base.major && v.minor === base.minor
    case '^':
      return (
        delta >= 0 &&
        v.major === base.major &&
        (base.major > 0 || (v.minor === base.minor && (base.minor > 0 || partial || v.patch === base.patch)))
      )
    default:
      return false
  }
}
/** Strict supported range subset: wildcard, exact, x-ranges and whitespace comparator sets.
 * Only the unqualified wildcard opts into every prerelease. Other sets follow npm's same-tuple
 * prerelease opt-in; build metadata never changes precedence. Unsupported syntax fails closed.
 */
export function evaluateSemverRange(
  range: string,
  version: Semver | null,
): 'unsupported' | 'unavailable' | 'match' | 'no-match' {
  const normalized = typeof range === 'string' ? range.trim() : ''
  if (!normalized) return 'unsupported'
  let matches = true
  let admitsPrerelease = version?.pre === undefined || normalized === '*'
  for (const token of normalized.split(/\s+/)) {
    if (token === '*') continue
    const wild = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?\.(x|\*)$/.exec(token)
    if (wild) {
      const major = Number(wild[1])
      const minor = wild[2] === undefined ? undefined : Number(wild[2])
      if (!Number.isSafeInteger(major) || (minor !== undefined && !Number.isSafeInteger(minor)))
        return 'unsupported'
      if (version && (version.major !== major || (minor !== undefined && version.minor !== minor)))
        matches = false
      continue
    }
    const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token)
    if (!m) return 'unsupported'
    const op = m[1] ?? '='
    const body = m[2] ?? ''
    const partial = op === '^' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(body)
    const base = parseSemver(partial ? `${body}.0` : body)
    if (!base) return 'unsupported'
    if (version) {
      if (matches && !admits(op, base, version, partial)) matches = false
      if (!admitsPrerelease && base.pre !== undefined && tuple(version, base) === 0) admitsPrerelease = true
    }
  }
  if (!version) return 'unavailable'
  return matches && admitsPrerelease ? 'match' : 'no-match'
}

export function satisfiesApiRange(range: string, version: string = API_VERSION): boolean {
  const installed = parseSemver(version)
  return installed !== null && evaluateSemverRange(range, installed) === 'match'
}
export function checkApiRange(
  manifest: { id: string; apiRange: string },
  version = API_VERSION as string,
): void {
  if (!satisfiesApiRange(manifest.apiRange, version))
    throw new ExtensionError('E_API_RANGE', 'extension API version is incompatible', {
      extId: manifest.id,
      detail: { apiRange: manifest.apiRange, apiVersion: version },
    })
}
