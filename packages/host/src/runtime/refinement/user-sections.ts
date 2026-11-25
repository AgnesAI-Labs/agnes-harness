import type { MemorySession } from '@agnes/extension-api'
import type { RefinementRegistry, Revocation } from '@agnes/host-infrastructure/refinement-registry'
import {
  describeParagraphs,
  renewVerifiedParagraph,
  type SavedParagraph,
  type SavedParagraphRequest,
  verifyRenewal,
} from './saved-paragraphs.js'
import { userPortOf } from './user-save.js'
import { code, writeFresh } from './workspace-commit.js'

const fault = (name: string) => Object.assign(new Error(name), { code: name })

/**
 * A person's management of the task experience promoted to user memory, beside the memory editor and like
 * it independent of the agent's memory mode and of the refinement switch:
 * - `list`: every managed section of user memory, with whether the agent sees it, its review date and
 *   who saved it when recorded;
 * - `renew`: a new review period for a recorded section, records only;
 * - `withdraw`: the section is cut from user memory (one compare-and-swap through the provider), then
 *   recorded as removed with a `memory-withdrawn` revocation, so the same content is not promoted again.
 * There is no `convert` for user memory: a person who wants to keep the text writes it by hand.
 */
export async function manageUserSections(
  memory: MemorySession,
  registry: RefinementRegistry,
  request: SavedParagraphRequest,
  clock: () => number,
): Promise<{ paragraphs: SavedParagraph[] }> {
  const port = userPortOf(memory, { sessionKey: 'human-editor', turn: 0 }, new AbortController().signal)
  const list = async (): Promise<SavedParagraph[]> => {
    if (!port) return []
    return describeParagraphs(await port.list(), memory, 'user', registry, clock)
  }
  if (request.action === 'list') return { paragraphs: await list() }
  const id = request.paragraphId
  if (typeof id !== 'string') throw fault('MEMORY_INVALID_REQUEST')
  if (request.action === 'renew') {
    const proof = await verifyRenewal(port, memory, 'user', registry, clock, id)
    renewVerifiedParagraph(registry, id, proof)
    return { paragraphs: await list() }
  }
  if (request.action !== 'withdraw') throw fault('MEMORY_INVALID_REQUEST')
  if (!port) throw fault('MEMORY_PARAGRAPHS_UNSUPPORTED')
  const listed = await port.list()
  if (!listed.paragraphs.some((paragraph) => paragraph.id === id)) throw fault('MEMORY_PARAGRAPH_NOT_FOUND')
  const proposal = await port.propose({ op: 'remove', id }, listed.hash)
  try {
    await port.commit(proposal)
  } catch (error) {
    if (code(error) !== 'MEMORY_COMMITTED_METADATA_FAILED') throw error
  }
  const now = clock()
  const actor = request.actor?.trim() || 'human'
  // The file has changed; if the records cannot be written now, the next reconciliation records the
  // section as taken back from the file.
  writeFresh(registry, (draft) => {
    const entry = draft.paragraphs.find((paragraph) => paragraph.id === id && paragraph.state === 'active')
    if (entry) entry.state = 'removed'
    const source =
      entry?.source ??
      draft.receipts.findLast(
        (receipt) => receipt.target?.kind === 'memory-paragraph' && receipt.target.paragraphId === id,
      )?.source
    if (!source) return
    const revocation: Revocation = {
      sessionKey: source.sessionKey,
      kind: source.kind,
      entryId: source.entryId,
      contentHash: source.contentHash,
      action: 'memory-withdrawn',
      actor,
      at: now,
    }
    if (
      !draft.revocations.some(
        (r) =>
          r.action === 'memory-withdrawn' &&
          r.sessionKey === revocation.sessionKey &&
          r.kind === revocation.kind &&
          r.entryId === revocation.entryId &&
          r.contentHash === revocation.contentHash,
      )
    )
      draft.revocations.push(revocation)
  })
  return { paragraphs: await list() }
}
