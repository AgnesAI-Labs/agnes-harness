import { parseSemver } from '@agnes/extension-api'
import { HostError } from '../errors.js'

const radix = BigInt(Number.MAX_SAFE_INTEGER) + 1n,
  maximum = radix ** 3n - 1n
const value = (major: bigint, minor: bigint, patch: bigint) => major * radix ** 2n + minor * radix + patch
function invalid(): never {
  throw new HostError('E_API_RANGE', 'deployment service range is invalid or empty')
}
/** The existing API range grammar over non-prerelease, safe-integer version triples. */
function interval(range: string): [bigint, bigint] {
  if (typeof range !== 'string' || !range.trim() || range.length > 64) invalid()
  let low = 0n,
    high = maximum
  for (const token of range.trim().split(/\s+/)) {
    if (token === '*') continue
    const wild = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?\.(x|\*)$/.exec(token)
    if (wild) {
      const major = BigInt(wild[1] ?? ''),
        minor = wild[2] === undefined ? 0n : BigInt(wild[2])
      if (major >= radix || minor >= radix) invalid()
      low = low > value(major, minor, 0n) ? low : value(major, minor, 0n)
      const end = wild[2] === undefined ? value(major + 1n, 0n, 0n) - 1n : value(major, minor + 1n, 0n) - 1n
      high = high < end ? high : end
      continue
    }
    const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token)
    if (!match) invalid()
    const op = match[1] ?? '=',
      body = match[2] ?? '',
      partial = op === '^' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(body)
    const parsed = parseSemver(partial ? `${body}.0` : body)
    if (!parsed || parsed.pre !== undefined) invalid()
    const major = BigInt(parsed.major),
      minor = BigInt(parsed.minor),
      patch = BigInt(parsed.patch),
      start = value(major, minor, patch)
    let lo = 0n,
      hi = maximum
    if (op === '=' || op === '>=') lo = start
    if (op === '=' || op === '<=') hi = start
    if (op === '>') lo = start + 1n
    if (op === '<') hi = start - 1n
    if (op === '^' || op === '~') {
      lo = start
      hi =
        op === '^' && major > 0n
          ? value(major + 1n, 0n, 0n) - 1n
          : op === '~' || minor > 0n || partial
            ? value(major, minor + 1n, 0n) - 1n
            : start
    }
    low = low > lo ? low : lo
    high = high < hi ? high : hi
  }
  if (low > high) invalid()
  return [low, high]
}
export function rangeNarrows(requested: string, ceiling: string): boolean {
  const [lo, hi] = interval(requested),
    [min, max] = interval(ceiling)
  return lo >= min && hi <= max
}
