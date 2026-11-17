/**
 * The Superagent plugin: one profile-managed service that owns the store, the bundled-app grant and the app, the
 * `orchestrator_*` tools that reach that service through its handle, and two hooks that decide synchronously from the
 * service's hook state. Starting the service only opens the store, builds the app, registers the shutdown and reports
 * ready; the app starts after `start()` has returned.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BundledAppGrant,
  PluginContextFacets,
  ProfileManagedInit,
  ToolResult,
} from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { openStore, type Store } from '../app/store.js'
import { type Machine, machineOf, type Probe } from '../deployment.js'
import { HOST_PLATFORM, isWindows, pathsOf } from '../infra/platform.js'
import type { createRuntimeParts, SuperagentApp } from './app.js'
import { attachFeishu } from './feishu-read-tool.js'
import { composeGeneration, type Generation } from './generation.js'
import { type HookStateCell, type HookStateHolder, processHookState } from './hook-state.js'
import { registerHooks } from './hooks.js'
import type { LifecycleDeps } from './lifecycle.js'
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
  /** Backend upgrade authority reads only the current starting service's durable registrations. */
  upgradeSessionIds(): string[]
  handleTool(call: {
    sessionId: string
    toolName: string
    input: unknown
    signal: AbortSignal
  }): Promise<Pick<ToolResult, 'content' | 'isError'>>
  callService(name: string, input: unknown, signal: AbortSignal): Promise<JsonValue>
  register(slot: SuperagentSlot, part: unknown): void
}
/** The lifecycle the service registers: it starts the app, reconciles the sessions and sets the hook state, and stops it. */
export interface LifecyclePart {
  start(): Promise<void>
  stop(reason: 'disable' | 'generation' | 'shutdown'): Promise<void>
}
/** What a part registered on the service works with. */
export interface RuntimeContext {
  readonly init: ProfileManagedInit
  readonly grant: BundledAppGrant
  readonly store: Store
  /** This generation's hold of the process's hook state, which its lifecycle sets and clears. */
  readonly hooks: HookStateCell
  readonly app: SuperagentApp
  readonly runtime: ReturnType<typeof createRuntimeParts>
}

/** The id of the managed service; the Host adds `superagent.status`, `.configure` and the other generic services. */
export const SERVICE_ID = 'superagent'
/** The database file in the state directory. */
export const DATABASE_FILE = 'superagent.sqlite'
export { STOPPED } from './generation.js'

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const
const denied = (what: string) =>
  Object.assign(new Error(`${what} is not available in this Superagent build`), { code: 'CAPABILITY_DENIED' })
const stopReason = (reason: 'disable' | 'upgrade' | 'exit') =>
  reason === 'disable' ? 'disable' : reason === 'upgrade' ? 'generation' : 'shutdown'

const isLifecycle = (part: unknown): part is LifecyclePart =>
  !!part &&
  typeof (part as Partial<LifecyclePart>).start === 'function' &&
  typeof (part as Partial<LifecyclePart>).stop === 'function'

/** A running service: the app, the panel wiring and the registered parts. */
function createService(
  app: SuperagentApp,
  parts: Map<SuperagentSlot, unknown>,
  panel: PanelWiring,
  upgradeSessionIds: () => string[],
): SuperagentService & { readonly panel: PanelWiring } {
  return {
    upgradeSessionIds,
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
      if (slot === 'lifecycle' && !isLifecycle(part))
        throw new TypeError('A lifecycle has start() and stop()')
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

/** What a test may set of a service it starts. */
export interface ServiceOptions {
  /** The plugin's configuration (machine settings); by default none, which keeps the state in the grant's directory. */
  config?: unknown
  /** Dependencies of the lifecycle that replace the composed ones. */
  lifecycle?: Partial<LifecycleDeps>
  /** How the app probes the deployment; by default the agent's `gh` as worker shells run it. */
  probe?: Probe
}

/**
 * The plugin's machine settings, with the state directory the platform gave Superagent when the configuration names
 * none.
 */
export function machineConfig(
  config: unknown,
  stateDirectory: string,
  platform: string = HOST_PLATFORM,
): Machine {
  const given = config && typeof config === 'object' ? (config as Record<string, unknown>) : {}
  const machine = machineOf({ ...given, stateDir: given.stateDir ?? stateDirectory }, platform)
  // On Windows only the platform's directory is private (its access list admits the current user alone, and what is
  // created in it inherits that); Superagent does not set access lists itself.
  const paths = pathsOf(platform)
  const rest = paths.relative(stateDirectory, machine.stateDir)
  const outside = rest === '..' || rest.startsWith(`..${paths.sep}`) || paths.isAbsolute(rest)
  if (isWindows(platform) && outside)
    throw new Error(
      `On Windows Superagent keeps its state in the private directory the platform gives it, ${stateDirectory}; remove stateDir from its configuration, or name a directory inside that one`,
    )
  return machine
}

/**
 * Starts the service. It needs the release grant: a payload installed from any other source, or one whose bytes differ
 * from the shipped snapshot, gets no grant and does not start. The shutdown is registered first, so a refused start
 * still reports a confirmed shutdown rather than possibly leaked resources. The service builds its whole generation
 * at once (see `composeGeneration`), takes the process's hook state over with Superagent's sessions refused, reports
 * ready and leaves the rest to the lifecycle, which begins after `start()` has returned. Its shutdown stops the
 * lifecycle, then replaces the hook state, unless a newer generation took it over meanwhile, with a refusal of
 * Superagent's sessions that keeps their live notes, and closes the store.
 */
export async function startService(
  init: ProfileManagedInit,
  holder: HookStateHolder,
  log: { warn(message: string): void },
  options: ServiceOptions = {},
): Promise<SuperagentService> {
  let store: Store | undefined
  let generation: Generation | undefined
  const lifetime = new AbortController()
  init.onShutdown(async (reason) => {
    lifetime.abort()
    try {
      await generation?.lifecycle.stop(stopReason(reason))
    } finally {
      closeGeneration(generation?.hooks, store)
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
  const machine = machineConfig(options.config, grant.stateDirectory)
  mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
  const opened = openStore(join(machine.stateDir, DATABASE_FILE))
  store = opened
  const panel = createPanelWiring(opened, machine.stateDir)
  const composed = composeGeneration({
    grant,
    store: opened,
    machine,
    holder,
    lifetime: lifetime.signal,
    log,
    panel,
    ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
    ...(options.probe ? { probe: options.probe } : {}),
  })
  generation = composed
  const parts = new Map<SuperagentSlot, unknown>()
  const service = createService(composed.app, parts, panel, () => {
    grant.assertCurrent()
    if (composed.lifecycle.status().state !== 'starting') throw denied('Session upgrade')
    return composed.runtime.registry.ids().filter((id) => {
      const role = composed.runtime.registry.role(id)
      if (role?.kind === 'orchestrator') return true
      const ticket = role?.kind === 'worker' ? opened.tickets.get(role.ticketId) : undefined
      return ticket !== undefined && !ticket.ended
    })
  })
  service.register('services', createPanelServices(panel.host))
  service.register('lifecycle', composed.lifecycle)
  // The Feishu Source and its worker tool join the app before the lifecycle starts it.
  service.register('feishu', attachFeishu({ app: composed.app }, log))
  init.ready()
  // The lifecycle begins once `start()` has returned; it reports its own failures through its status.
  void composed.lifecycle
    .start()
    .catch((error: unknown) => log.warn(`Superagent did not start: ${String(error)}`))
  return service
}

/** The plugin row `ext:agnes.superagent/main`. */
export const superagentPlugin = {
  inject: ['hooks', 'tools', 'services', 'self', 'profileRuntime'] as const,
  apply(plugin: PluginContextFacets, config?: unknown) {
    const hooks = processHookState()
    const log = { warn: (message: string) => plugin.self.log.warn(message) }
    const handle = plugin.profileRuntime.register<SuperagentService>({
      id: SERVICE_ID,
      configSchema: EMPTY_SCHEMA,
      defaultConfig: {},
      start: (init) => startService(init, hooks, log, { config }),
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
