import { createHash } from 'node:crypto'
import type { ManagedInputResult } from '@agnes/extension-api'
import { rpcError } from '@agnes/protocol'
import type { OwnerInputEngineDeps } from './managed-input-admission.js'
import type { ManagedInputChange, ManagedInputRow } from './managed-session-inputs.js'
import { detached, type ManagedSessionRecord } from './managed-session-records.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** `consumed` and `retained` never move again, whoever asks. */
const FINAL = new Set(['consumed', 'retained'])

/**
 * `submitted_seq` 0 marks a submission begun but not confirmed: a crash may have left the input in
 * the core inbox or not. Such a row counts as in flight, and only a sweep resubmits it, deduplicated.
 */
const UNCONFIRMED = 0

export const sessionLane = (sessionId: string) => `session\0${sessionId}`

export function inputCommandBase(actorId: string, owner: string, sessionId: string, key: string): string {
  return `${actorId}:input:${digest(`${owner}\0${sessionId}\0${key}`).slice(0, 32)}`
}

export function projectInput(row: ManagedInputRow): ManagedInputResult {
  const fields = {
    inputId: row.key,
    version: row.version,
    reason: row.reason,
    reviewLocation: `/?session=${encodeURIComponent(row.sessionId)}&ownerInput=${encodeURIComponent(row.key)}`,
  }
  if (row.state === 'consumed')
    return { state: 'consumed', ...fields, turn: row.consumedTurn ?? 0, seq: row.consumedSeq ?? 0 }
  return { state: row.state, ...fields }
}

/** `idle`: an idle report; `result`: a caller asking (inputResult, a repeated admission, a deliver); `sweep`: startup and the slow sweep. */
export type AdvanceMode = 'idle' | 'result' | 'sweep'

const rejected = (code: string) => rpcError('SEMANTIC_REJECTED', { code })

/**
 * Moving held inputs on: submit to an idle session after the checks pass, find the turn that took a
 * submitted one, take inputs back on revoke, and apply the owner's decision. Callers hold the
 * session's lane (`sessionLane`) around every `*Now` function.
 */
export function inputProgress(deps: OwnerInputEngineDeps) {
  const { ports, inputs } = deps
  const move = (row: ManagedInputRow, next: ManagedInputChange, by: 'platform' | 'owner' = 'platform') =>
    FINAL.has(row.state)
      ? undefined
      : inputs.transition(row.owner, row.sessionId, row.key, row.version, next, by)
  const busy = async (sessionId: string) =>
    (await ports.sessions.activity()).some(
      (item) => item.sessionId === sessionId && (item.state === 'running' || item.state === 'waiting'),
    )
  // An unreadable question state holds the input rather than risk a turn answering the question.
  const questionOpen = async (sessionId: string) =>
    (await ports.sessions.openQuestion?.(sessionId).catch(() => true)) === true
  const archived = (record: ManagedSessionRecord) =>
    record.archived || ports.sessions.archived(record.sessionId)
  const enabled = (owner: string) => deps.enabled?.(owner).catch(() => false) ?? Promise.resolve(true)

  /** The turn that took a submitted input; the scan starts at the seq the submission returned. */
  const settle = async (row: ManagedInputRow): Promise<ManagedInputRow> => {
    if (row.itemCommandId === null || row.submittedSeq === null) return row
    const found = await ports.sessions.findUserMessage(
      row.sessionId,
      row.itemCommandId,
      Math.max(1, row.submittedSeq),
    )
    if (!found) return row
    return (
      move(row, {
        state: 'consumed',
        reason: 'eligible',
        consumedTurn: found.turn,
        consumedSeq: found.seq,
      }) ?? row
    )
  }

  /** A fresh submission. After a withdrawal the core inbox still knows the old id, so a new one is minted. */
  const submit = async (row: ManagedInputRow, record: ManagedSessionRecord) => {
    if (row.text === null) {
      move(row, { state: 'needsOwner', reason: 'receiptUnknown' })
      return
    }
    const actor = deps.actor(row.actorOwner, record)
    const base = inputCommandBase(actor.id, row.owner, row.sessionId, row.key)
    const commandId = row.itemCommandId === null ? base : `${base}:v${row.version + 1}`
    const marked = move(row, {
      state: 'enqueued',
      reason: 'eligible',
      itemCommandId: commandId,
      submittedSeq: UNCONFIRMED,
    })
    if (!marked) return
    const outcome = await ports.sessions.submitInput(row.sessionId, {
      text: row.text,
      actor,
      commandId,
      dedupe: false,
    })
    deps.faults?.afterSubmit?.()
    // Busy is definite: nothing was queued, so the row is held again.
    if (outcome.state === 'busy') move(marked, { state: 'enqueued', reason: 'busy', submittedSeq: null })
    else move(marked, { state: 'enqueued', reason: 'eligible', submittedSeq: outcome.seq })
  }

  /** Sweeps only: starts a turn for an input a restart left queued; core finds it by id and queues nothing new. */
  const rekick = async (row: ManagedInputRow, record: ManagedSessionRecord) => {
    if (row.text === null || row.itemCommandId === null) return
    await ports.sessions.submitInput(row.sessionId, {
      text: row.text,
      actor: deps.actor(row.actorOwner, record),
      commandId: row.itemCommandId,
      dedupe: true,
    })
  }

  /** The checks every submit runs that do not depend on the row, read once per pass and only when needed. */
  const sessionChecks = (record: ManagedSessionRecord) => {
    let verdict: Promise<'pass' | 'paused' | ManagedInputChange> | undefined
    return () =>
      (verdict ??= (async () => {
        // Detached by a package removal before the engine existed: what it kept is taken back, never run.
        if (detached(record)) return { state: 'needsOwner', reason: 'grantRevoked' } as const
        if (archived(record)) return { state: 'retained', reason: 'sessionArchived' } as const
        // Every row of a session belongs to the session's manager; a disabled package's gates may fail,
        // but a revoked workspace grant still takes its inputs back.
        if (!(await enabled(record.owner)))
          return ports.records.granted(record.owner, record.workspace)
            ? ('paused' as const)
            : ({ state: 'needsOwner', reason: 'grantRevoked' } as const)
        if (!(await deps.gatesPass(record))) return { state: 'needsOwner', reason: 'grantRevoked' } as const
        return 'pass' as const
      })())
  }

  /**
   * A submitted input: consumed when a turn took it, otherwise true while it may still run. An
   * unconfirmed one (sweeps only) is taken back and held again, so the next submit runs every check
   * under a fresh id. A confirmed one that is neither queued nor taken was removed outside the
   * platform; it leaves flight for the owner to decide, so later inputs are not blocked.
   */
  const land = async (
    row: ManagedInputRow,
    record: ManagedSessionRecord,
    mode: AdvanceMode,
    checks: ReturnType<typeof sessionChecks>,
  ): Promise<boolean> => {
    const sessionId = row.sessionId
    const commandId = row.itemCommandId as string
    if (row.submittedSeq === UNCONFIRMED) {
      if (mode !== 'sweep') return true
      const settled = await settle(row)
      if (settled.state !== 'enqueued') return false
      if ((await ports.sessions.withdraw(sessionId, commandId)) === 'taken')
        return (await settle(settled)).state === 'enqueued'
      move(settled, { state: 'enqueued', reason: 'eligible', submittedSeq: null })
      return false
    }
    const settled = await settle(row)
    if (settled.state !== 'enqueued') return false
    if (mode === 'idle') return true
    if (await (ports.sessions.queued?.(sessionId, commandId) ?? true)) {
      const verdict = await checks()
      // Queued, but no longer allowed to run (revoked, archived, released): taken back before a turn can.
      if (verdict !== 'pass' && verdict !== 'paused') {
        if ((await ports.sessions.withdraw(sessionId, commandId)) === 'taken')
          return (await settle(settled)).state === 'enqueued'
        move(settled, { ...verdict, submittedSeq: null })
        return false
      }
      if (
        verdict === 'pass' &&
        mode === 'sweep' &&
        !(await questionOpen(sessionId)) &&
        !(await busy(sessionId))
      )
        await rekick(settled, record)
      return true
    }
    const again = await settle(settled) // a turn may have taken it between the two reads
    if (again.state !== 'enqueued') return false
    move(again, { state: 'needsOwner', reason: 'ownerDiscarded', submittedSeq: null })
    return false
  }

  /**
   * One input at a time, in admission order, each after the checks. An idle report only scans for
   * consumption from the submitted seq; `result` (an inputResult or a repeated admission) also notices
   * an input removed outside the platform; `sweep` also takes unconfirmed submissions back and starts
   * inputs a restart left queued. An idle report also comes when a runner stops without a turn, so it
   * never resubmits anything.
   */
  const advanceNow = async (sessionId: string, mode: AdvanceMode = 'idle'): Promise<void> => {
    const flying = inputs.inFlight(sessionId)
    if (flying.length === 0 && inputs.held(sessionId).length === 0) return
    const record = ports.records.get(sessionId)
    if (!record) return
    const checks = sessionChecks(record)
    let waiting = 0
    for (const row of flying) if (await land(row, record, mode, checks)) waiting++
    if (detached(record)) {
      inputs.deleteSettled(sessionId)
      return
    }
    if (waiting > 0) return
    for (const row of inputs.held(sessionId)) {
      if (row.state === 'queued') continue // completed only by the caller's next admitInput
      const verdict = await checks()
      if (verdict === 'paused') return // a disabled package keeps its inputs held, unchanged
      if (verdict !== 'pass') {
        move(row, verdict)
        continue
      }
      if (await questionOpen(sessionId)) {
        if (row.state !== 'waitingQuestion') move(row, { state: 'waitingQuestion', reason: 'questionOpen' })
        return
      }
      if (await busy(sessionId)) {
        if (row.state !== 'enqueued' || row.reason !== 'busy')
          move(row, { state: 'enqueued', reason: 'busy' })
        return
      }
      await submit(row, record)
      return
    }
  }

  /** Revoke and uninstall: nothing held runs; an input still in the core inbox is taken back first. */
  const withdrawNow = async (owner: string, sessionId: string, key: string): Promise<void> => {
    const row = inputs.get(owner, sessionId, key)
    if (!row || (row.state !== 'queued' && row.state !== 'enqueued' && row.state !== 'waitingQuestion'))
      return
    if (row.itemCommandId !== null && row.submittedSeq !== null) {
      const outcome = await ports.sessions.withdraw(sessionId, row.itemCommandId)
      if (outcome === 'taken') {
        await settle(row)
        return
      }
    }
    move(row, { state: 'needsOwner', reason: 'grantRevoked', submittedSeq: null })
  }

  const decideNow = async (
    record: ManagedSessionRecord,
    key: string,
    decision: 'deliver' | 'retain' | 'discard',
    expectVersion: number,
  ): Promise<ManagedInputResult> => {
    const sessionId = record.sessionId
    let row = inputs.get(record.owner, sessionId, key)
    if (!row) throw rejected('OWNER_INPUT_UNKNOWN')
    if (FINAL.has(row.state)) throw rejected('OWNER_INPUT_FINAL')
    if (row.version !== expectVersion) throw rejected('OWNER_INPUT_STALE')
    if (decision === 'deliver' && row.text === null) throw rejected('OWNER_INPUT_NO_TEXT')
    if (row.submittedSeq !== null && row.itemCommandId !== null) {
      if (decision === 'deliver') throw rejected('OWNER_INPUT_SUBMITTED')
      // Taken back before it is kept; a turn that already took it is reported as it happened.
      if ((await ports.sessions.withdraw(sessionId, row.itemCommandId)) === 'taken') {
        const settled = await settle(row)
        if (settled.state === 'consumed') return projectInput(settled)
        throw rejected('OWNER_INPUT_STALE')
      }
    }
    const next: ManagedInputChange =
      decision === 'deliver'
        ? { state: 'enqueued', reason: 'eligible', submittedSeq: null }
        : decision === 'retain'
          ? { state: 'retained', reason: 'ownerRetained', submittedSeq: null }
          : { state: 'retained', reason: 'ownerDiscarded', submittedSeq: null, text: null }
    const moved = inputs.transition(row.owner, sessionId, key, row.version, next, 'owner')
    if (!moved) throw rejected('OWNER_INPUT_STALE')
    row = moved
    // The owner's choice runs the same checks an idle submit runs.
    if (decision === 'deliver') await advanceNow(sessionId, 'result')
    return projectInput(inputs.get(record.owner, sessionId, key) ?? row)
  }

  return { move, busy, questionOpen, archived, settle, advanceNow, withdrawNow, decideNow }
}
