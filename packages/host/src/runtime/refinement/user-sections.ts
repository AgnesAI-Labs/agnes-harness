import type { MemorySession } from '@agnes/extension-api'
import type { RefinementRegistry, Revocation } from '@agnes/host-infrastructure/refinement-registry'
import type { SavedParagraph, SavedParagraphRequest } from './saved-paragraphs.js'
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
    const records = registry.read().paragraphs
    return (await port.list()).paragraphs.map(({ id, text, validity }) => {
      const record = records.find((entry) => entry.id === id && entry.state === 'active')
      return {
        id,
        text,
        // In force either way: delivered through the experience snapshot rather than the memory note.
        validity: validity === 'delivered' ? 'valid' : validity,
        ...(record
          ? { reviewAfter: record.reviewAfter, initiator: record.source.initiator, kind: record.source.kind }
          : {}),
      }
    })
  }
  if (request.action === 'list') return { paragraphs: await list() }
  const id = request.paragraphId
  if (typeof id !== 'string') throw fault('MEMORY_INVALID_REQUEST')
  if (request.action === 'renew') {
    try {
      registry.renew({ paragraphId: id })
    } catch (error) {
      throw fault(
        code(error) === 'REGISTRY_ENTRY_NOT_RENEWABLE'
          ? 'MEMORY_PARAGRAPH_NOT_RENEWABLE'
          : 'MEMORY_REGISTRY_UNAVAILABLE',
      )
    }
    return { paragraphs: await list() }
  }
  if (request.action !== 'withdraw') throw fault('MEMORY_INVALID_REQUEST')
  if (!port) throw fault('MEMORY_PARAGRAPHS_UNSUPPORTED')
  const listed = await port.list()
  if (!listed.paragraphs.some((paragraph) => paragraph.id === id)) throw fault('MEMORY_PARAGRAPH_NOT_FOUND')
  await port.commit(await port.propose({ op: 'remove', id }, listed.hash))
  const now = clock()
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
