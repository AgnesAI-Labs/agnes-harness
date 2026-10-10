import type {
  ComparisonCancelParams,
  ComparisonCreateParams,
  ComparisonSnapshot,
  ComparisonSubmitParams,
} from '@agnes/protocol'
import { createComparison } from './create.js'
import {
  type ComparisonClock,
  type ComparisonPorts,
  comparisonInputCancelled,
  type Receipt,
  type RoundRecord,
  type RunRecord,
  type RunTiming,
  type SessionObservation,
  type SessionPort,
  SIDES,
  type Side,
  type TerminalCause,
} from './ports.js'
import {
  admissionFailureReason,
  assertComparisonActive,
  ComparisonError,
  canonical,
  read,
  snapshot,
  terminal,
  update,
  validateObservation,
} from './state.js'

function receipt(value: Receipt): Receipt {
  if (value.status === 'accepted' && (!Number.isSafeInteger(value.seq) || value.seq < 0))
    throw new ComparisonError('INVALID_RECEIPT', 'Invalid input acceptance sequence')
  return structuredClone(value)
}
const uncertain = {
  code: 'TRANSPORT_UNKNOWN',
  message: 'Operation outcome is unknown; inspect its durable receipt before continuing',
}
function iso(epochMs: number): string | undefined {
  if (!Number.isFinite(epochMs)) return undefined
  const value = new Date(epochMs)
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
}
function clockSample(clock: ComparisonClock): { startedAt: string; monotonicStart: number } | undefined {
  const startedAt = iso(clock.now())
  const monotonicStart = clock.monotonic()
  return startedAt === undefined || !Number.isFinite(monotonicStart)
    ? undefined
    : { startedAt, monotonicStart }
}
function confirmedElapsed(
  clock: ComparisonClock,
  monotonicStart: number,
): { finishedAt: string; elapsedMs: number } | undefined {
  const finishedAt = iso(clock.now())
  const elapsedMs = Math.floor(clock.monotonic() - monotonicStart)
  if (finishedAt === undefined || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) return undefined
  return { finishedAt, elapsedMs }
}
function keepTiming(run: RunRecord): { timing: RunTiming } | Record<string, never> {
  return run.timing === undefined ? {} : { timing: run.timing }
}
function keepSeq(run: RunRecord): { terminalSeq: number } | Record<string, never> {
  return run.terminalSeq === undefined ? {} : { terminalSeq: run.terminalSeq }
}

export class ComparisonCoordinator {
  private readonly pending = new Set<Promise<void>>()
  private readonly backgroundErrors: unknown[] = []
  constructor(private readonly ports: ComparisonPorts) {}

  create(params: ComparisonCreateParams): Promise<ComparisonSnapshot> {
    return createComparison(this.ports, params)
  }
  async get(id: string): Promise<ComparisonSnapshot> {
    return snapshot(await read(this.ports.store, id))
  }
  /** Wait for work already dispatched here; storage errors are surfaced instead of becoming unhandled rejections. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending])
    if (this.backgroundErrors.length > 0)
      throw new AggregateError(this.backgroundErrors.splice(0), 'Comparison background persistence failed')
  }
  private track(work: Promise<void>): void {
    const tracked = work
      .catch((error) => {
        this.backgroundErrors.push(error)
      })
      .finally(() => {
        this.pending.delete(tracked)
      })
    this.pending.add(tracked)
  }

  async submit(params: ComparisonSubmitParams): Promise<ComparisonSnapshot> {
    const content = JSON.parse(canonical(params.content)) as ComparisonSubmitParams['content']
    const payload = canonical(content)
    // The durable reservation winner alone may enqueue. CAS retries must not repeat side effects.
    for (let attempt = 0; attempt < 32; attempt++) {
      const current = await read(this.ports.store, params.id)
      assertComparisonActive(current, { id: params.id, inputId: params.inputId })
      const previous = current.rounds.find((round) => round.inputId === params.inputId)
      if (previous !== undefined) {
        if (
          previous.payload !== payload ||
          (params.permissionMode !== undefined && params.permissionMode !== previous.permissionMode) ||
          (params.decisionBackend ?? undefined) !== (previous.decisionBackend ?? undefined)
        )
          throw new ComparisonError(
            'IDEMPOTENCY_CONFLICT',
            'Input identity is bound to different content or mode',
          )
        return snapshot(current)
      }
      if (comparisonInputCancelled(current, params.inputId))
        throw new ComparisonError('COMPARISON_NOT_READY', 'Input has a permanent cancellation fence', {
          id: params.id,
          inputId: params.inputId,
        })
      if (current.creation !== 'ready')
        throw new ComparisonError('COMPARISON_NOT_READY', 'Comparison is not ready', {
          id: params.id,
          inputId: params.inputId,
        })
      if (
        current.rounds.some(
          (round) => !terminal(round) || SIDES.some((side) => round.acceptances[side].status === 'unknown'),
        )
      )
        throw new ComparisonError('COMPARISON_BUSY', 'A previous input still has unsettled or unknown work', {
          id: params.id,
          inputId: params.inputId,
        })
      let admission: Awaited<ReturnType<NonNullable<SessionPort['admit']>>> | undefined
      const permissionMode = params.permissionMode ?? current.permissionMode ?? 'workspace'
      try {
        if (permissionMode === 'full' && !this.ports.sessions.admit)
          throw new Error('Automatic approval requires configuration admission')
        admission = await this.ports.sessions.admit?.({
          comparisonId: params.id,
          inputId: params.inputId,
          content: structuredClone(content),
          lanes: { left: current.lanes.left!, right: current.lanes.right! },
          prepared: current.prepared ?? {},
          permissionMode,
          ...(params.decisionBackend === undefined ? {} : { decisionBackend: params.decisionBackend }),
        })
      } catch (error) {
        throw new ComparisonError('COMPARISON_NOT_READY', 'Common configuration admission unavailable', {
          id: params.id,
          inputId: params.inputId,
          admissionReason: admissionFailureReason(error),
        })
      }
      const next = structuredClone(current)
      const round: RoundRecord = {
        inputId: params.inputId,
        payload,
        permissionMode,
        ...(params.decisionBackend === undefined ? {} : { decisionBackend: params.decisionBackend }),
        ...(admission?.prepared ? { prepared: structuredClone(admission.prepared) } : {}),
        acceptances: {
          left: { side: 'left', sessionId: current.lanes.left!.sessionId, status: 'unknown' },
          right: { side: 'right', sessionId: current.lanes.right!.sessionId, status: 'unknown' },
        },
        runs: { left: { status: 'reserved' }, right: { status: 'reserved' } },
      }
      next.rounds.push(round)
      next.permissionMode = permissionMode
      next.cancellation = {}
      next.revision++
      let reserved: boolean
      try {
        reserved = await this.ports.store.compareAndSwap(params.id, current.revision, next)
      } catch (error) {
        await admission?.release().catch(() => undefined)
        throw error
      }
      if (!reserved) {
        await admission?.release()
        continue
      }
      const results = await Promise.allSettled(
        SIDES.map(async (side) =>
          receipt(
            admission
              ? await admission.enqueue(side)
              : await this.ports.sessions.enqueue({
                  comparisonId: params.id,
                  side,
                  sessionId: next.lanes[side]!.sessionId,
                  inputId: params.inputId,
                  content: structuredClone(content),
                  ...(next.lanes[side]!.runtime ? { runtime: next.lanes[side]!.runtime.id } : {}),
                  ...(params.decisionBackend === undefined
                    ? {}
                    : { decisionBackend: structuredClone(params.decisionBackend) }),
                }),
          ),
        ),
      )
      const accepted = await update(this.ports.store, params.id, (record) => {
        const saved = record.rounds.find((item) => item.inputId === params.inputId)!
        for (const [index, side] of SIDES.entries()) {
          const result = results[index]!
          const value: Receipt =
            result.status === 'fulfilled' ? result.value : { status: 'unknown', error: uncertain }
          saved.acceptances[side] = { side, sessionId: record.lanes[side]!.sessionId, ...value }
          if (value.status === 'accepted')
            record.lanes[side]!.lastSeq = Math.max(record.lanes[side]!.lastSeq, value.seq)
          // Cancellation may settle queued input before its admission reply reaches this coordinator.
          if (saved.runs[side].status !== 'settled')
            saved.runs[side] =
              value.status === 'rejected'
                ? { status: 'skipped', terminalCause: 'failed' }
                : {
                    status: value.status === 'accepted' ? 'reserved' : 'unknown',
                  }
        }
      })
      // New capabilities remain held across enqueue and the durable receipts. No lane dispatches
      // if a receipt or the common final owner check is uncertain.
      if (admission) {
        try {
          if (SIDES.some((side) => accepted.rounds.at(-1)!.acceptances[side].status !== 'accepted'))
            throw new Error('input receipt is not confirmed')
          await admission.ready()
        } catch {
          await admission.release().catch(() => undefined)
          const stopped = await update(this.ports.store, params.id, (record) => {
            const saved = record.rounds.find((round) => round.inputId === params.inputId)!
            for (const side of SIDES)
              if (saved.runs[side].status === 'reserved')
                saved.runs[side] = { status: 'unknown', error: uncertain }
          })
          return snapshot(stopped)
        }
      }
      for (const side of SIDES)
        if (accepted.rounds.at(-1)!.acceptances[side].status === 'accepted')
          this.track(this.run(params.id, params.inputId, side, admission))
      return snapshot(accepted)
    }
    throw new ComparisonError('COMPARISON_BUSY', 'Comparison changed concurrently')
  }

  private async observe(id: string, inputId: string, side: Side, state: SessionObservation): Promise<void> {
    validateObservation(state)
    await update(this.ports.store, id, (record) => {
      const round = record.rounds.find((item) => item.inputId === inputId)!
      const lane = record.lanes[side]!
      if (record.rounds.at(-1)?.inputId === inputId) {
        if (state.lastSeq < lane.lastSeq)
          throw new ComparisonError('STALE_OBSERVATION', 'Session observation moved backwards')
        lane.phase = state.phase
        lane.lastSeq = state.lastSeq
      }
      const run = round.runs[side]
      // Cancellation and reconcile never invent a duration. A known cause stays put.
      if (!state.settled) {
        if (run.status === 'settled') return
        round.runs[side] = { status: 'waiting', ...keepTiming(run), ...keepSeq(run) }
        return
      }
      const observedCause: TerminalCause = state.terminalCause ?? 'unknown'
      const terminalCause =
        run.terminalCause !== undefined && run.terminalCause !== 'unknown' ? run.terminalCause : observedCause
      round.runs[side] = {
        status: 'settled',
        terminalCause,
        ...keepTiming(run),
        terminalSeq: run.terminalSeq ?? state.lastSeq,
      }
    })
  }
  private async run(
    id: string,
    inputId: string,
    side: Side,
    admission?: Awaited<ReturnType<NonNullable<SessionPort['admit']>>>,
  ): Promise<void> {
    let live: { startedAt: string; monotonicStart: number } | undefined
    const reserved = await update(this.ports.store, id, (record) => {
      live = undefined
      assertComparisonActive(record)
      const round = record.rounds.find((item) => item.inputId === inputId)!
      if (comparisonInputCancelled(record, inputId, side) || round.runs[side].status !== 'reserved') return
      live = this.ports.clock === undefined ? undefined : clockSample(this.ports.clock)
      round.runs[side] = {
        status: 'running',
        ...(live === undefined
          ? {}
          : {
              timing: {
                startedAt: live.startedAt,
                finishedAt: null,
                elapsedMs: null,
                terminalConfirmed: false,
              },
            }),
      }
      record.lanes[side]!.phase = 'running'
    })
    if (
      comparisonInputCancelled(reserved, inputId, side) ||
      reserved.rounds.find((round) => round.inputId === inputId)!.runs[side].status !== 'running'
    )
      return
    try {
      const state = admission
        ? await admission.run(side)
        : await this.ports.sessions.run({ sessionId: reserved.lanes[side]!.sessionId, inputId })
      const clock = this.ports.clock
      const confirmed =
        state.settled && live !== undefined && clock !== undefined
          ? confirmedElapsed(clock, live.monotonicStart)
          : undefined
      validateObservation(state)
      await update(this.ports.store, id, (record) => {
        const round = record.rounds.find((item) => item.inputId === inputId)!
        const lane = record.lanes[side]!
        if (record.rounds.at(-1)?.inputId === inputId) {
          if (state.lastSeq < lane.lastSeq)
            throw new ComparisonError('STALE_OBSERVATION', 'Session observation moved backwards')
          lane.phase = state.phase
          lane.lastSeq = state.lastSeq
        }
        const run = round.runs[side]
        if (!state.settled) {
          if (run.status === 'settled') return
          round.runs[side] = { status: 'waiting', ...keepTiming(run), ...keepSeq(run) }
          return
        }
        const observedCause: TerminalCause = state.terminalCause ?? 'unknown'
        const terminalCause =
          run.terminalCause !== undefined && run.terminalCause !== 'unknown'
            ? run.terminalCause
            : observedCause
        const timing =
          run.timing?.terminalConfirmed === true
            ? run.timing
            : confirmed === undefined
              ? run.timing
              : {
                  startedAt: run.timing?.startedAt ?? live!.startedAt,
                  finishedAt: confirmed.finishedAt,
                  elapsedMs: confirmed.elapsedMs,
                  terminalConfirmed: true,
                }
        round.runs[side] = {
          status: 'settled',
          terminalCause,
          ...(timing === undefined ? {} : { timing }),
          terminalSeq: run.terminalSeq ?? state.lastSeq,
        }
      })
    } catch {
      await update(this.ports.store, id, (record) => {
        const round = record.rounds.find((item) => item.inputId === inputId)!
        const run = round.runs[side]
        if (run.status === 'settled') return
        round.runs[side] = {
          status: 'unknown',
          error: uncertain,
          ...keepSeq(run),
          ...(run.timing === undefined
            ? {}
            : {
                timing: {
                  ...run.timing,
                  finishedAt: null,
                  elapsedMs: null,
                  terminalConfirmed: false,
                },
              }),
        }
      })
    }
  }

  async cancel(params: ComparisonCancelParams): Promise<ComparisonSnapshot> {
    const current = await read(this.ports.store, params.id)
    if (current.retirement?.state === 'released' || current.retirement?.state === 'removed')
      return snapshot(current)
    const sides = params.side === undefined ? SIDES : [params.side]
    const inputId = params.inputId ?? current.rounds.at(-1)?.inputId
    const reserved = await update(this.ports.store, params.id, (record) => {
      if (record.creation !== 'ready')
        throw new ComparisonError('COMPARISON_NOT_READY', 'Comparison is not ready')
      if (inputId !== undefined) {
        record.inputCancellations ??= []
        let cancellation = record.inputCancellations.find((value) => value.inputId === inputId)
        if (!cancellation) {
          cancellation = { inputId, sides: {} }
          record.inputCancellations.push(cancellation)
        }
        for (const side of sides)
          if (cancellation.sides[side] !== 'acknowledged') cancellation.sides[side] = 'requested'
      }
      if (inputId === record.rounds.at(-1)?.inputId)
        for (const side of sides) record.cancellation[side] = 'requested'
    })
    const results = await Promise.allSettled(
      sides.map(async (side) => {
        const lane = reserved.lanes[side]
        if (lane === undefined) throw new ComparisonError('COMPARISON_NOT_READY', 'Session is not prepared')
        return this.ports.sessions.cancel({
          sessionId: lane.sessionId,
          ...(inputId === undefined ? {} : { inputId }),
          ...(params.inputId === undefined ? {} : { exactInput: true }),
        })
      }),
    )
    await update(this.ports.store, params.id, (record) => {
      for (const [index, side] of sides.entries()) {
        const result = results[index]!
        const acknowledged =
          result.status === 'fulfilled' &&
          (result.value === undefined ? params.inputId === undefined : result.value.settled === true)
        const status = acknowledged ? 'acknowledged' : 'unknown'
        const cancellation = record.inputCancellations?.find((value) => value.inputId === inputId)
        if (cancellation && cancellation.sides[side] !== 'acknowledged') cancellation.sides[side] = status
        if (inputId === record.rounds.at(-1)?.inputId) record.cancellation[side] = status
      }
    })
    if (inputId !== undefined && reserved.rounds.some((round) => round.inputId === inputId))
      await Promise.all(
        results.map(async (result, index) => {
          if (result.status === 'fulfilled' && result.value !== undefined)
            await this.observe(params.id, inputId, sides[index]!, result.value)
        }),
      )
    return this.get(params.id)
  }

  /** Explicit backend recovery operation; get() never calls it. Never retransmits uncertain input or execution. */
  async reconcile(id: string): Promise<ComparisonSnapshot> {
    const current = await read(this.ports.store, id)
    if (current.retirement !== undefined && current.retirement.state !== 'full') return snapshot(current)
    for (const cancellation of current.inputCancellations ?? [])
      await Promise.all(
        SIDES.map(async (side) => {
          if (cancellation.sides[side] === undefined || cancellation.sides[side] === 'acknowledged') return
          const lane = current.lanes[side]
          if (!lane) return
          const found = await this.ports.sessions.inspect({
            sessionId: lane.sessionId,
            inputId: cancellation.inputId,
          })
          if (found.cancellation !== 'acknowledged') return
          await update(this.ports.store, id, (record) => {
            const saved = record.inputCancellations?.find((value) => value.inputId === cancellation.inputId)
            if (saved?.sides[side] === undefined) return
            saved.sides[side] = 'acknowledged'
            if (record.rounds.at(-1)?.inputId === cancellation.inputId)
              record.cancellation[side] = 'acknowledged'
          })
        }),
      )
    for (const round of current.rounds)
      await Promise.all(
        SIDES.map(async (side) => {
          const lane = current.lanes[side]
          if (lane === undefined || ['settled', 'skipped'].includes(round.runs[side].status)) return
          const found = await this.ports.sessions.inspect({
            sessionId: lane.sessionId,
            inputId: round.inputId,
          })
          if (found.receipt !== undefined) {
            const value = receipt(found.receipt)
            await update(this.ports.store, id, (record) => {
              const saved = record.rounds.find((item) => item.inputId === round.inputId)!
              const before = saved.acceptances[side]
              if (before.status !== 'unknown' && value.status === 'unknown') return
              if (
                before.status !== 'unknown' &&
                canonical(before) !== canonical({ side, sessionId: lane.sessionId, ...value })
              )
                throw new ComparisonError(
                  'RECEIPT_CONFLICT',
                  'Session receipt conflicts with recorded acceptance',
                )
              saved.acceptances[side] = { side, sessionId: lane.sessionId, ...value }
              if (value.status === 'accepted')
                record.lanes[side]!.lastSeq = Math.max(record.lanes[side]!.lastSeq, value.seq)
              if (value.status === 'rejected')
                saved.runs[side] = { status: 'skipped', terminalCause: 'failed' }
              else if (value.status === 'accepted' && saved.runs[side].status === 'reserved')
                saved.runs[side] = { status: 'unknown' }
            })
          }
          if (found.state !== undefined && found.receipt?.status !== 'rejected') {
            const latest = await read(this.ports.store, id)
            if (
              latest.rounds.find((item) => item.inputId === round.inputId)!.acceptances[side].status ===
              'accepted'
            )
              await this.observe(id, round.inputId, side, found.state)
          }
        }),
      )
    return this.get(id)
  }
}
