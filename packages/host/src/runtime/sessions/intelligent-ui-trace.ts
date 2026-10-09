import type { EventEnvelope, UISpan, UITurn } from '@agnes/protocol'
import type { HostSession } from '../lifecycle/host.js'

const prefix = 'x/agnes/intelligent-ui/'
const types = [
  'surface.opened',
  'surface.updated',
  'surface.closed',
  ...['received', 'rejected', 'executing', 'pending-approval', 'succeeded', 'failed'].map(
    (state) => `action.${state}`,
  ),
].map((name) => prefix + name)

/** Prefer recorded task ownership; bounded partial history falls back only to a containing turn. */
export function appendUiTrace(turns: readonly UITurn[], rows: readonly EventEnvelope[]): UITurn[] {
  const taskBySeq = new Map<number, number>(),
    taskByCommand = new Map<string, number>()
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    const data = row.data as unknown as {
      record?: { taskId?: string; request?: { commandId: string } }
      commandId?: string
      sourceSeq?: number
    }
    const task =
      Number(data.record?.taskId?.match(/:turn:(\d+)$/)?.[1]) ||
      (data.sourceSeq ? taskBySeq.get(data.sourceSeq) : undefined) ||
      taskByCommand.get(data.commandId ?? '')
    if (task) {
      taskBySeq.set(row.seq, task)
      if (data.record?.request) taskByCommand.set(data.record.request.commandId, task)
    }
  }
  return turns.map((turn) => {
    if (!turn.trace) return turn
    const spans: UISpan[] = rows
      .filter(
        (row) =>
          row.origin === 'ext:agnes/intelligent-ui' &&
          types.includes(row.type) &&
          (taskBySeq.has(row.seq)
            ? taskBySeq.get(row.seq) === turn.turn
            : row.seq >= turn.startSeq && (turn.endSeq === undefined || row.seq <= turn.endSeq)),
      )
      .map((row) => {
        const data = row.data as unknown as {
          record?: { surface?: { title: string; revision: number }; receipt?: { revision: number } }
          receipt?: { revision: number }
        }
        const state = row.type.slice(prefix.length)
        const revision =
          data.record?.surface?.revision ?? data.record?.receipt?.revision ?? data.receipt?.revision
        return {
          id: `ui-fact:${row.seq}`,
          kind: 'other',
          name: `${state} · r${revision ?? '?'}${data.record?.surface ? ' · ' + data.record.surface.title : ''}`.slice(
            0,
            256,
          ),
          status:
            state.endsWith('failed') || state.endsWith('rejected')
              ? 'failed'
              : state.endsWith('pending-approval')
                ? 'waiting'
                : 'completed',
          startSeq: row.seq,
          endSeq: row.seq,
          startedAt: row.ts,
          endedAt: row.ts,
          durationMs: 0,
          children: [],
        }
      })
    return spans.length
      ? { ...turn, trace: { ...turn.trace, children: [...turn.trace.children, ...spans] } }
      : turn
  })
}

/** Decorate public projections outside Core, with a bounded read and no queue mutation. */
export function attachIntelligentUiTrace(session: HostSession, enabled: () => boolean) {
  const rows = (upto: number) =>
    enabled()
      ? session.scan({ type: types, lane: session.lane, toSeq: upto, order: 'desc', limit: 64 })
      : Promise.resolve([])
  const project = session.projectUI.bind(session)
  session.projectUI = async (...args) => {
    const result = await project(...args)
    return { ...result, turns: appendUiTrace(result.turns, await rows(result.upto)) }
  }
  const opening = session.projectUIOpening.bind(session)
  session.projectUIOpening = async (...args) => {
    const result = await opening(...args)
    const decorated = {
      ...result,
      timeline: {
        ...result.timeline,
        turns: appendUiTrace(result.timeline.turns, await rows(result.timeline.upto)),
      },
    }
    return args[0]?.maxBytes &&
      new TextEncoder().encode(JSON.stringify(decorated.timeline)).byteLength > args[0].maxBytes
      ? result
      : decorated
  }
  const history = session.projectUIHistory.bind(session)
  session.projectUIHistory = async (...args) => {
    const result = await history(...args)
    const decorated = { ...result, turns: appendUiTrace(result.turns, await rows(result.cut)) }
    return args[2]?.maxBytes &&
      new TextEncoder().encode(JSON.stringify(decorated)).byteLength > args[2].maxBytes
      ? result
      : decorated
  }
  const patch = session.projectUIPatch.bind(session)
  session.projectUIPatch = async (...args) => {
    const result = await patch(...args)
    if (result.kind === 'replace')
      return {
        ...result,
        timeline: {
          ...result.timeline,
          turns: appendUiTrace(result.timeline.turns, await rows(result.timeline.upto)),
        },
      }
    const facts = await rows(result.patch.upto)
    if (!facts.length) return result
    const timeline = await project(result.patch.upto, args[2])
    const changed = new Set(
      result.patch.turnChanges.map((change) => (change.op === 'remove' ? change.id : change.turn.id)),
    )
    return {
      ...result,
      patch: {
        ...result.patch,
        turnChanges: [
          ...result.patch.turnChanges.map((change) =>
            change.op === 'upsert' ? { ...change, turn: appendUiTrace([change.turn], facts)[0]! } : change,
          ),
          ...appendUiTrace(timeline.turns, facts)
            .filter(
              (turn) =>
                !changed.has(turn.id) &&
                turn.trace?.children.some(
                  (span) => span.id.startsWith('ui-fact:') && span.startSeq > args[0],
                ),
            )
            .map((turn) => ({
              op: 'upsert' as const,
              index: timeline.turns.findIndex((item) => item.id === turn.id),
              turn,
            })),
        ],
      },
    }
  }
}
