import { createHash } from 'node:crypto'
import type { MemoryParagraphValidity, MemoryValidityView } from '@agnes/extension-api'
import type { RefinementRegistry } from '@agnes/host-infrastructure/refinement-registry'

type Answers = Readonly<{ byId: ReadonlyMap<string, 'valid' | 'expired'>; revision: string }>

/** How many saved paragraphs the agent is shown and how many are past their review date. */
export type ViewChange = Readonly<{ inForce: number; expired: number }>

/**
 * The read-only validity view memory is opened with: whether each saved paragraph of a workspace may be
 * shown to the agent, by the registry and the Host's clock.
 *
 * Only an active paragraph can be `valid` (before its `reviewAfter`) or `expired` (from then on); any
 * other id is `unknown`. A registry file that cannot be believed reads as empty, so nothing in it is ever
 * valid.
 *
 * `revision()` is a hash of exactly those answers, so it moves when an answer can change (a paragraph
 * saved, removed or converted, or the clock passing a `reviewAfter`) and stays put otherwise (a receipt,
 * a revocation, a renewal of a paragraph that is still valid). A provider prints its revision into the
 * memory note, so a revision that moved without cause would rewrite the note for nothing.
 *
 * The answers are read once per synchronous burst (a provider builds its snapshot in one go) and dropped
 * at the next microtask, so a turn's snapshot reads the registry once and never sees two different
 * moments. Calls never throw: a failed read answers `unknown`.
 *
 * `changed`, when given, hears each time this view's answers differ from the ones it gave before (never
 * on the first read), so the session the view serves can record that its memory note changed because of
 * saved paragraphs. It is called after the answers are taken, outside the provider's call.
 *
 * `inForce: 'delivered'` answers a paragraph in force as `delivered`: the Host gives it to the model in
 * the task-experience snapshot, so memory leaves it out of its note and still shows it on read.
 */
export function registryView(
  registry: RefinementRegistry,
  clock: () => number,
  changed?: (change: ViewChange) => void,
  inForce: 'valid' | 'delivered' = 'valid',
): MemoryValidityView {
  let held: Answers | undefined
  let given: string | undefined
  const answers = (): Answers => {
    if (held) return held
    const now = clock()
    const byId = new Map<string, 'valid' | 'expired'>()
    for (const paragraph of registry.read().paragraphs)
      if (paragraph.state === 'active' && !byId.has(paragraph.id))
        byId.set(paragraph.id, now < paragraph.reviewAfter ? 'valid' : 'expired')
    const sorted = [...byId].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const revision = createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
    held = { byId, revision }
    queueMicrotask(() => {
      held = undefined
    })
    if (changed && given !== undefined && given !== revision) {
      const answers = [...byId.values()]
      const change = {
        inForce: answers.filter((answer) => answer === 'valid').length,
        expired: answers.filter((answer) => answer === 'expired').length,
      }
      queueMicrotask(() => {
        try {
          changed(change)
        } catch {
          // A listener that fails never touches what memory is shown.
        }
      })
    }
    given = revision
    return held
  }
  return Object.freeze({
    delivers: inForce === 'delivered',
    revision(): string {
      try {
        return answers().revision
      } catch {
        return 'unavailable'
      }
    },
    validity(paragraphId: string): MemoryParagraphValidity {
      try {
        const answer = answers().byId.get(paragraphId) ?? 'unknown'
        return answer === 'valid' ? inForce : answer
      } catch {
        return 'unknown'
      }
    },
  })
}
