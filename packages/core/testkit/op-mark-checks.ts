// Checks a recording against what an op-mark row is for, written apart from the code that builds
// one: a mark exactly where a commit has no row of its own, on the lane whose counter moved, naming
// the phase that counter entered, the stop request when this is the transition that records it,
// and only the calls whose status or dispatch bookkeeping changed.
import type { RecordedCommit } from './record-transitions.js'

type Op = {
  control: { status: string; by?: unknown; requestedAt?: string }
  phase: { kind: string; batch?: { calls: Array<Record<string, unknown>> } }
} | null
type Mark = {
  type: string
  lane?: string
  seq: number
  data: { phase: string | null; control?: string; by?: unknown; requestedAt?: string; calls?: unknown[] }
}

const TRACKED = ['status', 'dispatchPhase', 'dispatchAttempt'] as const

/** Every way a recording's op-mark rows disagree with the transitions they stand in for. */
export function opMarkProblems(commits: RecordedCommit[]): string[] {
  const problems: string[] = []
  const cells = new Map<string, Op>()
  commits.forEach((commit, index) => {
    const rows = commit.events as Mark[]
    const marks = rows.filter((row) => row.type === 'x/core/op-mark')
    const others = rows.length - marks.length
    const at = `commit ${index}`
    if (rows.some((row) => row.type === 'session/start' && (row.data as { parent?: unknown }).parent))
      cells.clear()
    if (others > 0 && marks.length > 0) problems.push(`${at}: op-mark beside ${others} other rows`)
    if (others === 0 && marks.length !== 1)
      problems.push(`${at}: ${marks.length} op-marks in an empty transition`)
    const write = commit.op[0]
    for (const mark of marks) {
      if (!write) {
        problems.push(`${at}: op-mark without a program-counter write`)
        continue
      }
      const prev = cells.get(write.lane) ?? null
      const next = write.data as Op
      if (mark.lane !== write.lane) problems.push(`${at}: op-mark lane ${mark.lane} ≠ ${write.lane}`)
      if (mark.seq !== rows.at(-1)?.seq) problems.push(`${at}: op-mark is not the commit's last row`)
      if (mark.data.phase !== (next?.phase.kind ?? null))
        problems.push(`${at}: op-mark phase ${mark.data.phase} ≠ ${next?.phase.kind ?? null}`)
      const cancels =
        next?.control.status === 'cancel_requested' && prev?.control.status !== 'cancel_requested'
      if (cancels !== (mark.data.control === 'cancel_requested'))
        problems.push(`${at}: op-mark control ${String(mark.data.control)} for a stop request ${cancels}`)
      if (cancels && (mark.data.by === undefined || mark.data.requestedAt !== next?.control.requestedAt))
        problems.push(`${at}: op-mark stop request lacks who or when`)
      const changed: string[] = []
      if (prev?.phase.kind === 'tools' && next?.phase.kind === 'tools') {
        const before = new Map((prev.phase.batch?.calls ?? []).map((call) => [call.toolUseId, call]))
        for (const call of next.phase.batch?.calls ?? []) {
          const was = before.get(call.toolUseId)
          if (!was || TRACKED.some((field) => was[field] !== call[field]))
            changed.push(String(call.toolUseId))
        }
      }
      const named = (mark.data.calls ?? []).map((call) => String((call as { toolUseId: unknown }).toolUseId))
      if (named.join(',') !== changed.join(','))
        problems.push(`${at}: op-mark names calls [${named}] where [${changed}] changed`)
    }
    for (const w of commit.op) cells.set(w.lane, w.data as Op)
  })
  return problems
}
