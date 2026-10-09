import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { rpcError, type UiActionParams, type UiReadParams } from '@agnes/protocol'
import { commandBinding } from '../command-binding.js'
import { runQueued } from '../command-queue.js'
import type { AgnesContext } from './agnes.js'

/** Authentication/ownership precedes any worker lookup or command-id dedupe. */
export function registerIntelligentUi(
  endpoint: LocalEndpoint,
  cx: AgnesContext,
  owner: (method: string, sessionId: string, context: CallContext) => void,
) {
  const open = async (sessionId: string, context: CallContext) => {
    const existing = cx.registry.get(sessionId)
    if (existing) return existing
    const binding = await cx.workspaces.restoreBinding(sessionId)
    return cx.registry.open({
      key: sessionId,
      cwd: binding.canonicalRoot,
      binding,
      credential: context.conn.credential,
    })
  }
  endpoint.register('_agnes/v1/ui.action', async (input, context) => {
    const params = input as UiActionParams
    owner('ui.action', params.sessionId, context)
    if (!cx.resolveActor) throw rpcError('CAPABILITY_DENIED')
    return runQueued(cx.commandQueue, params.sessionId, context.signal, async (signal) => {
      owner('ui.action', params.sessionId, context)
      const entry = await open(params.sessionId, context)
      const actor = await cx.resolveActor!(context.conn.credential, 'session', params.sessionId)
      const service = entry.session.intelligentUi
      if (!service) throw rpcError('CAPABILITY_DENIED')
      const identity = {
        principalId: context.conn.principalId,
        clientId: 'intelligent-ui',
        sessionId: params.sessionId,
        commandId: `ui:${params.commandId}`,
      }
      const journal = await cx.journal.begin(
        identity,
        commandBinding('ui.action', params.sessionId, undefined, params),
      )
      if (journal.state === 'conflict')
        throw rpcError('SEMANTIC_REJECTED', { code: 'UI_COMMAND_CONFLICT', reason: 'duplicate' })
      if (journal.state === 'corrupt') throw rpcError('SEMANTIC_REJECTED', { code: 'UI_RECOVERY_GAP' })
      try {
        // The journal binds admission; the ledger returns the current receipt, including pending outcomes.
        const receipt = await service.action(params, actor, signal)
        if (journal.state !== 'complete') await cx.journal.complete(identity, { seq: receipt.seq })
        cx.continueFollowUps?.(entry)
        return receipt
      } catch (error) {
        if (journal.state === 'new') await cx.journal.abandon(identity)
        throw error
      }
    })
  })
  endpoint.register('_agnes/v1/ui.read', async (input, context) => {
    const params = input as UiReadParams
    owner('ui.read', params.sessionId, context)
    return runQueued(cx.commandQueue, params.sessionId, context.signal, async (signal) => {
      owner('ui.read', params.sessionId, context)
      const entry = await open(params.sessionId, context),
        service = entry.session.intelligentUi
      if (!service) throw rpcError('CAPABILITY_DENIED')
      const result = await service.read(params, signal)
      // Repair a durable queued invocation's wake after restart, through SC1's ordinary runner.
      cx.continueFollowUps?.(entry)
      return result
    })
  })
}
