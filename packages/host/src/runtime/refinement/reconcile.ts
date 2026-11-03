import { createHash } from 'node:crypto'
import type { MemoryParagraph, MemoryParagraphPort, MemorySession, MemorySource } from '@agnes/extension-api'
import type {
  RefinementRegistry,
  RegistrySnapshot,
  Revocation,
} from '@agnes/host-infrastructure/refinement-registry'

/** The session key the Host opens workspace memory under for work outside any session's turn. */
export const WORKSPACE_MEMORY_KEY = 'refinement:workspace'

const INDEX = 'MEMORY.md'
/** Longest stretch of text (after whitespace is collapsed) one saved paragraph is looked for in. */
const MAX_PARAGRAPH_CHARS = 32_768
const ATTEMPTS = 3

/** The stored memory index as reconciliation reads it: its managed paragraphs and its raw text. */
export type StoredIndex = Readonly<{ paragraphs: readonly Pick<MemoryParagraph, 'id'>[]; text: string }>

const code = (error: unknown): string | undefined => (error as { code?: unknown } | null)?.code as string

/**
 * The provider's paragraph port, or undefined when it has none that works. A session from an older
 * extension API may carry a member named `paragraphs` that means something else, so the member must be a
 * function, the call must not throw, and what it returns must have the port's three methods.
 */
export function paragraphPortOf(
  session: MemorySession,
  source: MemorySource,
  signal: AbortSignal,
): MemoryParagraphPort | undefined {
  if (typeof session.paragraphs !== 'function') return undefined
  try {
    const port = session.paragraphs(source, signal) as Partial<MemoryParagraphPort> | null | undefined
    return port &&
      typeof port.list === 'function' &&
      typeof port.propose === 'function' &&
      typeof port.commit === 'function'
      ? (port as MemoryParagraphPort)
      : undefined
  } catch {
    return undefined
  }
}

/** Reads the stored index; undefined when the provider cannot list paragraphs or a read fails. */
async function readIndex(session: MemorySession, signal: AbortSignal): Promise<StoredIndex | undefined> {
  const port = paragraphPortOf(session, { sessionKey: WORKSPACE_MEMORY_KEY, turn: 0 }, signal)
  if (!port) return undefined
  try {
    const stored = await session.readFile(INDEX)
    const listed = (await port.list()) as { paragraphs?: unknown } | null
    const paragraphs = listed?.paragraphs
    if (typeof stored?.content !== 'string' || !Array.isArray(paragraphs)) return undefined
    if (!paragraphs.every((entry) => typeof (entry as { id?: unknown } | null)?.id === 'string'))
      return undefined
    return { paragraphs: paragraphs as Pick<MemoryParagraph, 'id'>[], text: stored.content }
  } catch {
    return undefined
  }
}

/**
 * Which of `wanted` (hashes made with `normalizedContentHash`) occur in `text` as a run of whole lines.
 * The normalised form of a run of lines is its non-blank lines, each trimmed, inner whitespace collapsed
 * and lower-cased, joined by one space, which is what `normalizedContentHash` makes of the same text.
 */
function linesWithHash(text: string, wanted: ReadonlySet<string>): Set<string> {
  const found = new Set<string>()
  if (!wanted.size) return found
  const lines = text
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter((line) => line.length > 0)
  for (let start = 0; start < lines.length && found.size < wanted.size; start++) {
    const hash = createHash('sha256')
    let length = 0
    for (let end = start; end < lines.length; end++) {
      const piece = end === start ? (lines[end] as string) : ` ${lines[end]}`
      length += piece.length
      if (length > MAX_PARAGRAPH_CHARS) break
      hash.update(piece)
      const digest = hash.copy().digest('hex')
      if (wanted.has(digest)) found.add(digest)
    }
  }
  return found
}

/**
 * Brings the registry in line with what a person did to the memory file, against the registry snapshot
 * `read` (taken before `index` was read). For each active paragraph whose id no longer appears in the file
 * at all:
 * - its text still there as a run of lines (the markers were taken off): `converted`, ordinary memory
 *   from now on, out of the registry's care;
 * - otherwise (the paragraph was deleted): `removed`, with a `memory-deleted` revocation carrying the
 *   source entry's content hash, so the same content is not saved back automatically.
 *
 * A paragraph whose id is still in the file (listed, or under a damaged marker that waits for repair) is
 * left alone, and so is one whose save is still in flight (a receipt with outcome `unknown` names it).
 * The write is a compare-and-swap on `read.revision`: `REGISTRY_REVISION_CONFLICT` means the registry
 * moved and both reads must be made again. Returns the revocations added.
 */
export function reconcileParagraphs(
  registry: RefinementRegistry,
  read: RegistrySnapshot,
  index: StoredIndex,
  now: number,
): Revocation[] {
  const listed = new Set(index.paragraphs.map((entry) => entry.id))
  const inFlight = new Set(
    read.receipts.flatMap((receipt) =>
      // Only a save still in flight (not yet settled) holds its paragraph out of reconciliation.
      receipt.outcome === 'unknown' &&
      receipt.reason === undefined &&
      receipt.target?.kind === 'memory-paragraph'
        ? [receipt.target.paragraphId]
        : [],
    ),
  )
  const gone = read.paragraphs.filter(
    (entry) =>
      entry.state === 'active' &&
      !listed.has(entry.id) &&
      !index.text.includes(entry.id) &&
      !inFlight.has(entry.id),
  )
  if (!gone.length) return []
  const kept = linesWithHash(index.text, new Set(gone.map((entry) => entry.contentHash)))
  const verdicts = new Map(gone.map((entry) => [entry.id, kept.has(entry.contentHash)] as const))
  const revocations: Revocation[] = gone
    .filter((entry) => !kept.has(entry.contentHash))
    .map(({ source }) => ({
      sessionKey: source.sessionKey,
      kind: source.kind,
      entryId: source.entryId,
      contentHash: source.contentHash,
      action: 'memory-deleted',
      at: now,
    }))
  registry.update((draft) => {
    for (const entry of draft.paragraphs) {
      const converted = entry.state === 'active' ? verdicts.get(entry.id) : undefined
      if (converted !== undefined) entry.state = converted ? 'converted' : 'removed'
    }
    draft.revocations.push(...revocations)
  }, read.revision)
  return revocations
}

/**
 * Reconciles one workspace: reads the registry, then the memory index, then writes what changed. When the
 * registry moved in between, both are read again (a few times at most), so a paragraph saved meanwhile is
 * never judged against a file read before it was written. A registry that cannot be believed, a provider
 * without a paragraph port, or a failed read changes nothing. Returns the revocations added.
 */
export async function reconcileWorkspace(
  registry: RefinementRegistry,
  session: MemorySession,
  clock: () => number,
  signal: AbortSignal = new AbortController().signal,
): Promise<Revocation[]> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const read = registry.read()
    if (!read.paragraphs.some((entry) => entry.state === 'active')) return []
    const index = await readIndex(session, signal)
    if (!index) return []
    try {
      return reconcileParagraphs(registry, read, index, clock())
    } catch (error) {
      const failure = code(error)
      if (failure === 'REGISTRY_REVISION_CONFLICT') continue
      if (failure === 'REGISTRY_UNREADABLE') return []
      throw error
    }
  }
  return []
}
