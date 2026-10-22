import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { type HostSession, scanPages } from '@agnes/host'
import { type Actor, type EventEnvelope, rpcError, type ToolCall } from '@agnes/protocol'
import { normalizeWorkspacePath } from './workspace-files.js'

const RECEIPT_TYPE = 'x/agnes/tools-core/file-change'
export const UNDO_FACT_TYPE = 'x/core/workspace-undo'
/** Older receipts than this many rows are not looked at; their turns are simply not offered. */
const MAX_RECEIPT_ROWS = 5000
const MAX_FILES = 200
const CHECKPOINT_ID = /^[A-Za-z0-9_-]{1,128}$/
const HEX64 = /^[a-f0-9]{64}$/
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export type UndoFileReason =
  | 'legacy-receipt'
  | 'no-checkpoint'
  | 'checkpoint-collected'
  | 'changed-since'
  | 'missing'
  | 'unreadable'
export type UndoPreviewFile = {
  path: string
  /** What undo does to the file: put the old bytes back, remove a file the turn created, or nothing. */
  action: 'restore' | 'delete' | 'unchanged'
  undoable: boolean
  reason?: UndoFileReason
}
export type UndoBlock = 'none' | 'busy' | 'read-only' | 'later-turns' | 'already-undone' | 'files'
export type UndoPreview = {
  sessionId: string
  /** Absent when the session has no file-changing turn to offer. */
  turn?: number
  busy: boolean
  undoable: boolean
  blockedBy: UndoBlock
  /** Later file-changing turns that must be undone first. */
  laterTurns: number[]
  /** The turn also ran shell commands; whatever they changed is not restored. */
  shellChanges: boolean
  files: UndoPreviewFile[]
}
export type UndoResult = {
  sessionId: string
  turn: number
  seq: number
  restored: string[]
  failed: { path: string; reason: string }[]
  conflicts: { path: string; reason: string }[]
}
export type UndoFact = {
  turn: number
  commandId: string
  admissionId: string
  restored: string[]
  failed: { path: string; reason: string }[]
  conflicts: { path: string; reason: string }[]
}

type Receipt = {
  seq: number
  path: string
  turn: number
  existed: boolean
  beforeHash: string
  afterHash: string
  checkpointId?: string
}
type Entry = { path: string; first: Receipt; last: Receipt }

function receipt(row: EventEnvelope, sessionId: string): Receipt | undefined {
  const data = record(row.data)
  if (
    !data ||
    row.type !== RECEIPT_TYPE ||
    row.origin !== 'ext:agnes/tools-core' ||
    data.version !== 1 ||
    data.sessionId !== sessionId ||
    typeof data.path !== 'string' ||
    typeof data.existed !== 'boolean' ||
    !Number.isSafeInteger(data.turn) ||
    Number(data.turn) < 1 ||
    !HEX64.test(String(data.beforeHash)) ||
    !HEX64.test(String(data.afterHash))
  )
    return undefined
  try {
    if (!data.path || normalizeWorkspacePath(data.path) !== data.path) return undefined
  } catch {
    return undefined
  }
  const id = data.checkpointId
  return {
    seq: row.seq,
    path: data.path,
    turn: Number(data.turn),
    existed: data.existed,
    beforeHash: String(data.beforeHash),
    afterHash: String(data.afterHash),
    ...(typeof id === 'string' && CHECKPOINT_ID.test(id) ? { checkpointId: id } : {}),
  }
}

async function scanAll(session: HostSession, query: { type: string | string[]; order: 'desc' | 'asc' }) {
  const rows: EventEnvelope[] = []
  for await (const page of scanPages((q) => session.scan(q) as Promise<EventEnvelope[]>, {
    ...query,
    toSeq: session.lastSeq,
  })) {
    rows.push(...page)
    if (rows.length >= MAX_RECEIPT_ROWS) break
  }
  return rows
}

/** Every turn of this session's own ledger that wrote files, from receipts only. */
async function receiptTurns(session: HostSession): Promise<Map<number, Entry[]>> {
  const byTurn = new Map<number, Map<string, Entry>>()
  // Newest first up to the cap, then replayed oldest first, so a long session loses its oldest turns.
  for (const row of (await scanAll(session, { type: RECEIPT_TYPE, order: 'desc' })).reverse()) {
    const value = receipt(row, session.key)
    if (!value) continue
    const paths = byTurn.get(value.turn) ?? new Map<string, Entry>()
    const known = paths.get(value.path)
    paths.set(value.path, known ? { ...known, last: value } : { path: value.path, first: value, last: value })
    byTurn.set(value.turn, paths)
  }
  return new Map(
    [...byTurn].map(([turn, paths]) => [
      turn,
      [...paths.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    ]),
  )
}

/** Turns whose undo ran to the end: nothing failed and nothing was refused. */
async function undoneTurns(session: HostSession): Promise<Set<number>> {
  const done = new Set<number>()
  for (const row of await scanAll(session, { type: UNDO_FACT_TYPE, order: 'asc' })) {
    const fact = record(row.data)
    if (
      fact &&
      Number.isSafeInteger(fact.turn) &&
      Array.isArray(fact.failed) &&
      fact.failed.length === 0 &&
      Array.isArray(fact.conflicts) &&
      fact.conflicts.length === 0
    )
      done.add(Number(fact.turn))
  }
  return done
}

/** Whether the turn ran a command that may have changed files outside the write and edit tools. */
async function ranShell(session: HostSession, turn: number): Promise<boolean> {
  const starts = await scanAll(session, { type: 'turn/start', order: 'asc' })
  const index = starts.findIndex((row) => record(row.data)?.turn === turn)
  const from = starts[index]
  if (!from) return false
  const to = starts[index + 1]?.seq ?? session.lastSeq + 1
  for await (const page of scanPages((q) => session.scan(q) as Promise<EventEnvelope[]>, {
    type: 'tool/call',
    fromSeq: from.seq,
    toSeq: to - 1,
  }))
    for (const row of page) {
      const call = row.data as ToolCall
      if (
        call.executionDomain === 'workspace' &&
        call.resolvedPolicy?.isReadOnly !== true &&
        call.name !== 'write' &&
        call.name !== 'edit'
      )
        return true
    }
  return false
}

type Disk = { kind: 'file'; hash: string } | { kind: 'absent' } | { kind: 'unreadable' }
async function diskState(
  fs: { read(path: string): Promise<Uint8Array> },
  root: string,
  path: string,
): Promise<Disk> {
  try {
    return { kind: 'file', hash: sha256(await fs.read(join(root, ...path.split('/')))) }
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable' }
  }
}

type Judged = UndoPreviewFile & { entry: Entry }
function judge(entry: Entry, turn: number, disk: Disk, checkpoints: ReadonlyMap<string, string>): Judged {
  const { first, last } = entry
  const base = { path: entry.path, entry }
  const atBefore = first.existed
    ? disk.kind === 'file' && disk.hash === first.beforeHash
    : disk.kind === 'absent'
  const atAfter = disk.kind === 'file' && disk.hash === last.afterHash
  if (atBefore && !atAfter) return { ...base, action: 'unchanged', undoable: true }
  if (disk.kind === 'unreadable') return { ...base, action: 'restore', undoable: false, reason: 'unreadable' }
  if (disk.kind === 'absent') return { ...base, action: 'restore', undoable: false, reason: 'missing' }
  if (disk.hash !== last.afterHash)
    return { ...base, action: 'restore', undoable: false, reason: 'changed-since' }
  const action = first.existed ? 'restore' : 'delete'
  if (!first.checkpointId) return { ...base, action, undoable: false, reason: 'legacy-receipt' }
  const stepId = checkpoints.get(first.checkpointId)
  if (stepId === undefined) return { ...base, action, undoable: false, reason: 'checkpoint-collected' }
  if (!stepId.startsWith(`${turn}/`)) return { ...base, action, undoable: false, reason: 'no-checkpoint' }
  return { ...base, action, undoable: true }
}

type Invocation = NonNullable<HostSession['d']['workspaceInvocation']>
type View = Parameters<Parameters<Invocation['run']>[0]>[0]

async function withWorkspace<T>(session: HostSession, run: (view: View) => Promise<T>): Promise<T> {
  const port = session.d.workspaceInvocation
  if (!port) throw rpcError('CAPABILITY_DENIED')
  return session.d.workspacePublication
    ? session.d.workspacePublication.workspace(() => ({ port, handler: run }))
    : port.run(run)
}

type Plan = {
  preview: UndoPreview
  judged: Judged[]
  view: View
}

async function plan(session: HostSession, view: View, requested?: number): Promise<Plan> {
  const turns = await receiptTurns(session)
  const done = await undoneTurns(session)
  const open = [...turns.keys()].filter((turn) => !done.has(turn)).sort((a, b) => a - b)
  const turn = requested ?? open[open.length - 1]
  const busy = session.op() !== null
  const readOnly = session.preset.permission === 'read-only'
  const entries = turn === undefined ? undefined : turns.get(turn)
  const empty = (blockedBy: UndoBlock): Plan => ({
    preview: {
      sessionId: session.key,
      ...(turn === undefined ? {} : { turn }),
      busy,
      undoable: false,
      blockedBy,
      laterTurns: [],
      shellChanges: false,
      files: [],
    },
    judged: [],
    view,
  })
  if (turn === undefined || !entries || entries.length === 0) return empty('none')
  const laterTurns = open.filter((candidate) => candidate > turn)
  const listed = new Map((await view.checkpointContext().list()).map((item) => [item.id, item.stepId]))
  const judged: Judged[] = []
  for (const entry of entries.slice(0, MAX_FILES))
    judged.push(judge(entry, turn, await diskState(view.fs(), view.root, entry.path), listed))
  const blockedBy: UndoBlock = done.has(turn)
    ? 'already-undone'
    : judged.every((file) => file.action === 'unchanged')
      ? 'already-undone'
      : busy
        ? 'busy'
        : readOnly
          ? 'read-only'
          : laterTurns.length > 0
            ? 'later-turns'
            : entries.length > MAX_FILES || judged.some((file) => !file.undoable)
              ? 'files'
              : 'none'
  return {
    preview: {
      sessionId: session.key,
      turn,
      busy,
      undoable: blockedBy === 'none',
      blockedBy,
      laterTurns,
      shellChanges: await ranShell(session, turn),
      files: judged.map(({ entry: _entry, ...file }) => file),
    },
    judged,
    view,
  }
}

/** Read-only: what undoing a turn would do, without touching a file or the ledger. */
export function sessionUndoPreview(session: HostSession, input: { turn?: number }): Promise<UndoPreview> {
  return withWorkspace(session, async (view) => (await plan(session, view, input.turn)).preview)
}

const refuse = (code: string, extra: Record<string, unknown> = {}) =>
  rpcError('SEMANTIC_REJECTED', { code, ...extra })

/**
 * Put one turn's file changes back. Everything is decided under the session lock, so no turn can
 * start while files move. A file changed after the turn refuses the whole undo; a failure part way
 * stops there and says which files were restored and which were not. The ledger fact is written
 * from what the disk was verified to hold, not from what was attempted.
 */
export function sessionUndo(
  session: HostSession,
  input: { turn: number; commandId: string; admissionId: string; actor: Actor },
): Promise<UndoResult> {
  return session.locked(() =>
    withWorkspace(session, async (view) => {
      if (session.op() !== null)
        throw rpcError('SESSION_BUSY', { sessionId: session.key, reason: 'a turn is running' })
      if (session.preset.permission === 'read-only') throw refuse('UNDO_READ_ONLY')
      const { preview, judged } = await plan(session, view, input.turn)
      if (preview.turn !== input.turn || judged.length === 0)
        throw refuse('UNDO_NOTHING_TO_UNDO', { turn: input.turn })
      if (preview.blockedBy === 'already-undone') throw refuse('UNDO_ALREADY_DONE', { turn: input.turn })
      if (preview.blockedBy === 'later-turns')
        throw refuse('UNDO_LATER_TURNS', { turn: input.turn, laterTurns: preview.laterTurns })
      const write = async (
        restored: string[],
        failed: UndoFact['failed'],
        conflicts: UndoFact['conflicts'],
      ) => {
        const fact: UndoFact = {
          turn: input.turn,
          commandId: input.commandId,
          admissionId: input.admissionId,
          restored,
          failed,
          conflicts,
        }
        const { firstSeq } = await session.append([
          session.ev(UNDO_FACT_TYPE, fact, { actor: input.actor, origin: 'principal', ignorable: true }),
        ])
        return firstSeq
      }
      const conflicts = judged
        .filter(
          (file) => !file.undoable && ['changed-since', 'missing', 'unreadable'].includes(file.reason ?? ''),
        )
        .map((file) => ({ path: file.path, reason: file.reason as string }))
      if (conflicts.length > 0) {
        await write([], [], conflicts)
        throw refuse('UNDO_CONFLICT', { turn: input.turn, conflicts })
      }
      const blocked = judged.filter((file) => !file.undoable)
      // Also covers a turn with more files than one undo handles: it is refused whole, never cut short.
      if (blocked.length > 0 || preview.blockedBy !== 'none')
        throw refuse('UNDO_UNAVAILABLE', {
          turn: input.turn,
          files: blocked.map((file) => ({ path: file.path, reason: file.reason })),
        })
      const seam = view.checkpointContext()
      const restored: string[] = []
      const failed: UndoFact['failed'] = []
      for (const file of judged) {
        if (file.action === 'unchanged') continue
        if (failed.length > 0) {
          failed.push({ path: file.path, reason: 'not-attempted' })
          continue
        }
        const id = file.entry.first.checkpointId as string
        try {
          await seam.rewind(id)
          const after = await diskState(view.fs(), view.root, file.path)
          const ok = file.entry.first.existed
            ? after.kind === 'file' && after.hash === file.entry.first.beforeHash
            : after.kind === 'absent'
          if (!ok) failed.push({ path: file.path, reason: 'verify-mismatch' })
          else restored.push(file.path)
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code
          failed.push({ path: file.path, reason: typeof code === 'string' ? code : 'restore-failed' })
        }
      }
      const seq = await write(restored, failed, [])
      return { sessionId: session.key, turn: input.turn, seq, restored, failed, conflicts: [] }
    }),
  )
}

/** What a recorded undo fact answers: the result of a command whose acknowledgement was lost. */
export function undoResultFromFact(sessionId: string, seq: number, fact: UndoFact): UndoResult {
  if (fact.conflicts.length > 0) throw refuse('UNDO_CONFLICT', { turn: fact.turn, conflicts: fact.conflicts })
  return { sessionId, turn: fact.turn, seq, restored: fact.restored, failed: fact.failed, conflicts: [] }
}
