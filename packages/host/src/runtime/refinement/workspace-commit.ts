import type {
  MemoryEffectAdmission,
  MemoryParagraphPort,
  MemoryProposal,
  MemorySession,
} from '@agnes/extension-api'
import {
  normalizedContentHash,
  REVIEW_AFTER_MS,
  type RefinementRegistry,
  type RegistryRecords,
  revocationMatches,
  type SaveReceipt,
  type SaveRefusal,
  type SaveSource,
} from '@agnes/host-infrastructure/refinement-registry'
import { permissionEffectAdmission } from '@agnes/protocol'
import { paragraphPortOf, WORKSPACE_MEMORY_KEY } from './reconcile.js'

/**
 * How long a save another process may still be in the middle of is left alone. A save writes its
 * intent, commits the file and records the result within moments; an intent older than this whose
 * paragraph is not in the file was cut off, and is settled as not known.
 */
export const INTENT_SETTLE_MS = 2 * 60_000
const RECORD_ATTEMPTS = 4

export const code = (error: unknown): string | undefined => {
  const value = (error as { code?: unknown } | null)?.code
  return typeof value === 'string' ? value : undefined
}
export const fault = (name: string): Error & { code: string } =>
  Object.assign(new Error(name), { code: name })

/** Errors a memory commit raises before it writes anything, and the refusal each one is. */
const NOT_WRITTEN: Readonly<Record<string, SaveRefusal>> = {
  REFINEMENT_SWITCH_CHANGED: 'refinement-off',
  REFINEMENT_REGISTRY_CHANGED: 'conflict',
  REFINEMENT_MEMORY_MODE_CHANGED: 'conflict',
  REFINEMENT_SAVE_STALE: 'conflict',
  MEMORY_CONFLICT: 'conflict',
  MEMORY_POLICY_CHANGED: 'conflict',
  MEMORY_PROPOSAL_UNKNOWN: 'conflict',
  MEMORY_PARAGRAPH_ANOMALY: 'conflict',
  MEMORY_DISABLED: 'memory-off',
  MEMORY_CONSOLIDATION_REQUIRED: 'memory-full',
  MEMORY_USER_BUDGET: 'user-memory-budget',
  MEMORY_SECRET_LIKE_CONTENT: 'source-rules',
  MEMORY_MARKER_CHANGED: 'source-rules',
  MEMORY_PARAGRAPH_INVALID: 'source-rules',
  MEMORY_MISSING_TOPIC: 'source-rules',
}
/** The refusal a memory error stands for when it came before any write; `unavailable` for the rest. */
export const refusalOf = (error: unknown): SaveRefusal => NOT_WRITTEN[code(error) ?? ''] ?? 'unavailable'

/** Puts `receipt` in place of the receipt with its id, or at the end. */
export function putReceipt(draft: RegistryRecords, receipt: SaveReceipt): void {
  const at = draft.receipts.findIndex((entry) => entry.receiptId === receipt.receiptId)
  if (at === -1) draft.receipts.push(receipt)
  else draft.receipts[at] = receipt
}

/**
 * Applies `mutate` to the registry as it is now, reading it again when another writer got in first.
 * Only for changes that do not depend on what was read before (a receipt, a record of a file that has
 * already committed). False when it could not be written.
 */
export function writeFresh(registry: RefinementRegistry, mutate: (draft: RegistryRecords) => void): boolean {
  for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt++) {
    try {
      registry.update(mutate, registry.read().revision)
      return true
    } catch (error) {
      if (code(error) !== 'REGISTRY_REVISION_CONFLICT') return false
    }
  }
  return false
}

/**
 * Whether a paragraph's text still holds a saved entry's content: some trailing run of its lines (the
 * paragraph is title, line break, content) has `contentHash` under `normalizedContentHash`.
 */
export function holdsContent(text: string, contentHash: string): boolean {
  const lines = text.split('\n')
  for (let start = 0; start < lines.length; start++)
    if (normalizedContentHash(lines.slice(start).join('\n')) === contentHash) return true
  return false
}

/** Records a paragraph whose file commit holds it: active, due for review `REVIEW_AFTER_MS` after `savedAt`. */
function putParagraph(
  draft: RegistryRecords,
  paragraph: { id: string; text: string; source: SaveSource; fileHash: string; savedAt: number },
): void {
  const record = {
    id: paragraph.id,
    source: paragraph.source,
    contentHash: normalizedContentHash(paragraph.text),
    reviewAfter: paragraph.savedAt + REVIEW_AFTER_MS,
    state: 'active' as const,
    fileHash: paragraph.fileHash,
  }
  const at = draft.paragraphs.findIndex((entry) => entry.id === paragraph.id)
  if (at === -1) draft.paragraphs.push(record)
  else draft.paragraphs[at] = record
}

/** Everything one paragraph commit needs; the port is the one the request made its proposals with. */
export type ParagraphCommit = {
  registry: RefinementRegistry
  memory: MemorySession
  port: MemoryParagraphPort
  /**
   * The memory mode the proposal must still be under when it lands. Absent for user memory, which no
   * workspace's memory mode governs.
   */
  mode?: 'ask' | 'auto'
  paragraph: { id: string; text: string }
  /** The receipt this commit settles; its outcome and target are filled in here. */
  receipt: SaveReceipt
  /** The switch must still be on at this revision when the file is written. */
  switchCurrent(): boolean
  clock(): number
  /**
   * The registry revision the decision was made against. A registry that moved since means the
   * decision is stale: `REGISTRY_REVISION_CONFLICT` is thrown before anything is written.
   */
  decided: { revision: string }
  /** What the write that records the save must also do (a user's override clearing a revocation). */
  onSaved?: (draft: RegistryRecords) => void
  /**
   * The paragraph is being replaced in place without anyone reviewing the change: its current text in
   * the file must pass this check (still the text a save wrote, or already the text being saved), or a
   * person has edited it and nothing is written (`conflict`). Checked again before every attempt.
   */
  untouched?: (currentText: string) => boolean
  /** An approved proposal: the file must still give exactly this proposal, or nothing is written. */
  approved?: { baseHash: string; newHash: string }
  /** Paragraph ids whose commit is in flight in this process; resume leaves them alone. */
  inFlight: Set<string>
}

export type CommitResult = { receipt: SaveReceipt } | { stale: true }

/**
 * Writes one paragraph into workspace memory and records it, crash-safely:
 * 1. propose the change (again on a conflicting base, once, unless it was approved as it stood);
 * 2. record the intent: the receipt with outcome `unknown`, naming the paragraph id and the file hash
 *    the commit will give, so reconciliation leaves the id alone and a later resume can tell;
 * 3. commit through the same port, under a fresh admission that holds only while the switch is on at
 *    the same revision, the memory mode is unchanged and the registry has not moved since the intent;
 * 4. only then record the paragraph `active` and the receipt `saved`.
 * A failure before the write settles the receipt as refused; a failure whose effect on the file is not
 * known leaves the intent for `resumeSaves`, which checks the file by exact hash and never writes it.
 */
export async function commitParagraph(input: ParagraphCommit): Promise<CommitResult> {
  const { registry, port, paragraph, inFlight } = input
  const change = { op: 'put' as const, id: paragraph.id, text: paragraph.text }
  const attempts = input.approved ? 1 : 2
  let expected = input.decided.revision
  let first = true
  for (let attempt = 1; ; attempt++) {
    let proposal: MemoryProposal
    try {
      let base = input.approved?.baseHash
      if (input.untouched) {
        const listed = await port.list()
        const current = listed.paragraphs.find((entry) => entry.id === paragraph.id)
        if (!current || !input.untouched(current.text)) return { receipt: settle(input, 'conflict') }
        // Proposed against exactly the file just checked: an edit in between is a conflict.
        base = listed.hash
      }
      proposal = await port.propose(change, base)
    } catch (error) {
      if (input.approved && code(error) === 'MEMORY_CONFLICT') return { stale: true }
      return { receipt: settle(input, refusalOf(error)) }
    }
    if (input.approved && proposal.newHash !== input.approved.newHash) return { stale: true }
    const intent: SaveReceipt = {
      ...input.receipt,
      outcome: 'unknown',
      target: { kind: 'memory-paragraph', paragraphId: paragraph.id, fileHash: proposal.newHash },
    }
    delete intent.reason
    let revision: string
    try {
      revision = registry.update((draft) => putReceipt(draft, intent), expected).revision
    } catch (error) {
      // The first write proves the decision still stands; a later one only moves the intent.
      if (first) throw error
      return { receipt: settle(input, code(error) === 'REGISTRY_UNREADABLE' ? 'unavailable' : 'conflict') }
    }
    first = false
    inFlight.add(paragraph.id)
    try {
      let hash: string
      try {
        hash = (await port.commit(proposal, admissionFor(input, revision))).hash
      } catch (error) {
        const failure = code(error)
        if (failure === 'MEMORY_COMMITTED_METADATA_FAILED') hash = proposal.newHash
        else if (failure === 'MEMORY_CONFLICT' && attempt < attempts) {
          expected = revision
          continue
        } else if (failure !== undefined && failure in NOT_WRITTEN)
          return { receipt: settle(input, NOT_WRITTEN[failure] as SaveRefusal) }
        // Whether the file was written is not known: the intent stays for resume to check.
        return { receipt: intent }
      }
      const saved: SaveReceipt = {
        ...intent,
        outcome: 'saved',
        target: { kind: 'memory-paragraph', paragraphId: paragraph.id, fileHash: hash },
      }
      const recorded = writeFresh(registry, (draft) => {
        putParagraph(draft, {
          id: paragraph.id,
          text: paragraph.text,
          source: input.receipt.source,
          fileHash: hash,
          savedAt: input.clock(),
        })
        putReceipt(draft, saved)
        input.onSaved?.(draft)
      })
      // The file holds the paragraph either way; unrecorded, resume records it from the file.
      return { receipt: recorded ? saved : intent }
    } finally {
      inFlight.delete(paragraph.id)
    }
  }
}

/** The receipt refused for `reason`, recorded in place of the intent if there is one (best effort). */
function settle(input: ParagraphCommit, reason: SaveRefusal): SaveReceipt {
  const refused: SaveReceipt = { ...input.receipt, outcome: 'refused', reason }
  delete refused.target
  writeFresh(input.registry, (draft) => putReceipt(draft, refused))
  return refused
}

/**
 * A fresh admission for one commit. It holds while the switch is on at the request's revision and the
 * registry is still at `revision` (checked again inside the file write), and while the memory mode is
 * the one the proposal was made under (checked before the write).
 */
function admissionFor(input: ParagraphCommit, revision: string): MemoryEffectAdmission {
  return permissionEffectAdmission({
    assertBound() {
      if (!input.switchCurrent()) throw fault('REFINEMENT_SWITCH_CHANGED')
      if (input.registry.read().revision !== revision) throw fault('REFINEMENT_REGISTRY_CHANGED')
    },
    async verify() {
      if (input.mode === undefined) return
      const mode = (await input.memory.inspect()).settings.mode
      if (mode !== input.mode) throw fault('REFINEMENT_MEMORY_MODE_CHANGED')
    },
    unavailable: () => fault('REFINEMENT_SAVE_STALE'),
  })
}

/** An intent a save left: a receipt whose outcome is not known yet, naming a paragraph. */
export const pendingIntent = (receipt: SaveReceipt): boolean =>
  receipt.outcome === 'unknown' && receipt.reason === undefined && receipt.target?.kind === 'memory-paragraph'

/**
 * Settles the intents a save left behind when it was cut off between recording its intent and
 * recording its result. The stored file is read, never written:
 * - the paragraph is there and the file's hash is exactly the one the commit was to give: the commit
 *   landed; the paragraph is recorded `active` and the receipt `saved`;
 * - the paragraph is there under an id no active paragraph held before (a fresh id only this save
 *   could have written) and still holds this save's content, though other bytes of the file moved
 *   since: the commit landed too, and the paragraph is recorded as it stands in the file;
 * - the paragraph is there under the id of an active paragraph it was replacing, but the file has
 *   changed since, or it is not there and the intent is older than `INTENT_SETTLE_MS`: what happened
 *   cannot be told, so the receipt stays `unknown` (with reason `conflict`, settled) and nothing is
 *   written again;
 * - a younger intent whose paragraph is not there yet is left: another process may still be saving.
 */
export async function resumeSaves(
  registry: RefinementRegistry,
  memory: MemorySession | undefined,
  clock: () => number,
  inFlight: ReadonlySet<string>,
  /** The port the saves were written through: the workspace's paragraphs unless told otherwise. */
  portOf: typeof paragraphPortOf = paragraphPortOf,
): Promise<void> {
  const pending = registry
    .read()
    .receipts.filter((receipt) => pendingIntent(receipt) && !inFlight.has(paragraphOf(receipt)))
  if (!pending.length || !memory) return
  const port = portOf(memory, { sessionKey: WORKSPACE_MEMORY_KEY, turn: 0 }, new AbortController().signal)
  if (!port) return
  let listed: Awaited<ReturnType<MemoryParagraphPort['list']>>
  try {
    listed = await port.list()
  } catch {
    return
  }
  const now = clock()
  writeFresh(registry, (draft) => {
    for (const intent of pending) {
      const current = draft.receipts.find((entry) => entry.receiptId === intent.receiptId)
      if (!current || !pendingIntent(current)) continue
      const id = paragraphOf(current)
      const found = listed.paragraphs.find((entry) => entry.id === id)
      const exact =
        found !== undefined &&
        current.target?.kind === 'memory-paragraph' &&
        listed.hash === current.target.fileHash
      // A fresh id proves the commit landed, not that the text is still what it wrote: a person may
      // have edited it since, so it is recorded only while it still holds this save's content.
      const fresh =
        found !== undefined &&
        !draft.paragraphs.some((paragraph) => paragraph.id === id && paragraph.state === 'active') &&
        holdsContent(found.text, current.source.contentHash)
      if (found && (exact || fresh)) {
        putParagraph(draft, {
          id,
          text: found.text,
          source: current.source,
          fileHash: listed.hash,
          savedAt: current.at,
        })
        putReceipt(draft, {
          ...current,
          outcome: 'saved',
          target: { kind: 'memory-paragraph', paragraphId: id, fileHash: listed.hash },
        })
        // The user's own save overrode a revocation; it is cleared now that the save is known to have landed.
        if (current.initiator === 'user')
          draft.revocations = draft.revocations.filter((record) => !revocationMatches(record, current.source))
      } else if (found || now - current.at >= INTENT_SETTLE_MS)
        putReceipt(draft, { ...current, reason: 'conflict' })
    }
  })
}

const paragraphOf = (receipt: SaveReceipt): string =>
  receipt.target?.kind === 'memory-paragraph' ? receipt.target.paragraphId : ''
