import type { Context } from '@agnes/cordis'
import { scanAll } from '@agnes/core'
import { ProviderError, unavailableProjections } from '@agnes/extension-api'
import {
  createLocalArtifactReadStore,
  LOCAL_ARTIFACT_READ_MAX_BYTES,
} from '@agnes/host-artifacts/artifact-read-store'
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
  UI_SOURCE_EVENTS,
  type UiSourceResolveInput,
  uiDataSourceKind,
} from '@agnes/intelligent-ui-contract'
import {
  type DeferredProducerInstance,
  deferredProducerKind,
  deferredQueueKind,
} from '@agnes/plugin-runtime/deferred-contract'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import {
  type Actor,
  jcs,
  rpcError,
  type UiActionParams,
  type UiActionReceipt,
  type UiReadParams,
  type UiReadResult,
  type UiRefreshParams,
  type UiSurfaceRecord,
} from '@agnes/protocol'
import type { HostSession } from '../lifecycle/host.js'
import type { ExtensionServiceHost } from '../services/author-port.js'
import {
  createSessionLedger,
  type SessionLedgerSession,
  sessionInputTarget,
} from '../services/session-ports.js'
import { deferredQueueFor } from './deferred-invocations.js'
import { enqueueSystemInput } from './system-input.js'
import { createUiArtifactChecker, withUiArtifactStatuses } from './ui-artifacts.js'
import { readUiComponentDeclarations } from './ui-component-declarations.js'
import {
  dropUiDataSourceCache,
  loadUiDataSourceGrant,
  lookupUiDataSource,
  resolveUiDataSources,
  type UiDataSourceCacheEntry,
  type UiDataSourceCatalogView,
  type UiDataSourceLookup,
} from './ui-data-source.js'
import { actorForUiResult, authenticateUiAction } from './ui-result-identity.js'

const READER: Actor = { id: UI_OWNER, org: 'local', role: 'extension', deptPath: [], attrs: {} }
const UNAVAILABLE = 'Intelligent UI plugin unavailable'

/** Live provider catalog. The static resolve() return type does not carry source fields. */
export type UiDataSourceCatalog = UiDataSourceCatalogView

function denied(reason?: string): never {
  throw rpcError('CAPABILITY_DENIED', reason === undefined ? undefined : { reason })
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
  dataDir: string
  extensionHost: ExtensionServiceHost
  profileDir: string
  profileName: string
  agnesVersion: string
  sessionGeneration: (sessionKey: string) => string | undefined
  session: (key: string) => HostSession | undefined
  providers: () => UiDataSourceCatalog
}) {
  const checkArtifact = createUiArtifactChecker(
    createLocalArtifactReadStore({ dataDir: input.dataDir, maxArtifactBytes: LOCAL_ARTIFACT_READ_MAX_BYTES }),
  )
  const sourceCache = new Map<string, UiDataSourceCacheEntry>()
  const sourceValidators = new Map<string, ((data: unknown) => boolean) | 'invalid'>()
  const semanticCalls = new WeakSet<ServiceCall>()
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
    actionRequest?: UiActionParams,
  ): Promise<IntelligentUiInstance> => {
    const packageId = input.extensionHost.packageFor(intelligentUiKind, UI_OWNER)
    const generationId = generationOf(session)
    if (!packageId || !generationId || session.closingOrClosed) denied(UNAVAILABLE)
    const queue = deferredQueueFor(session)?.forSession(session.key, session.lane)
    if (!queue) denied()
    const actionAdmission = actionRequest
      ? { request: structuredClone(actionRequest), actor: structuredClone(actor) }
      : undefined
    const call: ServiceCall = {
      owner: UI_OWNER,
      packageId,
      session: { key: session.key, lane: session.lane, workspaceRoot: session.workspaceRoot },
      generationId,
      signal,
      watermark: session.lastSeq,
      actor: structuredClone(actor),
      live: () => {
        if (session.closingOrClosed || signal.aborted) return undefined
        if (generationOf(session) !== generationId) return undefined
        const current = input.session(session.key)
        if (current && (current !== session || current.closingOrClosed || current.lane !== session.lane))
          return undefined
        return { owner: UI_OWNER, active: true, generationId }
      },
    }
    semanticCalls.add(call)
    return input.extensionHost.bindHost(intelligentUiKind, call, {
      ledger: (boundCall, _binding, descriptor) => {
        const ledger = createSessionLedger(session as unknown as SessionLedgerSession, {
          kind: intelligentUiKind.kind,
          owner: UI_OWNER,
          eventNames: descriptor.eventNames ?? [],
          watermark: boundCall.watermark ?? session.lastSeq,
          trust: 'trusted',
          alive() {
            if (session.closingOrClosed || signal.aborted) denied(UNAVAILABLE)
          },
        })
        return {
          ...ledger,
          async appendOwn(name, data, sourceSeq) {
            if (name === 'action.received' && actionAdmission) {
              const request = (data as { record?: { request?: UiActionParams } }).record?.request
              if (!request || jcs(request) !== jcs(actionAdmission.request)) denied()
              await authenticateUiAction(session, actionAdmission.request, actionAdmission.actor, signal)
            }
            return ledger.appendOwn(name, data, sourceSeq)
          },
        }
      },
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
    actionRequest?: UiActionParams,
  ): Promise<T> => {
    if (session.closingOrClosed || !enabled()) denied(UNAVAILABLE)
    const ui = await bind(session, actor, signal, actionRequest)
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
          providerId: UI_PROVIDER_ID,
          session: { key: session.key, lane: session.lane, workspaceRoot: session.workspaceRoot },
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
  const findSource = (id: string): UiDataSourceLookup => {
    try {
      return lookupUiDataSource(input.providers(), id)
    } catch {
      return { status: 'unknown' }
    }
  }
  const sourceDescriptor: ServiceDescriptor = {
    ports: [],
    audience: 'host',
    capabilities(call) {
      if (!call.actor?.id || !call.session || !call.generationId) denied()
      return { actor: call.actor, session: call.session, generationId: call.generationId }
    },
  }
  const descriptor: ServiceDescriptor = {
    ports: ['ledger', 'input', 'projections'],
    eventNames: [...UI_EVENTS, ...UI_SOURCE_EVENTS],
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
        owner: call.owner,
        actor: structuredClone(call.actor),
        confirmSource: (seq, source, signal) =>
          confirmDeferredSource(session, call.owner, seq, source, signal),
      })
      if (!found) denied()
      return {
        checkArtifact: (ref: import('@agnes/protocol').ArtifactRef, signal: AbortSignal) =>
          checkArtifact(requireSession(session.key, session.lane), ref, signal),
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
        authenticatedActor: structuredClone(call.actor),
        resolveSources: (request: UiSourceResolveInput) => {
          const live = requireSession(session.key, session.lane)
          const generationId = generationOf(live)
          const actor = call.actor
          if (!generationId || !actor?.id || !call.session) denied(UNAVAILABLE)
          return resolveUiDataSources(request, {
            actor,
            generationId,
            session: call.session,
            cache: sourceCache,
            validators: sourceValidators,
            find: findSource,
            grant: (packageId) =>
              loadUiDataSourceGrant({
                profileDir: input.profileDir,
                profile: input.profileName,
                agnesVersion: input.agnesVersion,
                generationId,
                packageId,
              }),
            declarations: () => readUiComponentDeclarations(input.profileDir, live.key),
            open: async (registration, signal) => {
              const instance = await input.extensionHost.bindHost(uiDataSourceKind, {
                owner: call.owner,
                packageId: registration.sourcePackage,
                providerId: registration.id,
                session: call.session,
                generationId,
                signal,
                actor,
                live: () => {
                  if (signal.aborted || live.closingOrClosed) return undefined
                  if (generationOf(live) !== generationId) return undefined
                  return { owner: call.owner, active: true, generationId }
                },
              })
              return {
                query: (params, querySignal) => instance.query(params, querySignal),
                dispose: async () => {
                  await instance.dispose?.()
                },
              }
            },
          })
        },
        dropSources: (surfaceId: string) => dropUiDataSourceCache(sourceCache, session.key, surfaceId),
      }
    },
    input(call) {
      if (!call.actor) denied()
      const authenticatedActor = structuredClone(call.actor)
      const semantic = semanticCalls.has(call)
      return {
        async deliver(key, input, signal) {
          const ref = call.session
          if (!ref) denied(UNAVAILABLE)
          const session = requireSession(ref.key, ref.lane)
          const actor = await actorForUiResult(session, call.owner, key, authenticatedActor, semantic)
          return enqueueSystemInput(
            session,
            key,
            { ...input, source: call.owner },
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
          refresh(input: UiRefreshParams, signal: AbortSignal): Promise<UiSurfaceRecord>
        }
      | undefined {
      if (!enabled()) return undefined
      const decorate = (record: UiSurfaceRecord, signal: AbortSignal) =>
        withUiArtifactStatuses(
          record,
          async (ref, checking) => {
            if (record.lane !== session.lane) return 'not_found'
            return checkArtifact(requireSession(session.key, session.lane), ref, checking)
          },
          signal,
        )
      return {
        action: (params, actor, signal) =>
          run(session, actor, signal, (ui) => ui.action(params, actor, signal), params),
        read: async (params, signal) => {
          const page = await run(session, READER, signal, (ui) => ui.read(params, signal))
          const surfaces: UiSurfaceRecord[] = []
          for (const record of page.surfaces) surfaces.push(await decorate(record, signal))
          return { ...page, surfaces }
        },
        refresh: async (params, signal) =>
          decorate(await run(session, READER, signal, (ui) => ui.refresh(params, signal)), signal),
      }
    },
    attach(root: Context, origins: RowOriginLookup | undefined, deferred: DeferredInvocationsService): void {
      input.extensionHost.install(root, intelligentUiKind, descriptor, origins)
      input.extensionHost.install(root, uiDataSourceKind, sourceDescriptor, origins)
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
