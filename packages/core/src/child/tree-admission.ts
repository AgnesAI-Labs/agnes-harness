import { MICROCREDITS_PER_CREDIT } from '@agnes/core-child-control/child/credits'
import { type ChildControlStore, trackChildAttempt } from '@agnes/core-child-control/child/store'
import {
  type ChildTaskRecord,
  type CreateDelegatedChildInput,
  isTerminalChildState,
} from '@agnes/core-child-control/child/types'
import { presetDefaults } from '@agnes/core-common/step/preset'
import { CoreError } from '@agnes/core-common/types'

const credits = (micro: bigint) => Number(micro) / Number(MICROCREDITS_PER_CREDIT)

// A diagnostic snapshot only. Admission itself must always use the store's atomic transaction.
export async function computeRemainingTreeCredits(
  store: ChildControlStore,
  rootTaskId: string,
  maxFanOut = presetDefaults().maxFanOut,
  parentKey?: string,
): Promise<number> {
  const root = await store.projectTree(rootTaskId)
  if (!root) return 0
  const rootId = `root:${rootTaskId}`
  const tasks = await store.listByRoot(rootTaskId)
  const scopes = new Map<string, Pick<typeof root, 'capMicro' | 'heldMicro' | 'settledMicro'>>([
    [rootId, root],
  ])
  const allocated = new Map<string, bigint>()
  const unbounded = new Map<string, bigint>()
  const active = tasks.filter((t) => t.creationPhase !== 'cancelled' && !isTerminalChildState(t.state))
  for (const task of active) {
    const scope = await store.scopeForChild(task.childKey)
    if (!scope) throw new CoreError('E_STORAGE_FAULT', 'admitted child budget scope is missing')
    scopes.set(scope.scopeId, scope)
    if (scope.childKey === task.childKey && scope.parentScopeId !== null) {
      const unused = scope.capMicro - scope.heldMicro - scope.settledMicro
      if (unused > 0n) allocated.set(scope.parentScopeId, (allocated.get(scope.parentScopeId) ?? 0n) + unused)
    } else {
      unbounded.set(scope.scopeId, (unbounded.get(scope.scopeId) ?? 0n) + 1n)
    }
  }
  const ancestors = tasks.find((t) => t.childKey === parentKey)?.ancestorScopeIds ?? [rootId]
  const remaining = ancestors.map((id) => {
    const scope = scopes.get(id)
    if (!scope) return 0
    const share = scope.capMicro / BigInt(Math.max(1, maxFanOut))
    const floor = share < MICROCREDITS_PER_CREDIT ? share : MICROCREDITS_PER_CREDIT
    const free = scope.capMicro - scope.heldMicro - scope.settledMicro - (allocated.get(id) ?? 0n)
    return Math.max(0, credits(free - floor * (unbounded.get(id) ?? 0n)))
  })
  return Math.min(...remaining)
}

export function formatSpawnBudgetRefusal(error: unknown) {
  if (!(error instanceof CoreError) || error.code !== 'E_BUDGET') return undefined
  const { remainingCredits, requestedCredits } = error.detail ?? {}
  if (typeof remainingCredits !== 'number') return undefined
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: error.message }],
    details: {
      code: error.code,
      remainingCredits,
      requestedCredits: typeof requestedCredits === 'number' ? requestedCredits : null,
    },
  }
}

/** The creating record is both the fan-out slot and the budget reservation. Only its creator owns rollback. */
export class ChildAdmissionGuard {
  private released: Promise<void> | undefined
  private committed = false
  private binding = false

  private constructor(
    readonly record: ChildTaskRecord,
    private readonly rollback: () => Promise<void>,
    private readonly untrack: () => void,
  ) {}

  static async reserve(store: ChildControlStore, input: CreateDelegatedChildInput, clock = Date.now) {
    const untrack = trackChildAttempt(input.attemptId ?? `legacy:${input.writerRunId}`)
    try {
      const result = await store.createDelegatedChild(input)
      if (result.status === 'conflict')
        throw new CoreError('E_CHILD_CONFLICT', 'creationId reused with different input', {
          creationId: input.creationId,
        })
      if (result.status === 'refused') {
        if (result.reason === 'budget') {
          throw new CoreError('E_BUDGET', result.message, {
            remainingCredits: await computeRemainingTreeCredits(
              store,
              input.rootTaskId,
              input.maxFanOut,
              input.parentKey,
            ),
            requestedCredits: input.childCapMicro === null ? null : credits(input.childCapMicro),
          })
        }
        throw new CoreError(
          result.reason === 'fan_out' || result.reason === 'generation' ? 'E_CHILD_LIMIT' : 'E_UNSUPPORTED',
          result.message,
        )
      }
      const { childKey, creationId, attemptId, creationRevision: expectedRevision } = result.record
      return new ChildAdmissionGuard(
        result.record,
        async () => {
          if (result.status !== 'created') return
          try {
            await store.cancelCreatingChild({
              childKey,
              creationId,
              attemptId,
              expectedRevision,
              reason: 'open_failed',
              cancelledAt: clock(),
            })
          } catch (error) {
            if (!(error instanceof CoreError && error.code === 'E_CAS')) throw error
            const live = await store.lookupByKey(childKey)
            if (!live || live.attemptId !== attemptId || isTerminalChildState(live.state)) return
            // Defer and bind may have persisted their phase before the handle was returned.
            if (
              live.creationPhase === 'creating' ||
              !(await store.casState(childKey, live.stateRevision, 'cancelled'))
            )
              throw error
          }
        },
        untrack,
      )
    } catch (error) {
      untrack()
      throw error
    }
  }

  /** Transfer cleanup to the bound handle (or durable deferred handle). Binding owns its creation CAS. */
  commit(): void {
    if (this.released) throw new CoreError('E_CAS', 'child admission was released')
    this.committed = true
    this.untrack()
  }

  async release(): Promise<void> {
    if (this.committed) return
    this.released ??= this.rollback()
      .catch((error) => {
        this.released = undefined
        throw error
      })
      .finally(this.untrack)
    await this.released
  }

  async bind<T>(attach: (record: ChildTaskRecord) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.binding || this.released || this.committed)
      throw new CoreError('E_CAS', 'child admission already used')
    this.binding = true
    try {
      signal?.throwIfAborted()
      const bound = await attach(this.record)
      signal?.throwIfAborted()
      this.commit()
      return bound
    } finally {
      await this.release()
    }
  }
}
