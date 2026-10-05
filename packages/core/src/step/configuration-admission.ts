import type { ApprovalMode, SessionRuntimeControlResult } from '@agnes/protocol'
import { onlyCanonicalParentInbox } from '../child/parent-messages.js'
import { scanAll } from '../log/scan-pages.js'
import type { Inbox } from '../reduce/shapes.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import type { RuntimeControl } from '../runtime/loop.js'
import { CoreError, type Seq } from '../types.js'
import type { EnqueueMsg } from './inbox.js'
import { runInputToCompletion } from './input-completion.js'
import type { SessionImpl, TurnOutcome } from './session.js'
import { assertSessionIdleGateMutable } from './session-idle-gate.js'

const register = 'execution.admission'
const inputCancelled = 'x/core/input-cancelled'

async function cancelledInput(session: SessionImpl, commandId: string): Promise<boolean> {
  const rows = await scanAll((query) => session.scan(query), {
    type: inputCancelled,
    lane: session.lane,
    fromSeq: (session.d.log.parent?.boundarySeq ?? 0) + 1,
    toSeq: session.lastSeq,
  })
  let found = false
  for (const row of rows) {
    const data = row.data as { version?: unknown; sessionId?: unknown; commandId?: unknown } | null
    const physical = (
      await session.d.log.storage.scanIntegrity(session.key, { fromSeq: row.seq, toSeq: row.seq, limit: 1 })
    )[0]
    if (
      row.origin !== 'system' ||
      row.trust !== 'trusted' ||
      row.ignorable !== true ||
      row.lane !== session.lane ||
      data?.version !== 1 ||
      data.sessionId !== session.key ||
      typeof data.commandId !== 'string' ||
      !data.commandId ||
      Object.keys(data).some((key) => !['version', 'sessionId', 'commandId'].includes(key)) ||
      physical?.sessionKey !== session.key ||
      canonicalJson(physical.event) !== canonicalJson(row)
    )
      throw new CoreError('E_RELATION', 'Input cancellation source is invalid')
    if (data.commandId === commandId) found = true
  }
  return found
}

/** Call only inside the actual session writer lock. No input or execution authority. */
export async function persistCancelledInput(session: SessionImpl, commandId: string): Promise<void> {
  if (await cancelledInput(session, commandId)) return
  await session.d.log.append([
    session.ev(inputCancelled, { version: 1, sessionId: session.key, commandId }, { ignorable: true }),
  ])
}
/** Physical owner-scoped cancellation survives reopen, but does not inherit through a fork. */
export async function assertConfigurationInputAvailable(
  session: SessionImpl,
  commandId: string,
): Promise<void> {
  if (await cancelledInput(session, commandId))
    throw new CoreError('E_RELATION', 'Input identity has been permanently cancelled')
}
type RecordValue = {
  version: 1
  id: string
  commandId: string
  payloadDigest: string
  configurationDigest: string
  writerRunId: string
  sessionId: string
  lane: string
  runtime: SessionImpl['runtimeIdentity']
  status: 'held' | 'released'
  approvalMode?: ApprovalMode
}
type State = {
  record: RecordValue
  runtime: unknown
  running: boolean
  lease: SessionConfigurationAdmission
  finish(): void
}
const owners = new WeakMap<SessionImpl, State>()
const verified = new WeakMap<SessionImpl, { seq: number; value: RecordValue | undefined }>()
type InheritedApproval = { mode: ApprovalMode; current(): boolean }
const inheritedApprovals = new WeakMap<SessionImpl, InheritedApproval>()

/** A child activation borrows only its original live owner's approval policy, never filesystem authority. */
export async function runWithInheritedConfigurationApproval<T>(
  parent: SessionImpl,
  child: SessionImpl,
  run: () => Promise<T>,
): Promise<T> {
  const owner = owners.get(parent)
  const source =
    inheritedApprovals.get(parent) ??
    (owner?.record.approvalMode === undefined
      ? undefined
      : {
          mode: owner.record.approvalMode,
          current: () => owners.get(parent) === owner,
        })
  if (!source) return run()
  if (inheritedApprovals.has(child))
    throw new CoreError('E_LANE_BUSY', 'Child approval scope is already active')
  const writerRunId = parent.writerRunId
  const runtime = parent.d.currentRuntime?.current(parent.key)
  const signal = parent.ac.signal
  const previous = Object.getOwnPropertyDescriptor(child.d, 'approvalMode')
  let active = true
  const scope: InheritedApproval = {
    mode: source.mode,
    current: () =>
      active &&
      !parent.closingOrClosed &&
      !child.closingOrClosed &&
      !signal.aborted &&
      !parent.ac.signal.aborted &&
      parent.writerRunId === writerRunId &&
      parent.d.currentRuntime?.current(parent.key) === runtime &&
      source.current(),
  }
  inheritedApprovals.set(child, scope)
  try {
    Object.defineProperty(child.d, 'approvalMode', {
      configurable: true,
      enumerable: previous?.enumerable ?? true,
      // A revoked manual scope must not fall back to a profile whose default is off.
      // Descendants retain this same revoked scope; a later owner cannot revive it.
      get: () => (scope.current() ? scope.mode : 'manual'),
    })
    return await run()
  } finally {
    active = false
    if (inheritedApprovals.get(child) === scope) {
      inheritedApprovals.delete(child)
      if (previous) Object.defineProperty(child.d, 'approvalMode', previous)
      else delete child.d.approvalMode
    }
  }
}

/** Privileged capability; not part of a tool context or an extension API. */
export interface SessionConfigurationAdmission {
  readonly id: string
  check(): void
  enqueue(message: EnqueueMsg): Promise<Seq>
  run(options: { until: 'turn-end' | 'idle'; signal: AbortSignal }): Promise<TurnOutcome>
  /** Owner-controlled maintenance only; it grants no new enqueue, execution or configuration authority. */
  control(input: RuntimeControl): Promise<SessionRuntimeControlResult>
  /** Refuses to release queued or unfinished work. No timer expires accepted authority. */
  release(): Promise<void>
}
function recorded(session: SessionImpl): RecordValue | undefined {
  const row = session.d.log.registerRow(register, session.lane)
  const proof = verified.get(session)
  // Generic register-cache repair only retains reducer-owned cells. It must not erase
  // authority already proved from the immutable admission ledger.
  if (!row) return proof?.value
  if (proof?.seq !== row.seq)
    throw new CoreError('E_RELATION', 'Configuration admission provenance is unknown')
  return proof.value
}
function remember(session: SessionImpl, value: RecordValue): void {
  const row = session.d.log.registerRow(register, session.lane)
  if (!row) throw new CoreError('E_RELATION', 'Configuration admission register is missing')
  verified.set(session, { seq: row.seq, value })
}
function validSource(
  session: SessionImpl,
  event: Awaited<ReturnType<SessionImpl['scan']>>[number],
): RecordValue {
  const value = event.data as Partial<RecordValue> | null
  const fields = [
    'version',
    'id',
    'commandId',
    'payloadDigest',
    'configurationDigest',
    'writerRunId',
    'sessionId',
    'lane',
    'runtime',
    'status',
    'approvalMode',
  ]
  if (
    event.type !== 'x/core/configuration-admission' ||
    event.register !== register ||
    event.origin !== 'system' ||
    event.trust !== 'trusted' ||
    event.ignorable !== true ||
    event.lane !== session.lane ||
    !value ||
    value.version !== 1 ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    !['held', 'released'].includes(value.status ?? '') ||
    (value.approvalMode !== undefined && !['manual', 'smart', 'off'].includes(value.approvalMode)) ||
    ['commandId', 'writerRunId', 'sessionId', 'lane'].some(
      (key) => typeof value[key as keyof RecordValue] !== 'string' || !value[key as keyof RecordValue],
    ) ||
    !/^[a-f0-9]{64}$/.test(value.id ?? '') ||
    !/^[a-f0-9]{64}$/.test(value.configurationDigest ?? '') ||
    !/^[a-f0-9]{64}$/.test(value.payloadDigest ?? '') ||
    value.lane !== session.lane ||
    canonicalJson(value.runtime) !== canonicalJson(session.runtimeIdentity)
  )
    throw new CoreError('E_RELATION', 'Configuration admission source is invalid')
  return value as RecordValue
}
export async function verifyConfigurationAdmission(session: SessionImpl): Promise<void> {
  const row = session.d.log.registerRow(register, session.lane)
  const source = (
    await session.d.log.scan({
      type: 'x/core/configuration-admission',
      lane: session.lane,
      order: 'desc',
      limit: 1,
    })
  )[0]
  if (!source) {
    if (row) throw new CoreError('E_RELATION', 'Configuration admission source is missing')
    return
  }
  const value = validSource(session, source)
  if (row && (row.seq !== source.seq || canonicalJson(value) !== canonicalJson(row.data)))
    throw new CoreError('E_RELATION', 'Configuration admission register differs from its source')
  if (value.sessionId !== session.key) {
    const parent = session.d.log.parent
    const physical = (
      await session.d.log.storage.scanIntegrity(session.key, {
        fromSeq: source.seq,
        toSeq: source.seq,
        limit: 1,
      })
    )[0]
    if (
      !parent ||
      source.seq > parent.boundarySeq ||
      physical?.sessionKey !== value.sessionId ||
      canonicalJson(physical.event) !== canonicalJson(source)
    )
      throw new CoreError('E_RELATION', 'Configuration admission physical owner differs')
    // An inherited immutable prefix is evidence about the parent, never a live child capability.
    verified.set(session, { seq: source.seq, value: undefined })
    return
  }
  let prior: RecordValue | undefined
  let cursor = (session.d.log.parent?.boundarySeq ?? 0) + 1
  while (cursor <= source.seq) {
    const events = await session.d.log.scan({
      type: 'x/core/configuration-admission',
      lane: session.lane,
      fromSeq: cursor,
      toSeq: source.seq,
      order: 'asc',
      limit: 500,
    })
    if (!events.length) break
    for (const event of events) {
      const next = validSource(session, event)
      if (next.sessionId !== session.key)
        throw new CoreError('E_RELATION', 'Configuration admission physical owner differs')
      if (next.status === 'released') {
        if (
          prior?.status !== 'held' ||
          canonicalJson({ ...prior, status: 'released' }) !== canonicalJson(next)
        )
          throw new CoreError('E_RELATION', 'Configuration admission release has no matching owner')
      } else if (prior?.status === 'held')
        throw new CoreError('E_RELATION', 'Configuration admission replaced a live owner')
      prior = next
    }
    cursor = events[events.length - 1]!.seq + 1
  }
  if (canonicalJson(prior) !== canonicalJson(value))
    throw new CoreError('E_RELATION', 'Configuration admission transition history is incomplete')
  verified.set(session, { seq: source.seq, value })
}
export function configurationAdmissionHeld(session: SessionImpl): boolean {
  return owners.has(session) || recorded(session)?.status === 'held'
}
export function configurationAdmissionInputId(session: SessionImpl): string | undefined {
  const current = owners.get(session)?.record ?? recorded(session)
  return current?.status === 'held' ? current.commandId : undefined
}
export function assertConfigurationMutable(session: SessionImpl): void {
  assertSessionIdleGateMutable(session)
  if (configurationAdmissionHeld(session))
    throw new CoreError('E_LANE_BUSY', 'Session configuration is reserved for admitted work')
}
/** Only the independently verified backend parent-receipt path may add child input. */
export function assertConfigurationParentReceipt(session: SessionImpl): void {
  assertSessionIdleGateMutable(session)
  if (!configurationAdmissionHeld(session)) return
  const owner = owners.get(session)
  if (!owner) throw new CoreError('E_LANE_BUSY', 'Recovered admission cannot accept new child input')
  owner.lease.check()
}
export function assertConfigurationExecution(
  session: SessionImpl,
  lease?: SessionConfigurationAdmission,
): void {
  assertSessionIdleGateMutable(session)
  if (!configurationAdmissionHeld(session)) {
    if (lease) throw new CoreError('E_RELATION', 'Execution admission is no longer live')
    return
  }
  const owner = owners.get(session)
  if (!owner || owner.lease !== lease)
    throw new CoreError('E_LANE_BUSY', 'Admitted work requires its configuration owner')
  owner.lease.check()
}
export function finishConfigurationOwner(session: SessionImpl): void {
  owners.get(session)?.finish()
}
/** Explicit cancellation can retire an orphaned reservation after a process restart. */
export async function releaseCancelledConfiguration(session: SessionImpl, commandId: string): Promise<void> {
  const current = recorded(session)
  if (
    current?.status !== 'held' ||
    current.commandId !== commandId ||
    session.executionActive ||
    session.op() ||
    !['idle', 'failed'].includes(session.runtimeState().phase)
  )
    return
  if (!(await onlyCanonicalParentInbox(session))) return
  await session.d.log.append([
    session.ev(
      'x/core/configuration-admission',
      { ...current, status: 'released' },
      { register, ignorable: true },
    ),
  ])
  remember(session, { ...current, status: 'released' })
  finishConfigurationOwner(session)
}

/** Capture and publish under the same mutex used by configuration mutations and inbox writes. */
export function reserveSessionConfiguration<T>(
  session: SessionImpl,
  input: {
    id: string
    commandId: string
    payloadDigest: string
    expectedConfigurationDigest?: string
    /** Admission-scoped approval policy. Never grants full filesystem access. */
    approvalMode?: ApprovalMode
  },
  capture: () => T,
  finish: () => void,
): Promise<{ value: T; lease: SessionConfigurationAdmission }> {
  return session.tryLocked(async () => {
    await assertConfigurationInputAvailable(session, input.commandId)
    assertConfigurationMutable(session)
    if (session.closingOrClosed || session.executionActive || session.op())
      throw new CoreError('E_LANE_BUSY', 'Configuration admission requires an idle, empty session')
    if (
      ((session.latest('inbox') as Inbox | undefined)?.items.length ?? 0) > 0 &&
      !(await onlyCanonicalParentInbox(session))
    )
      throw new CoreError('E_LANE_BUSY', 'Configuration admission has unverified queued input')
    assertConfigurationMutable(session)
    if (session.closingOrClosed || session.executionActive || session.op())
      throw new CoreError('E_LANE_BUSY', 'Configuration admission owner became active')
    const runtime = session.d.currentRuntime?.current(session.key)
    const writerRunId = session.writerRunId
    if (
      !input.id ||
      !input.commandId ||
      !/^[a-f0-9]{64}$/.test(input.payloadDigest) ||
      (input.approvalMode !== undefined &&
        (!['manual', 'smart', 'off'].includes(input.approvalMode) || !input.expectedConfigurationDigest))
    )
      throw new CoreError('E_ENVELOPE', 'Invalid configuration admission coordinates')
    if (
      input.expectedConfigurationDigest !== undefined &&
      sha256Hex(canonicalJson(capture())) !== input.expectedConfigurationDigest
    )
      throw new CoreError('E_RELATION', 'Configuration changed before reservation', {
        reason: 'configuration-changed',
      })
    const previousApprovalMode = session.d.approvalMode
    const restoreApprovalMode = () => {
      if (input.approvalMode === undefined) return
      if (previousApprovalMode === undefined) delete session.d.approvalMode
      else session.d.approvalMode = previousApprovalMode
    }
    let admittedOwner: State | undefined
    if (input.approvalMode !== undefined) session.d.approvalMode = input.approvalMode
    try {
      const value = capture()
      const configurationDigest = sha256Hex(canonicalJson(value))
      // The ledger carries a non-recoverable identity hash, never the live bearer capability.
      const record: RecordValue = {
        version: 1,
        id: sha256Hex(input.id),
        commandId: input.commandId,
        payloadDigest: input.payloadDigest,
        configurationDigest,
        writerRunId,
        sessionId: session.key,
        lane: session.lane,
        runtime: session.runtimeIdentity,
        status: 'held',
        ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
      }
      let finished = false
      let enqueued: { seq: number; itemId: string } | undefined
      let invoked = false
      const owner: State = {
        record,
        runtime,
        running: false,
        lease: undefined as unknown as SessionConfigurationAdmission,
        finish() {
          if (finished) return
          finished = true
          restoreApprovalMode()
          owners.delete(session)
          finish()
          session.configurationAdmissionIdle()
        },
      }
      const lease: SessionConfigurationAdmission = Object.freeze({
        id: input.id,
        check() {
          const current = recorded(session)
          if (
            finished ||
            session.closingOrClosed ||
            owners.get(session) !== owner ||
            session.writerRunId !== writerRunId ||
            session.d.currentRuntime?.current(session.key) !== runtime ||
            current?.status !== 'held' ||
            canonicalJson(current) !== canonicalJson(record) ||
            sha256Hex(canonicalJson(capture())) !== configurationDigest
          )
            throw new CoreError('E_RELATION', 'Configuration admission owner changed')
        },
        enqueue(message: EnqueueMsg) {
          if (
            message.commandId !== input.commandId ||
            sha256Hex(canonicalJson(message.content)) !== input.payloadDigest
          )
            return Promise.reject(new CoreError('E_RELATION', 'Admitted input binding changed'))
          return session.enqueue('next-turn', message, lease).then((seq) => {
            const items = (session.latest('inbox') as Inbox).items.filter(
              (item) => item.commandId === input.commandId,
            )
            if (items.length !== 1 || !items[0])
              throw new CoreError('E_RELATION', 'Admitted input identity is ambiguous')
            enqueued = { seq, itemId: items[0].itemId }
            return seq
          })
        },
        async run(options: { until: 'turn-end' | 'idle'; signal: AbortSignal }) {
          lease.check()
          if (owner.running) throw new CoreError('E_LANE_BUSY', 'Admission execution is active')
          if (invoked || !enqueued)
            throw new CoreError('E_RELATION', 'Admitted input execution is unavailable')
          invoked = true
          owner.running = true
          try {
            return await runInputToCompletion({
              itemId: enqueued.itemId,
              enqueuedSeq: enqueued.seq,
              signal: options.signal,
              read: (query) => session.scan(query),
              run: () => session.run(options, lease),
            })
          } finally {
            owner.running = false
          }
        },
        async control(input: RuntimeControl) {
          lease.check()
          if (owner.running || session.executionActive)
            throw new CoreError('E_LANE_BUSY', 'Admission execution is active')
          const result = await session.controlRuntime(input, lease)
          lease.check()
          return result
        },
        release() {
          return session.locked(async () => {
            lease.check()
            if (
              session.executionActive ||
              session.op() ||
              !['idle', 'failed'].includes(session.runtimeState().phase)
            )
              throw new CoreError('E_LANE_BUSY', 'Admission still owns queued or unfinished work')
            if (!(await onlyCanonicalParentInbox(session)))
              throw new CoreError('E_LANE_BUSY', 'Admission still owns unverified queued input')
            await session.d.log.append([
              session.ev(
                'x/core/configuration-admission',
                { ...record, status: 'released' },
                { register, ignorable: true },
              ),
            ])
            remember(session, { ...record, status: 'released' })
            owner.finish()
          })
        },
      })
      owner.lease = lease
      admittedOwner = owner
      owners.set(session, owner)
      await session.d.log.append([
        session.ev('x/core/configuration-admission', record, { register, ignorable: true }),
      ])
      remember(session, record)
      if (
        session.closingOrClosed ||
        session.writerRunId !== writerRunId ||
        session.d.currentRuntime?.current(session.key) !== runtime
      )
        throw new CoreError('E_RELATION', 'Configuration changed while admission was persisted')
      return { value, lease }
    } catch (error) {
      // A failed/uncertain append never leaves an unowned approval bypass. Re-read the
      // durable fence; if it landed, only explicit cancellation/recovery may release it.
      restoreApprovalMode()
      if (admittedOwner) {
        await verifyConfigurationAdmission(session).catch(() => undefined)
        admittedOwner.finish()
      }
      throw error
    }
  })
}
