import { scanAll } from '@agnes/core'
import type { IntelligentUiFactory, IntelligentUiService, SessionRef } from '@agnes/extension-api'
import type { RegMeta } from '@agnes/host-extensions/ext-host/ports'
import type { DeferredInvocationsService } from '@agnes/host-providers/assemble/deferred-invocations'
import { inspectJsonData, rpcError } from '@agnes/protocol'
import type { HostSession } from '../lifecycle/host.js'
import { enqueueSessionInputOnce } from './deferred-invocations.js'

/** Transport holds no business state. The registered plugin folds the existing session ledger. */
export function createIntelligentUiAdapter(
  resolve: (ref: SessionRef) => HostSession | undefined,
  deferred: DeferredInvocationsService,
) {
  let current:
    | { factory: IntelligentUiFactory; meta: RegMeta; instances: WeakMap<HostSession, IntelligentUiService> }
    | undefined
  const get = (ref: SessionRef, ownerId?: string): IntelligentUiService => {
    const registration = current,
      session = resolve(ref)
    if (
      !registration ||
      (ownerId !== undefined && registration.meta.source !== ownerId) ||
      !session ||
      session.closingOrClosed ||
      session.lane !== ref.lane
    )
      throw rpcError('CAPABILITY_DENIED', { reason: 'Intelligent UI plugin unavailable' })
    const existing = registration.instances.get(session)
    if (existing) return existing
    const queue = deferred.forSession(session.key, session.lane)
    if (!queue) throw rpcError('CAPABILITY_DENIED')
    const owner = registration.meta.source
    const service = registration.factory({
      session: { key: session.key, lane: session.lane, workspaceRoot: session.d.cwd },
      owner,
      get lastSeq() {
        return session.lastSeq
      },
      get taskId() {
        return `${session.key}:${session.lane}:turn:${session.lastTurnNumber()}`
      },
      supportsDeferredInvocations: session.d.loopFactory.capabilities.includes('deferred-invocations'),
      queue,
      scan: () =>
        scanAll((q) => session.scan(q), {
          type: [
            `x/${owner}/surface.opened`,
            `x/${owner}/surface.updated`,
            `x/${owner}/surface.closed`,
            ...[
              'received',
              'rejected',
              'pending-approval',
              'executing',
              'succeeded',
              'failed',
              'retried',
              'delivered',
            ].map((name) => `x/${owner}/action.${name}`),
          ],
          lane: session.lane,
          fromSeq: (session.d.log.parent?.boundarySeq ?? 0) + 1,
          toSeq: session.lastSeq,
        }),
      async append(name, data, sourceSeq) {
        if (current !== registration) throw rpcError('CAPABILITY_DENIED')
        const checked = inspectJsonData(data, 65536)
        if (!checked.ok) throw rpcError('INVALID_PARAMS')
        // appendExtensionEvent owns namespace/trust. References are inside the plugin fact payload.
        return session.appendExtensionEvent(
          `x/${owner}/${name}`,
          {
            ...(data as Record<string, import('@agnes/protocol').JsonValue>),
            ...(sourceSeq ? { sourceSeq } : {}),
          },
          registration.meta,
        )
      },
      tools: () => session.d.tools.list(),
      deliver: (key, text, actor, signal) =>
        enqueueSessionInputOnce(
          session,
          key,
          text,
          actor,
          signal,
          session.op() && session.d.loopFactory.controls?.steer ? 'next-step' : 'next-turn',
        ),
      now: () => Date.now(),
    })
    registration.instances.set(session, service)
    return service
  }
  return {
    get,
    register(factory: IntelligentUiFactory, meta: RegMeta) {
      if (current) throw new Error('Intelligent UI runtime already registered')
      const registration = { factory, meta, instances: new WeakMap<HostSession, IntelligentUiService>() }
      const off = deferred.register({
        source: meta.source,
        validate: (invocation, signal) =>
          get({ key: invocation.sessionKey, lane: invocation.lane, workspaceRoot: '' }).validate(
            invocation,
            signal,
          ),
        changed: (receipt, signal) =>
          get({
            key: receipt.invocation.sessionKey,
            lane: receipt.invocation.lane,
            workspaceRoot: '',
          }).changed(receipt, signal),
      })
      current = registration
      return () => {
        off()
        if (current === registration) current = undefined
      }
    },
  }
}
