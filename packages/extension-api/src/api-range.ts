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
const cmp = (a: Semver, b: Semver) => a.major - b.major || a.minor - b.minor || a.patch - b.patch
function admits(token: string, v: Semver): boolean {
  if (token === '*') return true
  const wild = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?\.(x|\*)$/.exec(token)
  if (wild) return v.major === Number(wild[1]) && (wild[2] === undefined || v.minor === Number(wild[2]))
  const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token)
  if (!m) return false
  const op = m[1] ?? '=',
    body = m[2] ?? ''
  const partial = op === '^' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(body)
  const base = parseSemver(partial ? `${body}.0` : body)
  if (!base || base.pre !== undefined) return false
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
export function satisfiesApiRange(range: string, version = API_VERSION as string): boolean {
  const v = parseSemver(version)
  if (!v || v.pre !== undefined || typeof range !== 'string' || !range.trim()) return false
  return range
    .trim()
    .split(/\s+/)
    .every((token) => admits(token, v))
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
