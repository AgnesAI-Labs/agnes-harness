import { ChildLock } from '@agnes/core-child-control/child/child-lock'
import { externalChild } from '@agnes/core-child-control/child/directory'
import {
  projectChildStatus,
  resolveTerminalChildState,
} from '@agnes/core-child-control/child/status-projection'
import { requireChildControl } from '@agnes/core-child-control/child/store'
import { isTerminalChildState } from '@agnes/core-child-control/child/types'
import { CoreError } from '@agnes/core-common/types'
import type {
  ChildAgentCapabilities,
  ChildCheckpointRecord,
  ChildExecutionState,
  ChildTaskRecord,
} from '@agnes/extension-api'
import type { SessionImpl } from '../step/session.js'
import { noteChildIdle } from './idle-retirement.js'
import {
  childStopDrain,
  drainChildStop,
  fenceChildRun,
  releaseChildRun,
  restoreCheckpointEffects,
  stopChildDispatch,
} from './non-interruptible-receipt.js'
import { IN_PROCESS_CHILD_CAPABILITIES } from './provider.js'
import {
  type Checkpoint,
  checkpointOpenOptions,
  checkpointPauseFence,
  childApprovalPending,
  childCloseOutcome,
  childHasPendingWork,
  hasUnconfirmedColdStop,
  pinnedChildBinding,
  projectChildControls,
  readChildCheckpoint,
  requireConfirmedColdStop,
  requireOpenWorkspace,
  withChildLog,
  writeChildCheckpoint,
} from './status.js'

type Reason = ChildCheckpointRecord['reason']
type Outcome = 'completed' | 'cancelled' | 'failed'
type Port = {
  live(key: string): SessionImpl | undefined
  /** Start from the saved program counter and pinned composition; an idle resident only pumps its inbox. */
  activate(record: ChildTaskRecord, checkpoint?: Checkpoint): Promise<void>
  release(key: string, outcome: Outcome): Promise<void>
  retain(key: string): void
  capabilities?(key: string): Pick<ChildAgentCapabilities, 'pause'>
}
function result(record: ChildTaskRecord, state = record.state, pausePending = false) {
  const { status, executionState } = projectChildStatus({ state })
  return {
    childKey: record.childKey,
    previousStatus: projectChildStatus(record).status,
    status,
    executionState,
    ...(pausePending ? { pausePending: true } : {}),
  }
}
type Result = ReturnType<typeof result>
type Park = {
  boundary: AbortController
  wake: AbortController
  done: Promise<Result>
  pending: boolean
  onClose?: (() => void) | undefined
}
function signalled(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })
}
const controllers = new WeakMap<SessionImpl, ChildLifecycleControls>()
export function childControls(parent: SessionImpl) {
  const controls = controllers.get(parent)
  if (!controls) throw new CoreError('E_UNSUPPORTED', 'Child lifecycle controller is unavailable')
  return controls
}

export async function settleColdCancelling(
  parent: SessionImpl,
  store: ReturnType<typeof requireChildControl>,
  childKey: string,
): Promise<'cancelled' | 'completed' | 'failed' | 'cancelling'> {
  let live: ChildTaskRecord | null = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    live = await store.lookupByKey(childKey)
    if (!live) return 'cancelled'
    if (isTerminalChildState(live.state)) return live.state as 'completed' | 'failed' | 'cancelled'
    if (live.state === 'cancelling') break
    if (await store.casState(childKey, live.stateRevision, 'cancelling')) {
      live = await store.lookupByKey(childKey)
      break
    }
  }
  if (!live) return 'cancelled'
  if (isTerminalChildState(live.state)) return live.state as 'completed' | 'failed' | 'cancelled'
  if (live.state !== 'cancelling') return 'cancelling'
  if (await hasUnconfirmedColdStop(parent, live)) return 'cancelling'
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!live) return 'cancelled'
    if (isTerminalChildState(live.state)) return live.state as 'completed' | 'failed' | 'cancelled'
    if (live.state !== 'cancelling') return 'cancelling'
    if (live.creationPhase === 'committed' && store.settleLostChild) {
      const settled = await store.settleLostChild(childKey, live.stateRevision)
      if (settled) return settled
      const latest = await store.lookupByKey(childKey)
      if (!latest) return 'cancelled'
      if (isTerminalChildState(latest.state)) return latest.state as 'completed' | 'failed' | 'cancelled'
      if (latest.state !== 'cancelling' || latest.stateRevision === live.stateRevision) return 'cancelling'
      live = latest
      continue
    }
    const leaseRunId = `cold-cancel:${parent.d.ids.ulid()}`
    try {
      await parent.d.log.storage.open(childKey, { writerRunId: leaseRunId, ttlMs: 1_000 })
    } catch (error) {
      if (error instanceof CoreError && error.code === 'E_WRITER_LEASE') return 'cancelling'
      throw error
    }
    try {
      if (await store.casState(childKey, live.stateRevision, 'cancelled')) return 'cancelled'
    } finally {
      await parent.d.log.storage.release(childKey, leaseRunId).catch(() => undefined)
    }
    live = await store.lookupByKey(childKey)
  }
  const latest = await store.lookupByKey(childKey)
  return latest && isTerminalChildState(latest.state)
    ? (latest.state as 'completed' | 'failed' | 'cancelled')
    : 'cancelling'
}

/** One controller per owning factory. Never keep the child lock while waiting for a tool or the next run. */
export class ChildLifecycleControls {
  private readonly lock = new ChildLock()
  private readonly parks = new Map<string, Park>()
  private readonly reviving = new Map<string, Promise<Result>>()
  constructor(
    private readonly parent: () => SessionImpl,
    private readonly port: Port,
  ) {}
  bind() {
    controllers.set(this.parent(), this)
    return this
  }

  private get store() {
    return requireChildControl(this.parent().d.log.storage)
  }
  private async owned(key: string) {
    const parent = this.parent()
    const record = await this.store.lookupByKey(key)
    if (key === parent.key || (!record && (await this.store.existsSession(key))))
      throw Object.assign(new Error('Root or self control is unauthorized'), { code: 'E_UNAUTHORIZED' })
    if (!record || (record.parentKey !== parent.key && record.runtimeOwnerSessionKey !== parent.key))
      throw new CoreError('E_CHILD_NOT_FOUND', 'Child is not owned by this parent')
    // Some storage adapters return their mutable row; bind a value snapshot before yielding.
    return { ...record }
  }
  private async transition(record: ChildTaskRecord, state: ChildExecutionState) {
    if (
      !(await this.store.casState(record.childKey, record.stateRevision, state, {
        maxFanOut: this.parent().preset.maxFanOut,
      }))
    )
      throw new CoreError('E_CAS', 'Child state revision changed during control')
    return { ...record, state, stateRevision: record.stateRevision + 1 }
  }
  private wake(key: string, terminal = false) {
    const park = this.parks.get(key)
    const child = this.port.live(key)
    if (child) releaseChildRun(child, terminal)
    park?.onClose?.()
    this.parks.delete(key)
    park?.boundary.abort()
    park?.wake.abort()
  }
  admitMessage<T>(key: string, send: () => Promise<T>) {
    return this.lock.run(key, async () => {
      if ((await this.owned(key)).state === 'paused' || this.parks.has(key))
        throw new CoreError('E_RELATION', 'Resume the child before continuing it')
      return send()
    })
  }
  async pauseChild(key: string, reason: Reason = 'parent_pause') {
    const request = await this.lock.run(key, async () => {
      const cap =
        this.port.capabilities?.(key) ??
        (externalChild(this.parent().key, key) ? {} : IN_PROCESS_CHILD_CAPABILITIES)
      if (cap.pause !== true)
        throw new CoreError('E_UNSUPPORTED', 'Provider cannot checkpoint; use interrupt or cancel')
      const record = await this.owned(key)
      if (record.state === 'paused') return { done: result(record) }
      const current = this.parks.get(key)
      if (current) return { done: current.pending ? result(record, record.state, true) : current.done }
      if (!projectChildControls(record).controls.pause)
        throw new CoreError('E_RELATION', 'Child cannot pause in its current state')
      const child = this.port.live(key)
      const drain = child && childStopDrain(child)
      if (child) {
        await child.controls.require('pause', child.d.actor)
        fenceChildRun(child)
        try {
          await checkpointPauseFence(this.parent(), record, child, true)
        } catch (error) {
          releaseChildRun(child)
          throw error
        }
        noteChildIdle(child, false)
      }
      const boundary = new AbortController()
      const wake = new AbortController()
      // A waiting decision is already parked before dispatch. Its answer must pass the same fence.
      const off = child?.onRunSettled(() => boundary.abort())
      if (!child?.isRunning || record.state === 'waiting_approval') boundary.abort()
      const done = Promise.all([
        signalled(boundary.signal),
        drain && Promise.race([drain.returned, signalled(wake.signal)]),
      ])
        .then(() =>
          this.lock.run(key, async () => {
            if (wake.signal.aborted) return result(record, (await this.owned(key)).state)
            try {
              const latest = await this.owned(key)
              if (latest.stateRevision !== record.stateRevision)
                throw new CoreError('E_CAS', 'Pause request superseded')
              await withChildLog(this.parent(), record, child, (log) =>
                writeChildCheckpoint(this.parent(), log, record, reason, child),
              )
              await this.transition(record, 'paused')
            } catch (err) {
              if (child && !child.closingOrClosed)
                await checkpointPauseFence(this.parent(), record, child, false).catch(() => undefined)
              this.wake(key)
              throw err
            }
            await drain?.record('drained_clean')
            return result(record, 'paused')
          }),
        )
        .finally(() => off?.())
      this.parks.set(key, {
        boundary,
        wake,
        done,
        pending: !!drain,
        onClose: child?.onClosed(() => this.wake(key, true)),
      })
      if (drain)
        void done.catch((error) =>
          this.parent().d.logger.error('Child checkpoint failed', { error: String(error) }),
        )
      return { done: drain ? result(record, record.state, true) : done }
    })
    return request.done
  }

  pendingPause(key: string): Promise<Result> | undefined {
    const park = this.parks.get(key)
    return park?.pending ? park.done : undefined
  }

  resumeChild(key: string): Promise<Result> {
    const current = this.reviving.get(key)
    if (current) return current
    const promise = this.lock.run(key, () => this.revive(key)).finally(() => this.reviving.delete(key))
    this.reviving.set(key, promise)
    return promise
  }
  private async revive(key: string) {
    const record = await this.owned(key)
    const child = this.port.live(key)
    const park = this.parks.get(key)
    if (
      park &&
      !isTerminalChildState(record.state) &&
      record.state !== 'cancelling' &&
      record.state !== 'paused'
    ) {
      if (child) {
        await checkpointPauseFence(this.parent(), record, child, false)
        noteChildIdle(child, record.state === 'idle')
      }
      this.wake(key)
      return result(record)
    }
    if (!['paused', 'ready', 'creating'].includes(record.state)) {
      if (['running', 'waiting_approval', 'idle'].includes(record.state)) return result(record)
      throw new CoreError('E_RELATION', 'Child cannot resume in its current state')
    }
    await requireOpenWorkspace(this.parent(), record, child)
    const checkpoint =
      record.state === 'paused' ? await readChildCheckpoint(this.parent(), record) : undefined
    if (checkpoint) {
      if (child) restoreCheckpointEffects(child, checkpoint)
      else checkpointOpenOptions(this.parent(), record, checkpoint)
    }
    const previous = checkpoint?.previousState
    const directIdle = previous === 'idle' && !(await childHasPendingWork(this.parent(), key, child))
    let admitted = directIdle ? await this.transition(record, 'idle') : await this.transition(record, 'ready')
    try {
      if (!directIdle) {
        if (previous === 'waiting_approval' && (await childApprovalPending(this.parent(), key, child)))
          admitted = await this.transition(admitted, 'waiting_approval')
        else if (park && child?.op()) admitted = await this.transition(admitted, 'running')
      }
      if (child || checkpoint) await checkpointPauseFence(this.parent(), record, child, false)
      if ((admitted.state !== 'running' && admitted.state !== 'waiting_approval') || !park)
        await this.port.activate(admitted, checkpoint)
    } catch (error) {
      if (checkpoint) {
        await checkpointPauseFence(this.parent(), admitted, this.port.live(key), true, checkpoint)
        await this.transition(admitted, 'paused')
      }
      throw error
    }
    this.wake(key)
    if (child && admitted.state === 'idle') noteChildIdle(child, true)
    return result(record, admitted.state)
  }

  retainChild(key: string) {
    return this.lock.run(key, async () => {
      const record = await this.owned(key)
      if (!projectChildControls(record).controls.retain)
        throw new CoreError('E_RELATION', 'Child cannot be retained')
      const live = this.port.live(key)
      const binding = await pinnedChildBinding(this.parent(), record, live)
      await withChildLog(this.parent(), record, live, (log) =>
        log.append([
          this.parent().ev('x/core/child-retained', { childKey: key, binding }, { ignorable: true }),
        ]),
      )
      this.port.retain(key)
      return result(record)
    })
  }

  closeChild(key: string) {
    return this.lock.run(key, async () => {
      const record = await this.owned(key)
      const terminal = isTerminalChildState(record.state)
      if (!terminal && !projectChildControls(record).controls.close)
        throw new CoreError('E_RELATION', 'Pause or cancel the running child before closing it')
      const outcome = await childCloseOutcome(this.parent(), record)
      const child = this.port.live(key)
      if (!terminal) await this.transition(record, outcome)
      if (child && !child.closingOrClosed) await child.decisions.stop()
      this.wake(key, true)
      await this.port.release(key, outcome)
      return result(record, outcome)
    })
  }
  cancelChild(key: string, graceMs = 1500) {
    return this.lock.run(key, async () => {
      const record = await this.owned(key)
      if (isTerminalChildState(record.state)) {
        await this.port.release(key, resolveTerminalChildState(record.state, 'cancelled'))
        return result(record)
      }
      const child = this.port.live(key)
      const requestedAt = this.parent().d.clock()
      const cancelling = record.state === 'cancelling' ? record : await this.transition(record, 'cancelling')
      const drain = child && stopChildDispatch(child, requestedAt)
      if (!child) {
        await requireConfirmedColdStop(this.parent(), cancelling)
        const settled = await settleColdCancelling(this.parent(), this.store, key)
        if (settled === 'cancelling')
          throw new CoreError('E_RELATION', 'Child writer lease is still active; child remains cancelling')
        this.wake(key, true)
        await this.port.release(key, settled)
        return result(record, settled)
      }
      await checkpointPauseFence(this.parent(), record, child, true)
      if (drain) await drainChildStop(drain, graceMs)
      await child.abort()
      await child.drainCancelledTurn()
      const live = await this.owned(key)
      const outcome = resolveTerminalChildState(live.state, 'cancelled')
      if (!isTerminalChildState(live.state)) await this.transition(live, outcome)
      await drain?.record('drained_clean')
      this.wake(key, true)
      await this.port.release(key, outcome)
      return result(record, outcome)
    })
  }
}
