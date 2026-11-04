import type { SkillTrustDecision } from './skill-journal.js'

type Desired = 'enabled' | 'disabled'
type Scanned = Readonly<{ resourceId: string; revision: string; reviewRequired?: boolean }>

/** Every Skill the store has a record of: discovered once, or given a trust or enable decision. */
export function knownSkillIds(records: {
  discovered: readonly Readonly<{ resourceId: string }>[]
  trust: Readonly<Record<string, unknown>>
  desired: Readonly<Record<string, unknown>>
}): ReadonlySet<string> {
  return new Set([
    ...records.discovered.map((item) => item.resourceId),
    ...Object.keys(records.trust),
    ...Object.keys(records.desired),
  ])
}

/**
 * The store's trust rules for one scan, shared by the daemon's store and by hosts that read its saved
 * decisions. A recorded decision follows its Skill across edits: it is rebound to the scanned revision
 * and capability instead of being dropped, so an edited Skill keeps its trust or rejection. A Skill seen
 * for the first time is trusted and enabled; any record of it, or its removal, wins over that.
 * A Skill that requires review (a managed complete import) is the exception: it starts untrusted and
 * disabled, and any edit to its revision or capability returns it to untrusted.
 */
export function skillDecisionsAfterScan(input: {
  trust: Readonly<Record<string, SkillTrustDecision>>
  desired: Readonly<Record<string, Desired>>
  known: ReadonlySet<string>
  removed: readonly string[]
  /** Every Skill that stays discovered after this scan. */
  current: readonly Scanned[]
  /** The Skills this scan observed. */
  observed: readonly Scanned[]
  capability: Readonly<Record<string, string>>
}): { trust: Record<string, SkillTrustDecision>; desired: Record<string, Desired>; changed: boolean } {
  let changed = false
  const ids = new Set(input.current.map((item) => item.resourceId))
  const trust: Record<string, SkillTrustDecision> = {}
  for (const [id, decision] of Object.entries(input.trust)) {
    const descriptor = input.current.find((item) => item.resourceId === id)
    const capabilityHash = input.capability[id]
    if (!descriptor || !capabilityHash) continue
    const edited = decision.revision !== descriptor.revision || decision.capabilityHash !== capabilityHash
    changed ||= edited
    trust[id] = {
      ...decision,
      revision: descriptor.revision,
      capabilityHash,
      ...(descriptor.reviewRequired && edited ? { state: 'untrusted' as const } : {}),
    }
  }
  const desired: Record<string, Desired> = Object.fromEntries(
    Object.entries(input.desired).filter(([id]) => ids.has(id)),
  )
  for (const item of input.observed) {
    const capabilityHash = input.capability[item.resourceId]
    if (input.known.has(item.resourceId) || input.removed.includes(item.resourceId) || !capabilityHash)
      continue
    trust[item.resourceId] = {
      revision: item.revision,
      capabilityHash,
      state: item.reviewRequired ? 'untrusted' : 'trusted',
    }
    desired[item.resourceId] = item.reviewRequired ? 'disabled' : 'enabled'
    changed = true
  }
  return { trust, desired, changed }
}
