/**
 * The Superagent plugin: one profile-managed service that owns the store and the bundled-app grant, and two hooks that
 * decide synchronously from the service's snapshot. Starting the service only opens the store, registers its shutdown
 * and reports ready; longer work is registered on the service and runs after `start()` has returned.
 */
import { join } from 'node:path'
import type { PluginContextFacets, ProfileManagedInit, ToolResult } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { openStore, type Store } from '../app/store.js'
import { createHookStateCell, type HookStateCell } from './hook-state.js'
import { asSdkClient } from './sdk.js'

export type { HookState, HookStateCell } from './hook-state.js'
export { INERT_HOOK_STATE } from './hook-state.js'
export { asSdkClient, type SdkClient } from './sdk.js'

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

/** The id of the managed service; the Host adds `superagent.status`, `.configure` and the other generic services. */
export const SERVICE_ID = 'superagent'
/** The database file in the grant's state directory. */
export const DATABASE_FILE = 'superagent.sqlite'

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const
const unavailable = (what: string) =>
  Object.assign(new Error(`${what} is not available in this Superagent build`), { code: 'CAPABILITY_DENIED' })

/** A running service: what it holds, and the registered parts. */
function createService(store: Store): SuperagentService & { readonly store: Store } {
  const parts = new Map<SuperagentSlot, unknown>()
  return {
    store,
    async handleTool({ toolName }) {
      return { content: [{ type: 'text', text: `${toolName} is not available yet` }], isError: true }
    },
    async callService(name) {
      throw unavailable(`The service ${name}`)
    },
    register(slot, part) {
      if (parts.has(slot)) throw new Error(`The Superagent ${slot} part is already registered`)
      parts.set(slot, part)
    },
  }
}

/**
 * Starts the service. It needs the release grant: a payload installed from any other source, or one whose bytes differ
 * from the shipped snapshot, gets no grant and does not start. The shutdown is registered first, so a refused start
 * still reports a confirmed shutdown rather than possibly leaked resources.
 */
async function start(init: ProfileManagedInit, hooks: HookStateCell): Promise<SuperagentService> {
  let store: Store | undefined
  init.onShutdown(async () => {
    hooks.clear()
    store?.close()
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
  store = openStore(join(grant.stateDirectory, DATABASE_FILE))
  const service = createService(store)
  init.ready()
  return service
}

/** The plugin row `ext:agnes.superagent/main`. */
export const superagentPlugin = {
  inject: ['hooks', 'tools', 'services', 'self', 'profileRuntime'] as const,
  apply(plugin: PluginContextFacets) {
    const hooks = createHookStateCell()
    plugin.profileRuntime.register<SuperagentService>({
      id: SERVICE_ID,
      configSchema: EMPTY_SCHEMA,
      defaultConfig: {},
      start: (init) => start(init, hooks),
    })
    const disposers = [
      // Both hooks run for every session of the profile; an owner's own session is never touched.
      plugin.hooks.register('context', (_payload, ctx) => {
        const state = hooks.get()
        if (!state.isSuperagentSession(ctx.session.key)) return {}
        return { refreshOnRequest: true, sections: state.promptSections(ctx.session.key).stable }
      }),
      plugin.hooks.register('tool_call', (payload, ctx) => {
        const state = hooks.get()
        if (!state.isSuperagentSession(ctx.session.key)) return { allow: true }
        const reason = state.guardTool({
          sessionId: ctx.session.key,
          toolName: payload.name,
          input: payload.args,
        })
        return reason === undefined ? { allow: true } : { allow: false, reason }
      }),
    ]
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  },
}
