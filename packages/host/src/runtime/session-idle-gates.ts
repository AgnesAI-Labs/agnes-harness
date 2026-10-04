import { randomUUID } from 'node:crypto'
import { acquireSessionIdleGate, CoreError, KernelChildren, type SessionImpl } from '@agnes/core'
import type { SessionOwnerEvidenceStore, SessionOwnerIdentity } from '../adapters/session-owner-evidence.js'

export interface SessionIdleGatePort {
  acquire(
    input: { members: readonly SessionOwnerIdentity[]; acquisitionId?: string },
    finish?: () => void,
  ): Promise<{ token: string }>
  check(token: string): Promise<void>
  release(token: string): Promise<void>
  cancelAcquire(acquisitionId: string): Promise<void>
}
type Pin = { release(): void; run<T>(operation: () => Promise<T>): Promise<T> }
/** Exact owner + actual publication retention. This port grants no execution authority. */
export function createSessionIdleGates(
  lookup: (key: string) => SessionImpl | undefined,
  storage: Partial<SessionOwnerEvidenceStore>,
  retain: () => Pin,
): SessionIdleGatePort {
  const owners = new Map<string, { check(): void; release(): void }>()
  const releasedTokens = new Set<string>()
  const acquisitions = new Map<
    string,
    { cancelled: boolean; token: string | undefined; done: Promise<void>; complete(): void }
  >()
  return {
    async acquire(input, finish) {
      if (
        !input.members.length ||
        new Set(input.members.map((member) => member.sessionKey)).size !== input.members.length
      )
        throw new CoreError('E_RELATION', 'Idle gate members are missing or duplicated')
      const members = [...structuredClone(input.members)].sort((a, b) =>
        a.sessionKey.localeCompare(b.sessionKey),
      )
      const acquisitionId = input.acquisitionId ?? randomUUID()
      if (acquisitions.has(acquisitionId))
        throw new CoreError('E_RELATION', 'Idle acquisition already used or cancelled')
      let complete!: () => void
      const scope = {
        cancelled: false,
        token: undefined as string | undefined,
        done: new Promise<void>((resolve) => {
          complete = resolve
        }),
        complete: () => complete(),
      }
      acquisitions.set(acquisitionId, scope)
      let pin: Pin | undefined
      const guards: Array<{ check(): void; release(): void }> = []
      const subscriptions: Array<() => void> = []
      const checks: Array<() => void> = []
      let successful = false
      try {
        pin = retain()
        for (const identity of members) {
          if (scope.cancelled) throw new CoreError('E_CLOSED', 'Idle acquisition cancelled')
          const session = lookup(identity.sessionKey)
          const evidence = storage.readSessionOwnerEvidence?.(identity.sessionKey)
          const sameOwner = () => {
            const current = storage.readSessionOwnerEvidence?.(identity.sessionKey)
            if (
              !current ||
              current.owner.writerRunId !== identity.writerRunId ||
              current.owner.ownerEpoch !== identity.ownerEpoch ||
              current.owner.sessionKey !== identity.sessionKey
            )
              throw new CoreError('E_RELATION', 'Idle gate acquisition owner changed')
            return current
          }
          sameOwner()
          if (!session) {
            if (!evidence?.closed) throw new CoreError('E_CLOSED', 'Idle gate owner is unavailable')
            checks.push(() => {
              if (lookup(identity.sessionKey) || !sameOwner().closed)
                throw new CoreError('E_RELATION', 'Closed idle gate owner changed')
            })
            continue
          }
          if (evidence?.closed || session.writerRunId !== identity.writerRunId)
            throw new CoreError('E_RELATION', 'Idle gate writer differs')
          const guard = await acquireSessionIdleGate(
            session,
            () => session.d.children instanceof KernelChildren && session.d.children.allocationActive,
          )
          guards.push(guard)
          subscriptions.push(
            session.onClosing(() => {
              scope.cancelled = true
              if (scope.token) owners.get(scope.token)?.release()
            }),
          )
          checks.push(() => {
            if (lookup(identity.sessionKey) !== session || sameOwner().closed)
              throw new CoreError('E_RELATION', 'Idle gate runtime owner changed')
            guard.check()
          })
        }
        const token = randomUUID()
        const check = () => {
          if (scope.cancelled) throw new CoreError('E_CLOSED', 'Idle acquisition cancelled')
          for (const assert of checks) assert()
        }
        check()
        owners.set(token, {
          check,
          release() {
            owners.delete(token)
            releasedTokens.add(token)
            for (const off of subscriptions) off()
            pin?.release()
            for (const guard of guards.reverse()) guard.release()
            try {
              finish?.()
            } finally {
              scope.complete()
            }
          },
        })
        scope.token = token
        successful = true
        return { token }
      } finally {
        if (!successful) {
          for (const off of subscriptions) off()
          pin?.release()
          for (const guard of guards.reverse()) guard.release()
          scope.complete()
        }
      }
    },
    async check(token) {
      const owner = owners.get(token)
      if (!owner) throw new CoreError('E_RELATION', 'Idle gate unavailable')
      owner.check()
    },
    async release(token) {
      const owner = owners.get(token)
      if (!owner) {
        if (releasedTokens.has(token)) return
        throw new CoreError('E_RELATION', 'Idle gate unavailable')
      }
      owner.release()
    },
    async cancelAcquire(acquisitionId) {
      const scope = acquisitions.get(acquisitionId)
      if (!scope) {
        // Cleanup may arrive before resource preparation finished. It fences that late acquire.
        acquisitions.set(acquisitionId, {
          cancelled: true,
          token: undefined,
          done: Promise.resolve(),
          complete: () => undefined,
        })
        return
      }
      scope.cancelled = true
      if (scope.token) owners.get(scope.token)?.release()
      await scope.done
    },
  }
}
