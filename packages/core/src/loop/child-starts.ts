import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type {
  ChildAgentHandle,
  ChildAgentSessionService,
  ChildAgentSessionStartOptions,
  LoopChildrenPort,
  LoopChildStartStatus,
} from '@agnes/extension-api'
import type { SessionImpl } from '../step/session.js'

const EVENT = 'x/core/loop-child-start'
type Start = {
  invocationId: string
  fingerprint: string
  task: string
  options: Omit<ChildAgentSessionStartOptions, 'signal'>
  childId?: string
  providerId?: string
}

/** The receipt belongs to Core; provider adoption must never create a replacement child. */
export function loopChildStarts(s: SessionImpl, children: ChildAgentSessionService): LoopChildrenPort {
  const handles = new Map<string, ChildAgentHandle>()
  const active = new Set<string>()
  async function read(id: string): Promise<Start | undefined> {
    if (!id || id.length > 256) throw new CoreError('E_ENVELOPE', 'Invalid child invocationId')
    return (
      await scanAll((q) => s.d.log.scan(q), {
        type: EVENT,
        lane: s.lane,
        fromSeq: (s.d.log.parent?.boundarySeq ?? 0) + 1,
        toSeq: s.lastSeq,
      })
    )
      .reverse()
      .map((row) => row.data as unknown as Start)
      .find((row) => row.invocationId === id)
  }
  async function record(row: Start) {
    await s.d.log.append([s.ev(EVENT, row, { ignorable: true })])
  }
  async function adopt(id: string, signal: AbortSignal) {
    const row = await read(id)
    if (!row) throw new CoreError('E_RELATION', 'Child start invocation is missing')
    const cached = handles.get(id)
    if (cached) return cached
    if (!children.adoptStart)
      throw new CoreError('E_UNSUPPORTED', 'Child provider cannot adopt this invocation')
    signal = AbortSignal.any([signal, s.ac.signal])
    signal.throwIfAborted()
    const handle = await children.adoptStart(row.task, {
      ...row.options,
      invocationId: id,
      signal,
      ...(row.providerId ? { providerId: row.providerId } : {}),
    })
    if (row.childId && (row.childId !== handle.id || row.providerId !== handle.providerId)) {
      await handle.dispose()
      throw new CoreError('E_RELATION', 'Child adoption changed its recorded identity')
    }
    await record({ ...row, childId: handle.id, providerId: handle.providerId })
    handles.set(id, handle)
    return handle
  }
  async function owned(id: string, work: () => Promise<ChildAgentHandle>) {
    const done = s.beginLoopOperation()
    if (active.has(id)) {
      done()
      throw new CoreError('E_LANE_BUSY', 'Child invocation is active')
    }
    active.add(id)
    try {
      return await work()
    } finally {
      active.delete(id)
      done()
    }
  }
  return {
    ...children,
    async start(task, options = {}) {
      const id = options.invocationId ?? s.d.ids.effectId()
      return owned(id, async () => {
        const { signal: supplied, ...saved } = options
        const signal = supplied ? AbortSignal.any([s.ac.signal, supplied]) : s.ac.signal
        signal.throwIfAborted()
        const fingerprint = sha256Hex(canonicalJson({ task, options: saved }))
        const previous = await read(id)
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new CoreError('E_RELATION', 'Child invocationId was reused for another start')
          return adopt(id, signal)
        }
        const row: Start = { invocationId: id, task, options: saved, fingerprint }
        await record(row)
        const handle = await children.start(task, { ...options, invocationId: id, signal })
        await record({ ...row, childId: handle.id, providerId: handle.providerId })
        handles.set(id, handle)
        return handle
      })
    },
    async status(id): Promise<LoopChildStartStatus> {
      const row = await read(id)
      return row?.childId && row.providerId
        ? { status: 'responded', invocationId: id, childId: row.childId, providerId: row.providerId }
        : { status: row ? 'may-have-sent' : 'not-sent', invocationId: id }
    },
    adopt: (id, signal) => owned(id, () => adopt(id, signal)),
  }
}
