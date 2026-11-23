import { hasChildControl, transitionChildState } from '@agnes/core-child-control/child/store'
import { CoreError } from '@agnes/core-common/types'
import type { ChildCheckpointRecord, NonInterruptibleStopReceipt } from '@agnes/extension-api'
import type { SessionImpl } from '../step/session.js'

const RECEIPT = 'x/core/child-stop-receipt'
type Call = { toolUseId: string; toolName: string; returned: Promise<number> }
const active = new WeakMap<SessionImpl, Set<Call>>()

const completedEffects = new WeakMap<SessionImpl, ReadonlySet<string>>()
const stopping = new WeakSet<SessionImpl>()

export function restoreCheckpointEffects(child: SessionImpl, checkpoint: ChildCheckpointRecord) {
  completedEffects.set(child, new Set(checkpoint.completedEffectIds))
}

export function isChildStopping(child: SessionImpl) {
  return stopping.has(child)
}

const cancelledDrains = new WeakMap<SessionImpl, NonNullable<ReturnType<typeof childStopDrain>>>()
export function stopChildDispatch(child: SessionImpl, requestedAt: number) {
  stopping.add(child)
  const drain = cancelledDrains.get(child) ?? childStopDrain(child, requestedAt)
  if (drain) cancelledDrains.set(child, drain)
  return drain
}

/** Check before invoking the effect, including the first dispatch after a cold open. */
export async function dispatchChildEffect<T>(
  child: SessionImpl,
  call: { toolUseId: string; name: string },
  effectId: string,
  policy: { replay: string; isReadOnly: boolean; isDestructive: boolean },
  invoke: () => Promise<T>,
): Promise<T> {
  if (!child.state.session?.delegation && !completedEffects.has(child)) return invoke()
  const oneShot = policy.replay === 'never' || !policy.isReadOnly || policy.isDestructive
  if (oneShot && !completedEffects.has(child)) {
    const [row] = await child.scan({ type: 'x/core/child-checkpoint', order: 'desc', limit: 1 })
    const checkpoint = row?.data as ChildCheckpointRecord | undefined
    if (checkpoint?.childKey === child.key && row?.origin === 'system' && row.trust === 'trusted')
      restoreCheckpointEffects(child, checkpoint)
    else completedEffects.set(child, new Set())
  }
  if (stopping.has(child) || (oneShot && completedEffects.get(child)?.has(effectId)))
    throw new CoreError('E_RELATION', 'Checkpoint or stop fence refused tool dispatch')
  return oneShot ? trackChildDispatch(child, call.toolUseId, call.name, invoke()) : invoke()
}

/** Track the dispatch promise itself. Aborting its caller or racing its deadline is not a return. */
export function trackChildDispatch<T>(
  child: SessionImpl,
  toolUseId: string,
  toolName: string,
  dispatched: Promise<T>,
): Promise<T> {
  const calls = active.get(child) ?? new Set()
  active.set(child, calls)
  const returned = () => child.d.clock()
  const call = { toolUseId, toolName, returned: dispatched.then(returned, returned) }
  calls.add(call)
  void call.returned.then(() => calls.delete(call))
  return dispatched
}

export function childStopDrain(child: SessionImpl, cancelRequestedAt = child.d.clock()) {
  const calls = [...(active.get(child) ?? [])]
  if (!calls.length) return undefined
  const returned = Promise.all(
    calls.map(async (call) => ({
      toolUseId: call.toolUseId,
      toolName: call.toolName,
      toolReturnedAt: Math.max(cancelRequestedAt, await call.returned),
    })),
  )
  async function record(disposition: NonInterruptibleStopReceipt['disposition']) {
    const settled = disposition === 'drained_clean' ? await returned : []
    const rows = calls.map(({ toolUseId, toolName }, index) => {
      const toolReturnedAt = settled[index]?.toolReturnedAt ?? null
      const receipt: NonInterruptibleStopReceipt = {
        childKey: child.key,
        toolUseId,
        toolName,
        cancelRequestedAt,
        toolReturnedAt,
        terminalConfirmedAt: toolReturnedAt === null ? null : Math.max(toolReturnedAt, child.d.clock()),
        disposition,
      }
      return child.ev(RECEIPT, receipt, { ignorable: true })
    })
    await child.d.log.append(rows)
  }
  return { returned, record }
}

/** The caller has fenced new dispatch and entered cancelling. Confirm only after actual returns. */
export async function drainChildStop(drain: NonNullable<ReturnType<typeof childStopDrain>>, graceMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs)
    })
    if (!(await Promise.race([drain.returned, expired]))) {
      await drain.record('timed_out_unknown')
      throw new CoreError('E_RELATION', 'Tool return is unconfirmed; child remains cancelling')
    }
  } finally {
    clearTimeout(timer)
  }
}

// Keep the existing driver, pinned permissions, inbox and program counter across a warm pause.
const runFences = new WeakMap<SessionImpl, AbortController>()
const drivers = new WeakMap<SessionImpl, { checkpointRequested: boolean; terminal: boolean }>()

export function fenceChildRun(child: SessionImpl) {
  const wake = new AbortController()
  runFences.set(child, wake)
  const driver = drivers.get(child)
  if (driver) driver.checkpointRequested = true
}
export function releaseChildRun(child: SessionImpl, terminal = false) {
  const driver = drivers.get(child)
  if (terminal) stopping.add(child)
  if (terminal && driver) driver.terminal = true
  runFences.get(child)?.abort()
  runFences.delete(child)
}
export function waitForChildResume(child: SessionImpl, signal: AbortSignal) {
  const wake = runFences.get(child)
  if (!wake) return
  const any = AbortSignal.any([wake.signal, signal])
  return new Promise<void>((resolve) => {
    if (any.aborted) resolve()
    else any.addEventListener('abort', () => resolve(), { once: true })
  })
}

/** A generic Loop park still returns to its caller. Only a managed pause keeps this run open. */
export async function runChildTurn(child: SessionImpl, opts: Parameters<SessionImpl['run']>[0]) {
  const driver = { checkpointRequested: false, terminal: false }
  drivers.set(child, driver)
  try {
    for (;;) {
      await waitForChildResume(child, opts.signal)
      if (driver.terminal || opts.signal.aborted || child.closingOrClosed)
        return { reason: 'aborted' as const, lastSeq: child.lastSeq }
      driver.checkpointRequested = false
      const turn = await child.run(opts)
      if (turn.reason !== 'parked' || !driver.checkpointRequested) return turn
    }
  } finally {
    drivers.delete(child)
  }
}

/** An answer can arrive while parked. Hold dispatch until resume has reacquired the slot. */
export async function childApprovalState(
  child: SessionImpl,
  next: 'running' | 'waiting_approval',
  signal: AbortSignal,
) {
  const storage = child.d.log.storage
  if (!hasChildControl(storage) || !(await storage.lookupByKey(child.key))) return false
  if (next === 'running') {
    await waitForChildResume(child, signal)
    signal.throwIfAborted()
    if (stopping.has(child)) throw new CoreError('E_RELATION', 'Child closed while awaiting approval')
  }
  await transitionChildState(storage, child.key, next)
  return true
}
