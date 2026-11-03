import { requireChildControl } from '@agnes/core-child-control/child/store'
import { isTerminalChildState } from '@agnes/core-child-control/child/types'
import { CoreError } from '@agnes/core-common/types'
import type { Kernel } from '../kernel.js'
import { sideCallInFlight } from '../loop/side-call-receipts.js'
import { maintenanceInFlight } from '../maintenance/in-flight.js'
import type { SessionImpl } from '../step/session.js'
import { childResultSequence } from './collected-result.js'
import { childCompletionId } from './completion-notice.js'
import { IDLE_RETIRED } from './idle-retirement-fact.js'

export type IdleChildRetirementResult = { childKey: string; status: 'retired' | 'failed'; error?: string }
export type IdleChildRetirementOptions = {
  now: number
  idleMs: number
  limit: number
  signal: AbortSignal
  canRetireSession(key: string): boolean
}

type Entry = {
  kernel: Kernel
  parent: SessionImpl
  child: SessionImpl
  idle(): boolean
  busy(): boolean
  retire(): Promise<void>
  idleAt?: number | undefined
  retiring?: Promise<void>
}
const entries = new WeakMap<Kernel, Map<string, Entry>>()
const children = new WeakMap<SessionImpl, Entry>()
const retained = new Map<string, Set<WeakRef<Entry>>>()
const retentionReferences = new WeakMap<Entry, WeakRef<Entry>>()
function removeRetained(key: string, reference: WeakRef<Entry>): void {
  const live = retained.get(key)
  live?.delete(reference)
  if (!live?.size) retained.delete(key)
}
// This cross-Kernel index observes resource owners; it must never become an owner itself.
const finalized = new FinalizationRegistry<{ key: string; reference: WeakRef<Entry> }>(({ key, reference }) =>
  removeRetained(key, reference),
)
const admissions = new WeakMap<SessionImpl, Promise<void>>()

/** Read-only guard; the Session supplies all owned work when taking its final admission claim. */
export function idleChildReady(child: SessionImpl, active = child.isRunning): boolean {
  return (
    !child.closingOrClosed &&
    !active &&
    !child.op() &&
    !child.state.openTurn.size &&
    !child.state.pendingEffects.size &&
    !sideCallInFlight(child) &&
    !maintenanceInFlight(child).size &&
    ![...child.state.registers.inbox.values()].some(({ value }) => value.items.length) &&
    ![...child.state.registers.decisionStates.values()].some(
      ({ value }) => !value.consumption && !value.invalidation,
    )
  )
}

/** Continuation, delegated creation and retirement share one admission order. */
export async function withChildAdmission<T>(session: SessionImpl, work: () => Promise<T>): Promise<T> {
  const previous = admissions.get(session) ?? Promise.resolve()
  let release!: () => void
  const own = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => own)
  admissions.set(session, tail)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (admissions.get(session) === tail) admissions.delete(session)
  }
}

export function bindIdleChild(entry: Omit<Entry, 'idleAt' | 'retiring'>): void {
  const owned = entries.get(entry.kernel) ?? new Map<string, Entry>()
  owned.set(entry.child.key, entry)
  entries.set(entry.kernel, owned)
  children.set(entry.child, entry)
  const live = retained.get(entry.child.key) ?? new Set<WeakRef<Entry>>()
  const reference = new WeakRef(entry)
  live.add(reference)
  retentionReferences.set(entry, reference)
  finalized.register(entry, { key: entry.child.key, reference }, entry)
  retained.set(entry.child.key, live)
}

export function noteChildIdle(child: SessionImpl, idle: boolean): void {
  const entry = children.get(child)
  if (entry) entry.idleAt = idle ? child.d.clock() : undefined
}

export function forgetIdleChild(child: SessionImpl): void {
  const entry = children.get(child)
  if (!entry) return
  children.delete(child)
  if (entries.get(entry.kernel)?.get(child.key) === entry) entries.get(entry.kernel)?.delete(child.key)
  const reference = retentionReferences.get(entry)
  if (reference) removeRetained(child.key, reference)
  retentionReferences.delete(entry)
  finalized.unregister(entry)
}

async function descendantsReleased(entry: Entry): Promise<boolean> {
  const store = requireChildControl(entry.parent.d.log.storage)
  const pending = [entry.child.key]
  const seen = new Set<string>()
  while (pending.length) {
    const key = pending.pop()!
    if (seen.has(key)) return false
    seen.add(key)
    for (const descendant of await store.listByParent(key)) {
      if (
        !isTerminalChildState(descendant.state) ||
        [...(retained.get(descendant.childKey) ?? [])].some((reference) => reference.deref())
      )
        return false
      pending.push(descendant.childKey)
    }
  }
  return true
}

async function retire(entry: Entry, options: IdleChildRetirementOptions): Promise<boolean> {
  const { child, parent } = entry
  const result = await withChildAdmission(child, () =>
    child.locked(async () => {
      if (
        options.signal.aborted ||
        parent.closingOrClosed ||
        !entry.idle() ||
        entry.busy() ||
        entry.idleAt === undefined ||
        options.now - entry.idleAt < options.idleMs ||
        !idleChildReady(child) ||
        !options.canRetireSession(child.key)
      )
        return
      const store = requireChildControl(parent.d.log.storage)
      const record = await store.lookupByKey(child.key)
      if (record?.state !== 'idle' || !(await descendantsReleased(entry))) return
      const resultSeq = await childResultSequence(parent, record)
      if (!resultSeq || options.signal.aborted || entry.busy() || !options.canRetireSession(child.key)) return
      const release = child.claimIdleRetirement()
      if (!release) return
      try {
        await child.d.log.append([
          child.ev(
            IDLE_RETIRED,
            {
              stateRevision: record.stateRevision + 1,
              resultSeq,
              completionId: childCompletionId(child.key, 'completed', resultSeq),
            },
            { ignorable: true },
          ),
        ])
        if (options.signal.aborted || !(await store.casState(child.key, record.stateRevision, 'completed')))
          return
        entry.retiring = entry.retire()
        void entry.retiring.catch(() => undefined)
        // Start revocation while still holding both admission gates; join close after releasing them.
        void child.close().catch(() => undefined)
        return { cleanup: entry.retiring }
      } finally {
        release()
      }
    }),
  )
  if (!result) return false
  await result.cleanup
  return true
}

export async function retireIdleChildren(
  kernel: Kernel,
  options: IdleChildRetirementOptions,
): Promise<IdleChildRetirementResult[]> {
  const results: IdleChildRetirementResult[] = []
  if (
    !Number.isFinite(options.now) ||
    !Number.isFinite(options.idleMs) ||
    options.idleMs <= 0 ||
    !Number.isSafeInteger(options.limit) ||
    options.limit <= 0
  )
    return results
  for (const entry of [...(entries.get(kernel)?.values() ?? [])]) {
    if (options.signal.aborted || results.length >= options.limit) break
    try {
      if (entry.retiring) await entry.retiring
      else if (!(await retire(entry, options))) continue
      results.push({ childKey: entry.child.key, status: 'retired' })
    } catch (error) {
      results.push({
        childKey: entry.child.key,
        status: 'failed',
        error: error instanceof CoreError ? error.code : 'E_CHILD_RETIREMENT_CLEANUP',
      })
    }
  }
  return results
}
