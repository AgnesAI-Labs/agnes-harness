/**
 * The Superagent plugin: one profile-managed service that owns the store, the bundled-app grant and the app, the
 * `orchestrator_*` tools that reach that service through its handle, and two hooks that decide synchronously from the
 * service's hook state. Starting the service only opens the store, builds the app, registers the shutdown and reports
 * ready; the app starts after `start()` has returned.
 */
import { join } from 'node:path'
import type {
  BundledAppGrant,
  PluginContextFacets,
  ProfileManagedInit,
  ToolResult,
} from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { openStore, type Store } from '../app/store.js'
import { createRuntimeParts, createSuperagentApp, type SuperagentApp } from './app.js'
import { claimHookState, type HookStateCell, type HookStateHolder, processHookState } from './hook-state.js'
import { registerHooks } from './hooks.js'
import { createPanelWiring, type PanelWiring } from './panel-host.js'
import { asSdkClient } from './sdk.js'
import { createPanelServices, type PanelService, registerPanelServices } from './services.js'
import { registerTools } from './tools.js'

export type { AppDeps, AppParts, SuperagentApp } from './app.js'
export { createRuntimeParts, createSuperagentApp } from './app.js'
export type { Delivery } from './delivery.js'
export type { HookState, HookStateCell, HookStateHolder } from './hook-state.js'
export { INERT_HOOK_STATE, processHookState } from './hook-state.js'
export { asSdkClient, type SdkClient } from './sdk.js'
export type { SessionAdapter } from './sessions.js'

/** The parts that register on a running service: its lifecycle, the panel services and the Feishu Source. */
export type SuperagentSlot = 'lifecycle' | 'services' | 'feishu'

/** The value `handle.get()` resolves to while the service is current. */
export interface SuperagentService {
  handleTool(call: {
    sessionId: string
    toolName: string
    input: unknown
    signal: AbortSignal
  }): Promise<Pick<ToolResult, 'content' | 'isError'>>
  callService(name: string, input: unknown, signal: AbortSignal): Promise<JsonValue>
  register(slot: SuperagentSlot, part: unknown): void
}
/**
 * A registered lifecycle runs the app in place of the plain start and stop below: it starts it, reconciles the sessions
 * and sets the hook state, and stops it.
 */
export interface LifecyclePart {
  start(): Promise<void>
  stop(reason: 'disable' | 'generation' | 'shutdown'): Promise<void>
}
/** What a part registered on the service works with. */
export interface RuntimeContext {
  readonly init: ProfileManagedInit
  readonly grant: BundledAppGrant
  readonly store: Store
  /** This generation's hold of the process's hook state, which a lifecycle sets and clears. */
  readonly hooks: HookStateCell
  readonly app: SuperagentApp
  readonly runtime: ReturnType<typeof createRuntimeParts>
}

/** The id of the managed service; the Host adds `superagent.status`, `.configure` and the other generic services. */
export const SERVICE_ID = 'superagent'
/** The database file in the grant's state directory. */
export const DATABASE_FILE = 'superagent.sqlite'
/** Why Superagent's sessions are refused after the service stopped. */
export const STOPPED = 'Superagent is not running; its sessions can use tools again once it runs'

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const
const denied = (what: string) =>
  Object.assign(new Error(`${what} is not available in this Superagent build`), { code: 'CAPABILITY_DENIED' })
const stopReason = (reason: 'disable' | 'upgrade' | 'exit') =>
  reason === 'disable' ? 'disable' : reason === 'upgrade' ? 'generation' : 'shutdown'

/** A running service: the app, the panel wiring and the registered parts. */
function createService(
  app: SuperagentApp,
  parts: Map<SuperagentSlot, unknown>,
  panel: PanelWiring,
): SuperagentService & { readonly panel: PanelWiring } {
  return {
    // What the starting parts wire into the panel services (see `panel-host.ts`).
    panel,
    handleTool: (call) => app.handleTool(call),
    async callService(name, input, signal) {
      const services = parts.get('services') as PanelService | undefined
      if (!services) throw denied(`The service ${name}`)
      return services.call(name, input as JsonValue, signal)
    },
    register(slot, part) {
      if (parts.has(slot)) throw new Error(`The Superagent ${slot} part is already registered`)
      parts.set(slot, part)
    },
  }
}

/**
 * Ends a generation: leaves the stopped hook state, which is read from the store and so comes first, then closes the
 * store, also when leaving that state failed.
 */
export function closeGeneration(
  hooks: Pick<HookStateCell, 'clear'> | undefined,
  store: Pick<Store, 'close'> | undefined,
): void {
  try {
    hooks?.clear()
  } finally {
    store?.close()
  }
}

/**
 * Starts the service. It needs the release grant: a payload installed from any other source, or one whose bytes differ
 * from the shipped snapshot, gets no grant and does not start. The shutdown is registered first, so a refused start
 * still reports a confirmed shutdown rather than possibly leaked resources. The service takes the process's hook state
 * over for its generation; its shutdown replaces that state, unless a newer generation took it over meanwhile, with a
 * refusal of Superagent's sessions that keeps their live notes.
 */
export async function startService(
  init: ProfileManagedInit,
  holder: HookStateHolder,
  log: { warn(message: string): void },
): Promise<SuperagentService> {
  let store: Store | undefined
  let hooks: HookStateCell | undefined
  let stop: ((reason: 'disable' | 'generation' | 'shutdown') => Promise<void>) | undefined
  const lifetime = new AbortController()
  init.onShutdown(async (reason) => {
    lifetime.abort()
    try {
      await stop?.(stopReason(reason))
    } finally {
      closeGeneration(hooks, store)
    }
    return { state: 'settled' }
  })
  const grant = init.bundledApp
  if (!grant)
    throw Object.assign(
      new Error('Superagent runs only from the shipped payload, which receives the bundled-app grant'),
      {
        code: 'CAPABILITY_DENIED',
      },
    )
  grant.assertCurrent()
  asSdkClient(grant.client)
  if (typeof grant.channels.subscribe !== 'function')
    throw new TypeError('The bundled-app grant has no channels')
  const opened = openStore(join(grant.stateDirectory, DATABASE_FILE))
  store = opened
  let built: SuperagentApp | undefined
  const runtime = createRuntimeParts({
    store: opened,
    grant,
    lifetime: lifetime.signal,
    log,
    environment: (ticket) =>
      Object.fromEntries(
        (built?.parts.ticketEnvironment(ticket) ?? []).map((item) => [item.key, item.value]),
      ),
  })
  const app = createSuperagentApp({ store: opened, grant, ...runtime, log })
  built = app
  const parts = new Map<SuperagentSlot, unknown>()
  const service = createService(app, parts, createPanelWiring(opened, grant.stateDirectory))
  service.register('services', createPanelServices(service.panel.host))
  const cell = claimHookState(holder, app.hookState(), () => app.stoppedState(STOPPED))
  hooks = cell
  const context: RuntimeContext = { init, grant, store: opened, hooks: cell, app, runtime }
  // Parts register here, before the app starts: service.register('lifecycle' | 'services' | 'feishu', part(context)).
  void context
  init.ready()
  // The app starts after start() returned: a registered lifecycle runs it, else it starts as it is.
  setImmediate(() => {
    if (lifetime.signal.aborted) return
    const lifecycle = parts.get('lifecycle') as LifecyclePart | undefined
    stop = lifecycle ? (reason) => lifecycle.stop(reason) : (reason) => app.stop(reason)
    const started = lifecycle ? lifecycle.start() : app.start()
    started.catch((error: unknown) => log.warn(`Superagent did not start: ${String(error)}`))
  })
  return service
}

/** The plugin row `ext:agnes.superagent/main`. */
export const superagentPlugin = {
  inject: ['hooks', 'tools', 'services', 'self', 'profileRuntime'] as const,
  apply(plugin: PluginContextFacets) {
    const hooks = processHookState()
    const log = { warn: (message: string) => plugin.self.log.warn(message) }
    const handle = plugin.profileRuntime.register<SuperagentService>({
      id: SERVICE_ID,
      configSchema: EMPTY_SCHEMA,
      defaultConfig: {},
      start: (init) => startService(init, hooks, log),
    })
    // Both hooks run for every session of the profile; an owner's own session is never touched.
    const disposers = [
      registerPanelServices(plugin, () => handle.get()),
      ...registerHooks(plugin, hooks),
      ...registerTools(plugin, handle),
    ]
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  },
}
