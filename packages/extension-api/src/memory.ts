import type { EventEnvelope } from '@agnes/protocol'
import { defineKind, type ProviderIdentity } from './provider-kind.js'
import type { FsEntry, FsStat } from './tool.js'

export type MemoryMode = 'off' | 'ask' | 'auto'
export type MemorySettings = Readonly<import('@agnes/protocol/gen/app-server').MemorySettings>
export type MemorySource = Readonly<import('@agnes/protocol/gen/app-server').MemorySource>
export type MemoryFile = Readonly<import('@agnes/protocol/gen/app-server').MemoryFile>
/** The exact file candidate, never an injected context contribution. */
export type MemoryProposal = Readonly<{
  path: string
  baseHash: string
  newHash: string
  diff: string
  source: MemorySource
}>
export type MemorySnapshot = Readonly<{
  revision: string
  content: string
  omitted: boolean
  /**
   * Memory file names changed outside the provider since it last wrote or acknowledged them (for
   * example by an unconfined shell). Injection still proceeds; the session shows a notice.
   */
  externalChanges?: readonly string[]
}>
export type MemoryFilePort = Readonly<{
  read(path: string, options?: { offset?: number; limit?: number }): Promise<Uint8Array>
  write(path: string, content: Uint8Array | string): Promise<void>
  list(path: string): Promise<FsEntry[]>
  stat(path: string): Promise<FsStat>
  revision?(path: string): Promise<string | undefined>
  /**
   * Optional since 5.2.0. Replace the one exact occurrence of `oldText` in the stored file with
   * `newText`, keeping every other byte as stored, including text the agent's view leaves out. The
   * write takes the same review, approval and compare-and-swap path as `write`.
   */
  replaceExact?(path: string, oldText: string, newText: string): Promise<void>
}>
export type MemoryInspection = Readonly<import('@agnes/protocol/gen/app-server').MemoryInspection>

export type MemoryEffectAdmission = import('@agnes/protocol').PermissionEffectAdmission

/** A refusal is a human answer; delivery/cancellation failures remain unanswered. */
export type MemoryApprovalResult = Readonly<
  | {
      status: 'approved' /** Private backend lease; never supplied by tool arguments. */
      admission?: MemoryEffectAdmission
    }
  | { status: 'rejected' }
  | { status: 'unanswered'; reason: import('@agnes/protocol').ApprovalReason }
>

/**
 * Whether a managed paragraph may be shown to the agent: `expired` is past its review date and
 * `unknown` cannot be verified (no record, damaged record or a damaged marker). `delivered` (since
 * 5.4.0) is in force but given to the model by the Host itself: a provider leaves it out of its
 * snapshot without an omission line and shows it on read like `valid`. A provider that predates it
 * treats it as `unknown`.
 */
export type MemoryParagraphValidity = 'valid' | 'expired' | 'unknown' | 'delivered'

/**
 * Optional since 5.2.0. A read-only view the Host passes to `MemoryProvider.open` so a provider can
 * leave out managed paragraphs that are no longer in force. Calls are synchronous and never throw;
 * the Host computes validity with its own clock. `revision()` changes whenever any answer may
 * change. A provider folds the left-out set and `revision()` into its snapshot revision only while
 * the stored file holds managed paragraphs; without any, revision and snapshot bytes stay as they
 * were. Without a view, every managed paragraph is left out for the agent.
 */
export interface MemoryValidityView {
  revision(): string
  validity(paragraphId: string): MemoryParagraphValidity
}

/** A managed paragraph of the stored memory file, as stored. */
export type MemoryParagraph = Readonly<{ id: string; text: string; validity: MemoryParagraphValidity }>

/** Put inserts a new paragraph or replaces one with the same id in place; remove deletes it. */
export type MemoryParagraphChange = Readonly<
  { op: 'put'; id: string; text: string } | { op: 'remove'; id: string }
>

/** The managed paragraphs of the stored file and the hash of the file they were read from. */
export type MemoryParagraphList = Readonly<{ hash: string; paragraphs: readonly MemoryParagraph[] }>

/**
 * Optional since 5.2.0. Paragraph-level access to managed memory outside any turn. It always reads
 * the current stored file, never a per-turn snapshot.
 *
 * - `propose` takes one change or several and returns one proposal that applies all of them, or
 *   refuses the whole call when any member cannot apply (for example removing an id the file does
 *   not hold, or naming one id twice). Given `baseHash` (from `list`), it refuses with
 *   `MEMORY_CONFLICT` when the stored file has changed since; without it the proposal is based on
 *   the current file.
 * - `commit` writes the proposal in one compare-and-swap against `proposal.baseHash`
 *   (`MEMORY_CONFLICT` when stale) and keeps the workspace memory mode: off refuses; under ask the
 *   caller has already obtained approval for the exact proposal. A refusal writes nothing.
 */
export type MemoryParagraphPort = Readonly<{
  list(): Promise<MemoryParagraphList>
  propose(
    changes: MemoryParagraphChange | readonly MemoryParagraphChange[],
    baseHash?: string,
  ): Promise<MemoryProposal>
  commit(proposal: MemoryProposal, admission?: MemoryEffectAdmission): Promise<{ hash: string }>
}>

/** One implementation pinned to a session. Settings are live; revision snapshots are per turn. */
export interface MemorySession {
  readonly root: string
  /** Release resources opened lazily by this session; called after in-flight work drains. */
  close?(): void | Promise<void>
  snapshot(turn: number): Promise<MemorySnapshot | undefined>
  files(
    fallback: MemoryFilePort,
    source: MemorySource,
    signal: AbortSignal,
    approve: (proposal: MemoryProposal) => Promise<MemoryApprovalResult>,
  ): MemoryFilePort
  /** Human inspection/editing is explicit and independent of the agent's off switch. */
  inspect(): Promise<MemoryInspection>
  configure(settings: Partial<MemorySettings>): Promise<MemoryInspection>
  readFile(path: string): Promise<MemoryFile>
  editFile(path: string, content: string, baseHash: string): Promise<MemoryFile>
  /**
   * Optional since 5.2.0. Its presence is the provider's statement that it keeps managed paragraphs
   * and honours the validity view; the Host does not save managed paragraphs to a provider without it.
   */
  paragraphs?(source: MemorySource, signal: AbortSignal): MemoryParagraphPort
  /**
   * Optional since 5.3.0. Managed sections of user memory, the memory every workspace may read: the same
   * port shape as `paragraphs`, over the user memory index instead of the workspace's. Its presence is the
   * provider's statement that it keeps managed sections in user memory and honours `userValidity`; the
   * Host saves nothing to user memory through a provider without it.
   *
   * - It works whatever the workspace's memory mode: the agent never writes user memory, and the Host
   *   decides on its own when a section may be written.
   * - `propose` refuses `MEMORY_USER_BUDGET` when the hand-written text, the sections in force and the
   *   sections being put would not fit the user memory budget the agent is shown, or the index would pass
   *   its size or line cap. It never trims, merges or removes anything to make room. Credential-like
   *   content is refused as in workspace memory (`MEMORY_SECRET_LIKE_CONTENT`).
   * - Hand-written text and marker lines are never changed: only whole sections are put or removed.
   */
  userParagraphs?(source: MemorySource, signal: AbortSignal): MemoryParagraphPort
}

export interface MemoryProvider extends ProviderIdentity {
  /**
   * `validity` is optional since 5.2.0 and `userValidity` since 5.3.0; a provider that does not read them
   * keeps its behaviour. `userValidity` answers for managed sections of user memory as `validity` does for
   * the workspace's: the agent is shown the hand-written user memory first and only the sections in force
   * after it; without the view every managed section of user memory is left out.
   */
  open(
    input: Readonly<{
      home: string
      workspaceRoot: string
      sessionKey: string
      validity?: MemoryValidityView
      userValidity?: MemoryValidityView
    }>,
  ): MemorySession
}

export const memoryKind = defineKind<MemoryProvider>({
  kind: 'memory',
  scope: 'session',
  versioned: true,
  validate(provider) {
    if (typeof provider.open !== 'function') throw new TypeError('Invalid memory provider')
  },
})

/** Memory may be echoed by any message, summary or tool. Export structural facts only. */
export function memoryPrivateEvent(event: Readonly<EventEnvelope>): EventEnvelope {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {}
  const safe: Record<string, import('@agnes/protocol').JsonValue> = { memoryContentOmitted: true }
  for (const key of ['turn', 'step', 'bytes', 'files', 'isError'] as const) {
    const value = data[key]
    if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') safe[key] = value
  }
  for (const key of ['toolUseId', 'requestId', 'effectId', 'name', 'model', 'kind', 'status'] as const) {
    const value = data[key]
    if (typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,256}$/.test(value)) safe[key] = value
  }
  if (
    event.type === 'turn/end' &&
    typeof data.reason === 'string' &&
    ['completed', 'aborted', 'error', 'parked', 'blocked', 'budget', 'max_steps', 'interrupted'].includes(
      data.reason,
    )
  )
    safe.reason = data.reason
  if (data.tokens && typeof data.tokens === 'object' && !Array.isArray(data.tokens)) {
    const tokens: Record<string, number> = {}
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) {
      const value = data.tokens[key]
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) tokens[key] = value
    }
    safe.tokens = tokens
  }
  return { ...event, data: safe }
}
