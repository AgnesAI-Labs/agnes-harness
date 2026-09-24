import type { HarnessEntry, RefineLimits, RefineProposal } from '@agnes/core'
import { KINDS } from './queue.js'

export type RefineGateLimits = Omit<RefineLimits, 'contractPrefixMarkers'> & {
  contractPrefixHash: string
}
export type RefineGateResult = { ok: true } | { ok: false; reason: string }

/** Pure T0 review. Core repeats the stateful baseline/evidence checks when it atomically applies. */
export function gateT0(
  proposal: RefineProposal,
  limits: RefineGateLimits,
  current: readonly HarnessEntry[],
): RefineGateResult {
  if (!Array.isArray(proposal.evidenceSeqs) || proposal.evidenceSeqs.length === 0)
    return { ok: false, reason: 'no_evidence' }
  const entries = new Map(current.map((entry) => [`${entry.kind}\0${entry.id}`, entry]))
  for (const edit of proposal.edits) {
    const kind = edit.op === 'upsert' ? edit.entry.kind : edit.kind
    if (!KINDS.has(kind)) return { ok: false, reason: `unknown_kind ${String(kind)}` }
    if (edit.op === 'delete') {
      entries.delete(`${edit.kind}\0${edit.id}`)
      continue
    }
    if (edit.entry.content.length > limits.maxCharsPerEntry)
      return { ok: false, reason: 'max_chars_per_entry' }
    if (
      edit.entry.content.startsWith('<contract') ||
      (limits.contractPrefixHash !== '' && edit.entry.content.includes(limits.contractPrefixHash))
    )
      return { ok: false, reason: 'contract_prefix' }
    entries.set(`${edit.entry.kind}\0${edit.entry.id}`, edit.entry)
  }
  const counts = new Map<HarnessEntry['kind'], number>()
  for (const entry of entries.values()) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1)
  for (const kind of KINDS as Set<HarnessEntry['kind']>)
    if ((counts.get(kind) ?? 0) > limits.maxEntries[kind]) return { ok: false, reason: `max_entries ${kind}` }
  return { ok: true }
}
