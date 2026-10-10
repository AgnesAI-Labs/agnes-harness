import type { Context } from '@agnes/cordis'
import type { Kernel } from '@agnes/core'
import { memoryPrivateEvent, type ProviderCatalogEntry } from '@agnes/extension-api'
import { serviceBindingScope, type ServiceCall } from '@agnes/host-common/assemble/service-binding'
import type { ProvidersService } from '@agnes/host-common/assemble/provider-registry'
import { privateStateRoots } from '@agnes/host-common/paths'
import {
  observabilityKind,
  type ObservabilityProvider,
  type ObservabilitySession,
  withObservedSession,
} from '@agnes/observability'
import type { RowOriginLookup } from '@agnes/plugin-runtime/host'
import type { EventEnvelope } from '@agnes/protocol'
import type { ExtensionServiceHost } from './author-port.js'

/** Binding identity only. This kind grants no ledger or input authority. */
export const OBSERVABILITY_BINDING_OWNER = 'agnes/observability'

const EXPORTER_METHODS = [
  'bindSession',
  'observe',
  'child',
  'lifecycle',
  'queueDepth',
  'correlation',
  'flush',
  'dispose',
] as const

export function installObservabilityService(
  host: Pick<ExtensionServiceHost, 'install'>,
  root: Context,
  origins: RowOriginLookup,
): void {
  host.install(root, observabilityKind, { ports: [], audience: 'host' }, origins)
}

/** Active exporter, otherwise the sole candidate. Several unselected candidates export nothing. */
export function selectObservabilityProvider(
  entries: readonly ProviderCatalogEntry[],
): ProviderCatalogEntry | undefined {
  const exporters = entries.filter((entry) => entry.kind === observabilityKind.kind)
  return exporters.find((entry) => entry.active) ?? (exporters.length === 1 ? exporters[0] : undefined)
}

/**
 * Mandatory privacy filter. Feedback facts never reach the exporter. Memory sessions export
 * structural facts only. An exporter failure does not change execution.
 */
export function deliverCommittedEvents(
  observe: (key: string, event: Readonly<EventEnvelope>) => void,
  key: string,
  events: readonly Readonly<EventEnvelope>[],
  memory: boolean,
): void {
  for (const event of events) {
    try {
      if (event.type.startsWith('x/feedback/')) continue
      observe(key, memory ? memoryPrivateEvent(event) : event)
    } catch {
      /* Passive observation. */
    }
  }
}

export async function openObservabilityExporter(input: {
  providers: Pick<ProvidersService, 'catalog' | 'select'>
  host: Pick<ExtensionServiceHost, 'bindHost'>
  home: string
  signal: AbortSignal
}): Promise<ObservabilityProvider | undefined> {
  const owner = OBSERVABILITY_BINDING_OWNER
  try {
    const selected = selectObservabilityProvider(input.providers.catalog())
    if (!selected) return undefined
    const call: ServiceCall = {
      owner,
      packageId: selected.sourcePackage,
      processKey: input.home,
      signal: input.signal,
      live: () => ({ owner, active: !input.signal.aborted }),
    }
    const scope = serviceBindingScope(observabilityKind, call)
    input.providers.select(
      observabilityKind.kind,
      { provider: selected.id, version: selected.version },
      scope,
    )
    const instance = await input.host.bindHost(observabilityKind, call)
    return isExporter(instance) ? instance : undefined
  } catch {
    return undefined
  }
}

export async function startObservabilityFeed(input: {
  providers: Pick<ProvidersService, 'catalog' | 'select'>
  host: Pick<ExtensionServiceHost, 'bindHost'>
  home: string
  kernel: Kernel
  profileHash: string
  dataDir: string
  profileDir: string
  secretsDir?: string
  sessionGeneration?: (sessionKey: string) => string | undefined
}): Promise<{
  observability?: ObservabilityProvider
  observeSession: (key: string) => () => void
  stop?: () => void
}> {
  const controller = new AbortController()
  const observations = new Map<string, () => void>()
  const observability = await openObservabilityExporter({
    providers: input.providers,
    host: input.host,
    home: input.home,
    signal: controller.signal,
  })
  const observeSession = (key: string): (() => void) => {
    if (controller.signal.aborted || !observability) return () => undefined
    return watchSession(input, observability, key, observations)
  }
  if (!observability) {
    controller.abort()
    return { observeSession }
  }
  const offSession = input.kernel.hooks.on(
    'session_start',
    (_payload, context) => {
      observeSession(context.session.key)
    },
    { source: 'agnes/observability', trust: 'builtin', hookRank: 0 },
  )
  const offShutdown = input.kernel.hooks.on(
    'shutdown',
    (_payload, context) => {
      observations.get(context.session.key)?.()
    },
    { source: 'agnes/observability', trust: 'builtin', hookRank: 0 },
  )
  const offStart = input.kernel.hooks.on(
    'subagent_start',
    (payload, context) => {
      observability.child(context.session.key, payload.childKey, 'start')
      observeSession(payload.childKey)
    },
    { source: 'agnes/observability', trust: 'builtin', hookRank: 0 },
  )
  const offEnd = input.kernel.hooks.on(
    'subagent_end',
    (payload, context) => {
      observability.child(context.session.key, payload.childKey, 'end', payload.outcome !== 'completed')
    },
    { source: 'agnes/observability', trust: 'builtin', hookRank: 0 },
  )
  return {
    observability,
    observeSession,
    // Abort the admission. Do not dispose the facade: that decrefs the process queue while the
    // registration lease is still held, and the idempotent dispose would then skip real cleanup.
    stop: () => {
      try {
        offSession()
        offShutdown()
        offStart()
        offEnd()
        for (const cleanup of [...observations.values()]) cleanup()
      } finally {
        controller.abort()
      }
    },
  }
}

function watchSession(
  input: {
    home: string
    profileHash: string
    dataDir: string
    profileDir: string
    secretsDir?: string
    sessionGeneration?: (sessionKey: string) => string | undefined
    kernel: Kernel
  },
  observability: ObservabilityProvider,
  key: string,
  observations: Map<string, () => void>,
): () => void {
  if (observations.has(key)) return () => undefined
  const session = input.kernel.get(key)
  if (!session) return () => undefined
  const generation = input.sessionGeneration?.(key)
  const resource: ObservabilitySession = {
    workspace: session.d.cwd,
    ...(generation ? { generation, pin: generation } : { pin: input.profileHash }),
    privateRoots: [
      input.home,
      ...privateStateRoots({
        home: input.home,
        dataDir: input.dataDir,
        workspace: session.d.cwd,
        profileDir: input.profileDir,
        ...(input.secretsDir ? { secretsDir: input.secretsDir } : {}),
      }),
    ],
  }
  const release = observability.bindSession(key, resource)
  const stop = session.onAppended((events) => {
    deliverCommittedEvents(
      (sessionKey, event) => observability.observe(sessionKey, event),
      key,
      events,
      Boolean(session.d.memory),
    )
  })
  const run = session.run.bind(session)
  session.run = (options) => withObservedSession(observability, key, () => run(options))
  const cleanup = () => {
    if (!observations.delete(key)) return
    stop()
    release()
  }
  observations.set(key, cleanup)
  return cleanup
}

function isExporter(value: object): value is ObservabilityProvider {
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.version === 'string' &&
    EXPORTER_METHODS.every((name) => typeof record[name] === 'function')
  )
}
