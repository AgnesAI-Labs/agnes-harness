import type { Context } from '@agnes/cordis'
import { scanAll } from '@agnes/core'
import { ProviderError, unavailableProjections } from '@agnes/extension-api'
import type { ServiceCall, ServiceDescriptor } from '@agnes/host-common/assemble/service-binding'
import {
  DEFERRED_INVOCATION_EVENT,
  DEFERRED_NOTIFICATION_EVENT,
  type DeferredInvocationsService,
} from '@agnes/host-providers/assemble/deferred-invocations'
import {
  type IntelligentUiInstance,
  intelligentUiKind,
  UI_EVENTS,
  UI_OWNER,
  UI_PROVIDER_ID,
  UI_PROVIDER_VERSION,
} from '@agnes/intelligent-ui-contract'
import {
  type DeferredProducerInstance,
  deferredProducerKind,
  deferredQueueKind,
} from '@agnes/plugin-runtime/deferred-contract'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import {
  type Actor,
  rpcError,
  type UiActionParams,
  type UiActionReceipt,
  type UiReadParams,
  type UiReadResult,
} from '@agnes/protocol'
import type { HostSession } from '../lifecycle/host.js'
import type { ExtensionServiceHost } from '../services/author-port.js'
import {
  createSessionLedger,
  type SessionLedgerSession,
  sessionInputTarget,
} from '../services/session-ports.js'
import { deferredQueueFor, enqueueSessionInputOnce } from './deferred-invocations.js'
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

async function confirmDeferredSource(
  session: HostSession,
  owner: string,
  seq: number,
  source: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  if (source !== owner || !Number.isSafeInteger(seq) || seq < 1)
    throw new Error('Deferred invocation source event is not admissible')
  const rows = await scanAll((query) => session.scan(query), {
    lane: session.lane,
    fromSeq: seq,
    toSeq: seq,
  })
  const row = rows.find((item) => item.seq === seq)
  if (!row) throw new Error('Deferred invocation source event is missing')
  if (row.type === DEFERRED_INVOCATION_EVENT || row.type === DEFERRED_NOTIFICATION_EVENT)
    throw new Error('Deferred invocation source event is not admissible')
  const ownExtension = row.origin === `ext:${owner}`
  const trustedSystem = row.origin === 'system' && row.trust === 'trusted'
  if (!ownExtension && !trustedSystem) throw new Error('Deferred invocation source event is not admissible')
}

/**
 * Session entry for the intelligent-ui service kind.
 * The deferred queue is the host session service. This bridge is one deferred-producer owner.
 */
export function createIntelligentUiBridge(input: {
  extensionHost: ExtensionServiceHost
  profileDir: string
  sessionGeneration: (sessionKey: string) => string | undefined
  session: (key: string) => HostSession | undefined
}) {
  let hooked = false
  const enabled = () => input.extensionHost.packageFor(intelligentUiKind, UI_OWNER) !== undefined
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
    const queue = deferredQueueFor(session)?.forSession(session.key, session.lane)
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
  const openProducer = async (source: string, sessionKey: string, lane: string, signal: AbortSignal) => {
    const packageId = input.extensionHost.packageFor(deferredProducerKind, source)
    const session = input.session(sessionKey)
    const generationId = session ? generationOf(session) : undefined
    if (!packageId || !session || session.closingOrClosed || session.lane !== lane || !generationId)
      return undefined
    let instance: DeferredProducerInstance
    try {
      instance = await input.extensionHost.bindHost(
        deferredProducerKind,
        {
          owner: source,
          packageId,
          session: { key: session.key, lane: session.lane, workspaceRoot: session.d.cwd },
          generationId,
          signal,
          live: () => {
            if (session.closingOrClosed || signal.aborted) return undefined
            if (generationOf(session) !== generationId) return undefined
            const current = input.session(session.key)
            if (current && (current !== session || current.closingOrClosed || current.lane !== session.lane))
              return undefined
            return { owner: source, active: true, generationId }
          },
        },
        { now: () => Date.now() },
      )
    } catch (error) {
      if (error instanceof ProviderError) return undefined
      throw error
    }
    let spent = false
    const finish = async () => {
      if (spent) return
      spent = true
      try {
        await instance.dispose?.()
      } catch {
        // Admission already completed. Disposal must not replace the producer result.
      }
    }
    return {
      source,
      async validate(
        invocation: Parameters<DeferredProducerInstance['validate']>[0],
        producerSignal: AbortSignal,
      ) {
        try {
          await instance.validate(invocation, producerSignal)
        } finally {
          await finish()
        }
      },
      async changed(
        receipt: Parameters<DeferredProducerInstance['changed']>[0],
        producerSignal: AbortSignal,
      ) {
        try {
          await instance.changed(receipt, producerSignal)
        } finally {
          await finish()
        }
      },
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
      if (!call.actor) denied()
      const found = deferredQueueFor(session)?.ownerFacade(session.key, session.lane, {
        owner: UI_OWNER,
        actor: call.actor,
        confirmSource: (seq, source, signal) => confirmDeferredSource(session, UI_OWNER, seq, source, signal),
      })
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
      input.extensionHost.install(root, intelligentUiKind, descriptor, origins)
      input.extensionHost.install(root, deferredQueueKind, { ports: [], audience: 'host' }, origins)
      input.extensionHost.install(root, deferredProducerKind, { ports: [], audience: 'callback' }, origins)
      deferred.setProducerResolver((source, sessionKey, lane, signal) =>
        openProducer(source, sessionKey, lane, signal),
      )
      if (hooked) return
      hooked = true
      input.extensionHost.onRegistered(intelligentUiKind, (owner, packageId) => {
        if (owner !== UI_OWNER) return () => undefined
        const release = input.extensionHost.ports.register(
          deferredProducerKind,
          {
            id: UI_PROVIDER_ID,
            version: UI_PROVIDER_VERSION,
            open() {
              const producer: DeferredProducerInstance = {
                validate: (invocation, signal) =>
                  run(
                    requireSession(invocation.sessionKey, invocation.lane),
                    invocation.actor,
                    signal,
                    (ui) => ui.validate(invocation, signal),
                  ),
                changed: (receipt, signal) =>
                  run(
                    requireSession(receipt.invocation.sessionKey, receipt.invocation.lane),
                    receipt.invocation.actor,
                    signal,
                    (ui) => ui.changed(receipt, signal),
                  ),
              }
              return producer
            },
          },
          { owner, packageId },
        )
        return () => {
          void release()
        }
      })
    },
  }
}
