import type { ContentBlock, LoopSelection, TurnEndReason } from '@agnes/protocol'
import type { Client } from './client.js'
import type { LedgerEvent, Session, TurnResult } from './session.js'

export type HeadlessTokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}
export type HeadlessTurnMetrics = {
  turn: number
  lane: string | null
  reason: TurnEndReason
  durationMs: number | null
  toolCalls: number
  /** Null means no cost/ledger usage was observed, rather than zero usage. */
  tokens: HeadlessTokens | null
  usageRecords: number
}
export type HeadlessResult = {
  sessionId: string
  reason: TurnEndReason | 'failed'
  lastSeq: number
  eventsComplete: boolean
  error?: string
}
/** JSONL envelope v1. Ledger payloads retain their own protocol schema. */
export type HeadlessRecord = { schemaVersion: 1; runId: string; sessionId: string } & (
  | { type: 'start' }
  | { type: 'event'; event: LedgerEvent }
  | { type: 'turn-metrics'; metrics: HeadlessTurnMetrics }
  | ({ type: 'result' } & Omit<HeadlessResult, 'sessionId'>)
)
export type HeadlessSessionPort = Pick<
  Session,
  | 'id'
  | 'lastServerSeq'
  | 'attach'
  | 'detach'
  | 'events'
  | 'prompt'
  | 'cancel'
  | 'setModel'
  | 'onPermissionRequest'
>
export type HeadlessClientPort = {
  createSession(options: Parameters<Client['createSession']>[0]): Promise<HeadlessSessionPort>
}
export type HeadlessOptions = {
  cwd: string
  input: string | ContentBlock[]
  preset?: string
  loop?: LoopSelection
  model?: Parameters<Session['setModel']>[0]
  runId?: string
  signal?: AbortSignal
  /** Awaited in stream order; rejection cancels the turn and rejects the run. */
  write(record: HeadlessRecord): void | Promise<void>
  /** Bound the wait for ledger notifications after the prompt RPC settles. Default: 1000ms. */
  drainMs?: number
}

type OpenTurn = {
  turn: number
  start: number
  toolCalls: number
  tokens: HeadlessTokens
  usageRecords: number
}
const dataObject = (event: LedgerEvent): Record<string, unknown> =>
  event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {}

/** Fresh session, no UI or auto-approval. The caller retains ownership of the client. */
export async function runHeadless(
  client: HeadlessClientPort,
  options: HeadlessOptions,
): Promise<HeadlessResult> {
  options.signal?.throwIfAborted()
  const drainMs = options.drainMs ?? 1000
  if (!Number.isFinite(drainMs) || drainMs < 0) throw new Error('invalid headless drainMs')
  const runId = options.runId ?? globalThis.crypto.randomUUID()
  const session = await client.createSession({
    cwd: options.cwd,
    sessionKey: `agnes:headless:${globalThis.crypto.randomUUID()}`,
    ...(options.preset ? { preset: options.preset } : {}),
    ...(options.loop ? { loop: options.loop } : {}),
  })
  // Explicitly deny permission requests: an unattended consumer cannot grant authority.
  const offPermission = session.onPermissionRequest(async () => ({ verdict: 'rejected' }))
  let iterator: AsyncIterator<LedgerEvent> | undefined
  let collecting: Promise<void> | undefined
  let streamError: unknown
  let stopping = false
  let processedSeq = 0
  let targetSeq: number | undefined
  let reached!: () => void
  const caughtUp = new Promise<void>((resolve) => {
    reached = resolve
  })
  let terminal: TurnEndReason | undefined
  const turns = new Map<string, OpenTurn>()
  try {
    if (options.model) await session.setModel(options.model)
    await session.attach({ filter: { acpUpdates: false } })
    const watermark = session.lastServerSeq
    processedSeq = watermark
    await options.write({ schemaVersion: 1, runId, sessionId: session.id, type: 'start' })
    // Register synchronously before prompt: even a fast in-process turn must be observable.
    iterator = session.events()[Symbol.asyncIterator]()
    collecting = (async () => {
      for (;;) {
        const row = await iterator!.next()
        if (row.done || stopping) break
        const event = row.value
        if (event.seq <= watermark) continue
        await options.write({ schemaVersion: 1, runId, sessionId: session.id, type: 'event', event })
        const data = dataObject(event)
        const lane = event.lane ?? ''
        if (event.type === 'turn/start' && typeof data.turn === 'number') {
          turns.set(lane, {
            turn: data.turn,
            start: Date.parse(event.ts),
            toolCalls: 0,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            usageRecords: 0,
          })
        }
        const turn = turns.get(lane)
        if (turn && event.type === 'tool/call') turn.toolCalls++
        if (
          turn &&
          event.type === 'cost/ledger' &&
          !data.adjustment &&
          (data.sourceTurn === undefined || data.sourceTurn === turn.turn) &&
          data.tokens &&
          typeof data.tokens === 'object'
        ) {
          const tokens = data.tokens as Record<string, unknown>
          for (const key of Object.keys(turn.tokens) as (keyof HeadlessTokens)[]) {
            if (typeof tokens[key] === 'number') turn.tokens[key] += tokens[key]
          }
          turn.usageRecords++
        }
        if (event.type === 'turn/end') {
          const reason = data.reason as TurnEndReason
          if (!event.lane || event.lane === 'main') terminal = reason
          if (turn) {
            const end = Date.parse(event.ts)
            const metrics: HeadlessTurnMetrics = {
              turn: turn.turn,
              lane: event.lane ?? null,
              reason,
              durationMs: Number.isFinite(end - turn.start) ? Math.max(0, end - turn.start) : null,
              toolCalls: turn.toolCalls,
              tokens: turn.usageRecords ? turn.tokens : null,
              usageRecords: turn.usageRecords,
            }
            await options.write({
              schemaVersion: 1,
              runId,
              sessionId: session.id,
              type: 'turn-metrics',
              metrics,
            })
            turns.delete(lane)
          }
        }
        processedSeq = Math.max(processedSeq, event.seq)
        if (terminal !== undefined && targetSeq !== undefined && processedSeq >= targetSeq) reached()
      }
    })().catch(async (error: unknown) => {
      streamError = error
      reached()
      await session.cancel().catch(() => undefined)
    })
    let result: TurnResult | undefined
    let promptError: unknown
    try {
      options.signal?.throwIfAborted()
      result = await session.prompt(options.input, options.signal ? { signal: options.signal } : {})
    } catch (error) {
      promptError = error
    }
    targetSeq = result?.lastSeq ?? session.lastServerSeq
    if (terminal === undefined || processedSeq < targetSeq) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          caughtUp,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, drainMs)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    stopping = true
    await iterator.return?.()
    await collecting
    if (streamError !== undefined) throw streamError
    const outcome: HeadlessResult = {
      sessionId: session.id,
      reason: terminal ?? result?.reason ?? 'failed',
      lastSeq: processedSeq,
      eventsComplete: terminal !== undefined && processedSeq >= targetSeq,
      ...(promptError !== undefined
        ? { error: promptError instanceof Error ? promptError.message : String(promptError) }
        : {}),
    }
    await options.write({ schemaVersion: 1, runId, type: 'result', ...outcome })
    return outcome
  } finally {
    stopping = true
    await iterator?.return?.()
    await collecting
    offPermission()
    await session.detach()
  }
}
