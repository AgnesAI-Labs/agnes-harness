import type { PreparedEvent } from '@agnes/core'

const ACTOR = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
// Crockford base32 without I, L, O and U, which is the alphabet the id pattern admits.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let n = 0

/** One well-formed ledger row per call, with a fresh id, for every storage test in this package. */
export function ev(type: string, data: unknown, over: Partial<PreparedEvent> = {}): PreparedEvent {
  const i = n++
  const suffix = `${ALPHABET[(i >> 5) % 32]}${ALPHABET[i % 32]}`
  return {
    ts: '2026-09-07T00:00:00Z',
    id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${suffix}`,
    type,
    data,
    actor: ACTOR,
    origin: 'principal',
    trust: 'trusted',
    lane: 'main',
    v: 1,
    ...over,
  } as PreparedEvent
}

export function resetEventIds(): void {
  n = 0
}
