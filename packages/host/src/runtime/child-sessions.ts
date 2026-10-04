import { CoreError, type KernelOptions, type SessionImpl } from '@agnes/core'
import type { RuntimeIdentity } from '@agnes/protocol'
import type { Assembled } from '../assemble.js'
import { HostError } from '../errors.js'
import type { ResolvedProfile } from '../profile/types.js'
import { replaySwitchesOnOpen } from '../session-switch.js'
import { openRuntimeSession, type SessionRuntimeRegistry } from './catalog.js'
import { sessionOwnerCloseFinalizer } from './session-owner-close.js'

/** Descendant construction has the same runtime lease boundary as a root, without root UI admission. */
export function createChildSessionOpener(input: {
  registry: SessionRuntimeRegistry
  assembled(): Assembled
  profile(): ResolvedProfile
  isClosed(): boolean
  openings: Set<Promise<void>>
}): {
  open: NonNullable<KernelOptions['childSessionOpen']>
  supportsRuntime(identity: Readonly<RuntimeIdentity>): boolean
} {
  const supportsRuntime = (identity: Readonly<RuntimeIdentity>) =>
    input.registry
      .list()
      .some((item) => item.id === identity.id && item.version === identity.version && item.available)
  const open: NonNullable<KernelOptions['childSessionOpen']> = async (parent, request) => {
    const check = () => {
      if (input.isClosed() || parent.closingOrClosed)
        throw new HostError('E_HOST_CLOSED', 'child owner is closing')
      request.signal.throwIfAborted()
      if (input.assembled().kernel.get(parent.key) !== parent)
        throw new HostError('E_HOST_CLOSED', 'child owner is not live')
    }
    check()
    const a = input.assembled()
    const prior = a.kernel.get(request.key)
    const failedSession = () => {
      const retained = a.kernel.get(request.key)
      return retained &&
        retained !== prior &&
        retained.writerRunId === request.options.writerRunId &&
        retained.d.runtimeOwnerSessionKey === parent.key
        ? retained
        : undefined
    }
    const ownClose = (child: SessionImpl) => {
      const close = child.close.bind(child)
      const finalize = sessionOwnerCloseFinalizer(child, a.adapters.storage, () =>
        a.unbindRuntimeSession(request.key),
      )
      child.close = async () => {
        await close()
        // A failed runtime drain retains both runtime and scoped capabilities for a retry.
        await finalize()
      }
    }
    let session: SessionImpl | undefined
    let bound = false
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    input.openings.add(pending)
    try {
      // Scope is present while the independent loop and session-start hooks are constructed.
      await a.bindRuntimeSession(request.key, request.options.preset?.name ?? parent.preset.name)
      bound = true
      check()
      session = await openRuntimeSession(input.registry, parent.runtimeIdentity, {
        failedSession,
        open: (loopFactory) =>
          a.kernel.session(request.key, {
            ...request.options,
            runtime: { ...parent.runtimeIdentity },
            ...(loopFactory ? { loopFactory } : {}),
            ...(request.seed.kind === 'history'
              ? { historySeed: { key: request.seed.parentKey, boundarySeq: request.seed.boundarySeq } }
              : {}),
          }),
      })
      const child = session
      ownClose(child)
      check()
      const recovery = await child.resume()
      if (
        request.seed.kind === 'existing' &&
        (recovery.phase === 'parked' || recovery.actions.some((action) => action.action === 'unknown'))
      )
        throw new CoreError('E_UNSUPPORTED', 'child requires effect reconciliation before continuation')
      await replaySwitchesOnOpen(child, input.profile(), a)
      check()
      return child
    } catch (error) {
      if (session) {
        await session.close()
        if (a.kernel.get(request.key) === session) a.kernel.sessions.delete(request.key)
      } else {
        const retained = failedSession()
        if (retained) ownClose(retained)
        else if (bound) await a.unbindRuntimeSession(request.key)
      }
      throw error
    } finally {
      finish()
      input.openings.delete(pending)
    }
  }
  return { open, supportsRuntime }
}
