import { scanAll } from '@agnes/core'
import type { Context } from '@agnes/cordis'
import { unavailableProjections } from '@agnes/extension-api'
import {
  intelligentUiKind,
  UI_EVENTS,
  UI_OWNER,
  type IntelligentUiInstance,
} from '@agnes/base/intelligent-ui'
import type { ServiceCall, ServiceDescriptor } from '@agnes/host-common/assemble/service-binding'
import type { DeferredInvocationsService } from '@agnes/host-providers/assemble/deferred-invocations'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import {
  rpcError,
  type Actor,
  type UiActionParams,
  type UiActionReceipt,
  type UiReadParams,
  type UiReadResult,
} from '@agnes/protocol'
import type { ExtensionServiceHost } from '../services/author-port.js'
import {
  createSessionLedger,
  sessionInputTarget,
  type SessionLedgerSession,
} from '../services/session-ports.js'
import type { HostSession } from '../lifecycle/host.js'
import { enqueueSessionInputOnce } from './deferred-invocations.js'
import { readUiComponentDeclarations } from './ui-component-declarations.js'

const READER: Actor = { id: UI_OWNER, org: 'local', role: 'extension', deptPath: [], attrs: {} }
const UNAVAILABLE = 'Intelligent UI plugin unavailable'

function denied(reason?: string): never {
  throw rpcError('CAPABILITY_DENIED', reason === undefined ? undefined : { reason })
}

async function actorForUiResult(session: HostSession, owner: string, key: string): Promise<Actor> {
  if (!key.startsWith('ui-result:')) denied()
  const commandId = key.slice('ui-result:'.length)
  const rows = await scanAll((query) => session.scan(query), {
    type: `x/${owner}/action.received`,
    lane: session.lane,
    fromSeq: (session.d.log.parent?.boundarySeq ?? 0) + 1,
    toSeq: session.lastSeq,
  })
  let actor: Actor | undefined
  for (const row of rows) {
    if (row.origin !== `ext:${owner}` || row.trust !== 'untrusted') continue
    const record = (row.data as { record?: { request?: { commandId?: string }; actor?: Actor } }).record
    if (record?.request?.commandId !== commandId || !record.actor?.id || !record.actor.org) continue
    actor = record.actor
  }
  if (!actor) denied()
  return actor
}

/**
 * Session and producer entry for the intelligent-ui service kind.
 * The deferred queue stays the existing host implementation; only the author channel moved.
 */
export function createIntelligentUiBridge(input: {
  extensionHost: ExtensionServiceHost
  profileDir: string
  sessionGeneration: (sessionKey: string) => string | undefined
  session: (key: string) => HostSession | undefined
}) {
  const deferredServices = new Set<DeferredInvocationsService>()
  let hooked = false
  const enabled = () => input.extensionHost.packageFor(intelligentUiKind, UI_OWNER) !== undefined
  const queueFor = (key: string, lane: string) => {
    for (const service of deferredServices) {
      try {
        const queue = service.forSession(key, lane)
        if (queue) return queue
      } catch {
        deferredServices.delete(service)
      }
    }
    return undefined
  }
  const generationOf = (session: HostSession) =>
    input.sessionGeneration(session.key) ?? session.pluginGenerationId
  const requireSession = (key: string, lane: string): HostSession => {
    const session = input.session(key)
    if (!session || session.closingOrClosed || session.lane !== lane) denied(UNAVAILABLE)
    return session
  }
  const bind = async (
    session: HostSession,
    actor: Actor,
    signal: AbortSignal,
  ): Promise<IntelligentUiInstance> => {
    const packageId = input.extensionHost.packageFor(intelligentUiKind, UI_OWNER)
    const generationId = generationOf(session)
    if (!packageId || !generationId || session.closingOrClosed) denied(UNAVAILABLE)
    const queue = queueFor(session.key, session.lane)
    if (!queue) denied()
    const call: ServiceCall = {
      owner: UI_OWNER,
      packageId,
      session: { key: session.key, lane: session.lane, workspaceRoot: session.d.cwd },
      generationId,
      signal,
      watermark: session.lastSeq,
      actor,
      live: () => {
        if (session.closingOrClosed || signal.aborted) return undefined
        if (generationOf(session) !== generationId) return undefined
        const current = input.session(session.key)
        if (current && (current !== session || current.closingOrClosed || current.lane !== session.lane))
          return undefined
        return { owner: UI_OWNER, active: true, generationId }
      },
    }
    return input.extensionHost.bindHost(intelligentUiKind, call, {
      ledger: (boundCall, _binding, descriptor) =>
        createSessionLedger(session as unknown as SessionLedgerSession, {
          kind: intelligentUiKind.kind,
          owner: UI_OWNER,
          eventNames: descriptor.eventNames ?? [],
          watermark: boundCall.watermark ?? session.lastSeq,
          trust: 'trusted',
          alive() {
            if (session.closingOrClosed || signal.aborted) denied(UNAVAILABLE)
          },
        }),
      projections: unavailableProjections,
      lastSeq: () => session.lastSeq,
      now: () => Date.now(),
    })
  }
  const run = async <T>(
    session: HostSession,
    actor: Actor,
    signal: AbortSignal,
    op: (ui: IntelligentUiInstance) => Promise<T>,
  ): Promise<T> => {
    if (session.closingOrClosed || !enabled()) denied(UNAVAILABLE)
    const ui = await bind(session, actor, signal)
    try {
      return await op(ui)
    } finally {
      try {
        await ui.dispose?.()
      } catch {
        // Disposal checks the same admission. It must not replace the action result.
      }
    }
  }
  const descriptor: ServiceDescriptor = {
    ports: ['ledger', 'input', 'projections'],
    eventNames: UI_EVENTS,
    projectionNames: ['surfaces'],
    audience: 'callback',
    delivery: 'follow-steer',
    dedupeKeys: 'exact',
    capabilities(call) {
      const ref = call.session
      if (!ref) denied(UNAVAILABLE)
      const session = requireSession(ref.key, ref.lane)
      const found = queueFor(session.key, session.lane)
      if (!found) denied()
      return {
        taskId: () => {
          const live = requireSession(session.key, session.lane)
          return `${live.key}:${live.lane}:turn:${live.lastTurnNumber()}`
        },
        supportsDeferredInvocations: session.d.loopFactory.capabilities.includes('deferred-invocations'),
        components: () => readUiComponentDeclarations(input.profileDir, session.key),
        queue: found,
        tools: () => requireSession(session.key, session.lane).currentTools().list(),
        invocationId: async (toolUseId: string) => {
          const live = requireSession(session.key, session.lane)
          const rows = await scanAll((query) => live.scan(query), {
            type: 'x/core/loop-effect',
            lane: live.lane,
            fromSeq: (live.d.log.parent?.boundarySeq ?? 0) + 1,
            toSeq: live.lastSeq,
          })
          const row = rows.find(
            (item) =>
              item.origin === 'system' &&
              item.trust === 'trusted' &&
              (item.data as { toolUseId?: string }).toolUseId === toolUseId,
          )
          return (row?.data as { invocationId?: string } | undefined)?.invocationId
        },
        authenticatedActor: call.actor,
      }
    },
    input(call) {
      return {
        async deliver(key, text, signal) {
          const ref = call.session
          if (!ref) denied(UNAVAILABLE)
          const session = requireSession(ref.key, ref.lane)
          const actor = await actorForUiResult(session, call.owner, key)
          return enqueueSessionInputOnce(
            session,
            key,
            text,
            actor,
            signal,
            sessionInputTarget(session, 'follow-steer'),
          )
        },
      }
    },
  }
  return {
    enabled,
    view(session: HostSession):
      | {
          action(input: UiActionParams, actor: Actor, signal: AbortSignal): Promise<UiActionReceipt>
          read(input: UiReadParams, signal: AbortSignal): Promise<UiReadResult>
        }
      | undefined {
      if (!enabled()) return undefined
      return {
        action: (params, actor, signal) =>
          run(session, actor, signal, (ui) => ui.action(params, actor, signal)),
        read: (params, signal) => run(session, READER, signal, (ui) => ui.read(params, signal)),
      }
    },
    attach(root: Context, origins: RowOriginLookup | undefined, deferred: DeferredInvocationsService): void {
      deferredServices.add(deferred)
      input.extensionHost.install(root, intelligentUiKind, descriptor, origins)
      if (hooked) return
      hooked = true
      input.extensionHost.onRegistered(intelligentUiKind, (owner) => {
        if (owner !== UI_OWNER) return () => undefined
        const service = [...deferredServices].at(-1)
        if (!service) return () => undefined
        return service.register({
          source: owner,
          validate: (invocation, signal) =>
            run(requireSession(invocation.sessionKey, invocation.lane), invocation.actor, signal, (ui) =>
              ui.validate(invocation, signal),
            ),
          changed: (receipt, signal) =>
            run(
              requireSession(receipt.invocation.sessionKey, receipt.invocation.lane),
              receipt.invocation.actor,
              signal,
              (ui) => ui.changed(receipt, signal),
            ),
        })
      })
    },
  }
}
