import type * as node from '@agnes/core-common/request/sha256-node'
import type * as portable from '@agnes/core-common/request/sha256-portable'
import { jcsWrite } from '@agnes/protocol'

/** Linear congruential generator in [0, 1): the same seed always yields the same sequence. */
export function random(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Deterministic generator: the same seed always yields the same values, so a failure reproduces. */
export function* values(seed: number): Generator<unknown> {
  const next = random(seed)
  const pool = ['', 'a', 'é', '你好', '😀', ' ', '"\\\n\t\u000f', 'x'.repeat(70_000), '𝄞'.repeat(3)]
  const str = (): string => {
    let t = ''
    const n = Math.floor(next() * 6)
    for (let i = 0; i < n; i++) t += pool[Math.floor(next() * pool.length)]
    return t
  }
  const val = (depth: number): unknown => {
    const r = next()
    if (depth > 6 || r < 0.3) return str()
    if (r < 0.4) return Math.floor(next() * 1e9) / (next() < 0.5 ? 1 : 1000)
    if (r < 0.45) return next() < 0.5
    if (r < 0.5) return null
    if (r < 0.75) return Array.from({ length: Math.floor(next() * 4) }, () => val(depth + 1))
    return Object.fromEntries(Array.from({ length: Math.floor(next() * 4) }, () => [str(), val(depth + 1)]))
  }
  for (;;) yield val(0)
}

/** The canonical digest of `value`, streamed through one implementation's incremental hash. */
export function digestWith(impl: typeof node | typeof portable, value: unknown): string {
  const hash = impl.createSha256()
  jcsWrite(value, (chunk) => hash.update(chunk))
  return hash.digestHex()
}
