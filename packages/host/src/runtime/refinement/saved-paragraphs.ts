import type {
  MemoryParagraphList,
  MemoryParagraphPort,
  MemoryParagraphValidity,
  MemorySession,
} from '@agnes/extension-api'
import type {
  RefinementRegistry,
  RegistryRecords,
  Revocation,
  SaveSource,
} from '@agnes/host-infrastructure/refinement-registry'
import { paragraphMarkers, paragraphVisibility } from './paragraph-visibility.js'
import { paragraphPortOf } from './reconcile.js'
import { registryView } from './registry-view.js'

/** What a person asks of the saved paragraphs on the memory page. */
export type SavedParagraphRequest = Readonly<{
  action: 'list' | 'renew' | 'withdraw' | 'convert'
  paragraphId?: string
  /** Authenticated principal supplied by the Host. */
  actor?: string
  /** `user`: the task experience promoted to user memory instead of the workspace's (no `convert`). */
  layer?: 'user'
}>

/** One saved paragraph as a person manages it: its text, whether the agent sees it, and its review date. */
export type SavedParagraph = {
  id: string
  text: string
  validity: MemoryParagraphValidity
  hidden?: true
  nextExpiry?: number
  reviewAfter?: number
  initiator?: SaveSource['initiator']
  kind?: SaveSource['kind']
}

/** Manages a workspace's saved paragraphs for a person, on the memory session the editor uses. */
export type SavedParagraphs = (
  memory: MemorySession,
  workspaceRoot: string,
  request: SavedParagraphRequest,
) => Promise<{ paragraphs: SavedParagraph[] }>

const INDEX = 'MEMORY.md'
const ATTEMPTS = 3
const fault = (code: string) => Object.assign(new Error(code), { code })
const code = (error: unknown): unknown => (error as { code?: unknown } | null)?.code

type Line = { start: number; end: number }

/** The index without the paragraph, cut the way the paragraph port removes one (with its separator). */
function withoutParagraph(text: string, { open, close }: { open: Line; close: Line }): string {
  let before = text.slice(0, open.start)
  const after = text.slice(close.end)
  if (after === '' && text[close.end - 1] !== '\n' && before.endsWith('\n\n')) before = before.slice(0, -2)
  else if (before.endsWith('\n\n') && (after === '' || after.startsWith('\n'))) before = before.slice(0, -1)
  return before + after
}

/** The index with the paragraph's two marker lines taken off and its text kept as ordinary memory. */
function withoutMarkers(text: string, { open, close }: { open: Line; close: Line }): string {
  return text.slice(0, open.start) + text.slice(open.end, close.start) + text.slice(close.end)
}

/** Both memory layers expose the stored text and its effective visibility to the editor. */
export async function describeParagraphs(
  listed: MemoryParagraphList,
  memory: MemorySession,
  layer: 'workspace' | 'user',
  registry: RefinementRegistry,
  clock: () => number,
): Promise<SavedParagraph[]> {
  const { paragraphs } = listed
  if (!paragraphs.length) return []
  const paragraphText = await paragraphVisibility(memory, layer, listed, registry, clock)
  const records = registry.read().paragraphs
  const hostValidity = registryView(registry, clock).validity
  return paragraphs.map((paragraph) => {
    const projection = paragraphText(paragraph)
    const { id, text, validity } = paragraph
    const record = records.find((entry) => entry.id === id && entry.state === 'active')
    const providerStatus = validity === 'delivered' ? 'valid' : validity
    const hostStatus = hostValidity(id)
    let status: MemoryParagraphValidity = 'unknown'
    if (providerStatus === 'expired' || hostStatus === 'expired') status = 'expired'
    else if (providerStatus === 'valid' && hostStatus === 'valid' && projection) status = 'valid'
    return {
      id,
      text,
      validity: status,
      ...(status === 'valid' && projection?.visibleText === null ? { hidden: true as const } : {}),
      ...(projection?.nextExpiry !== undefined ? { nextExpiry: projection.nextExpiry } : {}),
      ...(record
        ? { reviewAfter: record.reviewAfter, initiator: record.source.initiator, kind: record.source.kind }
        : {}),
    }
  })
}

/** A person may renew an in-force record once its effective visibility is verified. */
export async function verifyRenewal(
  port: MemoryParagraphPort | undefined,
  memory: MemorySession,
  layer: 'workspace' | 'user',
  registry: RefinementRegistry,
  clock: () => number,
  id: string,
) {
  const listed = await port?.list()
  const paragraph = listed?.paragraphs.find((p) => p.id === id)
  if (listed && paragraph && (paragraph.validity === 'valid' || paragraph.validity === 'delivered')) {
    const visible = await paragraphVisibility(memory, layer, listed, registry, clock)
    const projection = visible(paragraph)
    if (
      projection?.visibleText &&
      clock() < (projection.nextExpiry ?? Infinity) &&
      registryView(registry, clock).validity(id) === 'valid'
    )
      return
  }
  throw fault('MEMORY_PARAGRAPH_NOT_RENEWABLE')
}

/**
 * A person's management of saved paragraphs, beside the memory editor and like it independent of the
 * agent's memory mode and of the refinement switch:
 * - `list`: every managed paragraph with its registry validity and effective visibility, plus the review
 *   date and who saved it when recorded;
 * - `renew`: a new review period for a recorded paragraph, records only;
 * - `withdraw`: the paragraph is cut from the index (a compare-and-swap edit, as the editor saves), then
 *   recorded as removed with a `memory-withdrawn` revocation, so the same content is not saved back
 *   automatically or by the model;
 * - `convert`: the markers are taken off and the text stays as ordinary memory, recorded as `converted`.
 * The file is changed first; if the records cannot be written afterwards, reconciliation at the next
 * session open records the same outcome from the file. Every answer is the list as it now stands.
 */
export function savedParagraphs(deps: {
  registry: (workspaceRoot: string) => RefinementRegistry
  clock: () => number
}): SavedParagraphs {
  const editorPort = (memory: MemorySession) =>
    paragraphPortOf(memory, { sessionKey: 'human-editor', turn: 0 }, new AbortController().signal)
  const list = async (memory: MemorySession, registry: RefinementRegistry) => {
    const port = editorPort(memory)
    if (!port) return undefined
    const listed = await port.list()
    const paragraphs = await describeParagraphs(listed, memory, 'workspace', registry, deps.clock)
    return { hash: listed.hash, paragraphs }
  }

  /** Writes the records after the file changed; a conflict is retried, other failures are left to reconciliation. */
  const record = (registry: RefinementRegistry, mutate: (draft: RegistryRecords) => void) => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        registry.update(mutate, registry.read().revision)
        return
      } catch (error) {
        if (code(error) !== 'REGISTRY_REVISION_CONFLICT') return
      }
    }
  }

  return async (memory, workspaceRoot, request) => {
    const registry = deps.registry(workspaceRoot)
    if (request.action === 'list') return { paragraphs: (await list(memory, registry))?.paragraphs ?? [] }
    const id = request.paragraphId
    if (typeof id !== 'string') throw fault('MEMORY_INVALID_REQUEST')
    if (request.action === 'renew') {
      await verifyRenewal(editorPort(memory), memory, 'workspace', registry, deps.clock, id)
      try {
        registry.renew({ paragraphId: id })
      } catch (error) {
        throw fault(
          code(error) === 'REGISTRY_ENTRY_NOT_RENEWABLE'
            ? 'MEMORY_PARAGRAPH_NOT_RENEWABLE'
            : 'MEMORY_REGISTRY_UNAVAILABLE',
        )
      }
      return { paragraphs: (await list(memory, registry))?.paragraphs ?? [] }
    }
    const before = await list(memory, registry)
    if (!before) throw fault('MEMORY_PARAGRAPHS_UNSUPPORTED')
    if (!before.paragraphs.some((paragraph) => paragraph.id === id)) throw fault('MEMORY_PARAGRAPH_NOT_FOUND')
    const stored = await memory.readFile(INDEX)
    // The list and the raw file must be the same version; otherwise someone wrote in between.
    if (stored.hash !== before.hash) throw fault('MEMORY_CONFLICT')
    const markers = paragraphMarkers(stored.content).get(id)
    if (!markers) throw fault('MEMORY_PARAGRAPH_NOT_FOUND')
    const withdraw = request.action === 'withdraw'
    const content = withdraw
      ? withoutParagraph(stored.content, markers)
      : withoutMarkers(stored.content, markers)
    const actor = request.actor?.trim() || 'human'
    try {
      await memory.editFile(INDEX, content, stored.hash, { actor })
    } catch (error) {
      // The provider already committed the Markdown when only its metadata update failed.
      if (code(error) !== 'MEMORY_COMMITTED_METADATA_FAILED') throw error
    }
    const now = deps.clock()
    record(registry, (draft) => {
      const entry = draft.paragraphs.find((paragraph) => paragraph.id === id && paragraph.state === 'active')
      if (entry) entry.state = withdraw ? 'removed' : 'converted'
      if (!withdraw) return
      // The saved entry the paragraph came from; for a save whose result was never settled, its receipt.
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
    return { paragraphs: (await list(memory, registry))?.paragraphs ?? [] }
  }
}
