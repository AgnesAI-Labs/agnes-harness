/** Client-module adapter: plugin registrations are owned by their Cordis fiber. */
import type { Context } from '@agnes/cordis'
import {
  DSH_SLOT_CATALOG_VERSION,
  getDshSlotDefinition,
  isPublicDshSlot,
  isRuntimeSupportedDshSlot,
} from './dsh-slot-catalog.js'
import { type RegisterOptions, SlotRegistry } from './registry.js'
import {
  AgnesClientService,
  type ClientCommand,
  type ClientEffectCommand,
  ClientResourceService,
  CommandService,
  LocaleService,
  type ModuleIdentity,
  SessionService,
  ThemeService,
} from './services.js'
import type { SlotName } from './slots.js'

export interface ClientModule {
  inject?: readonly string[]
  apply(ctx: ClientContext, config: ModuleIdentity): unknown
}

export interface ClientContext extends Context {
  slots: SlotRegistry
  agnes: import('./services.js').AgnesClient
  commands: {
    register(command: ClientCommand): () => void
    registerEffect(command: ClientEffectCommand): () => void
    execute(id: string, input: unknown): Promise<unknown>
  }
  module: ModuleIdentity
  session: import('./services.js').SessionService
  theme: import('./services.js').ThemeService
  locale: import('./services.js').LocaleService
  resources: ClientResourceService
}

export function clientModule(mod: ClientModule): {
  inject: string[]
  apply(ctx: Context, config: ModuleIdentity): unknown
} {
  return {
    // `ctx.agnes` is a host-owned, already-authenticated browser SDK.  Make
    // it an explicit Cordis dependency so client modules never race a partial
    // context and never manufacture a second client.
    inject: [...new Set([...(mod.inject ?? []), 'slots', 'agnes', 'commands', 'session', 'theme', 'locale'])],
    apply(ctx, config) {
      const registry = (ctx as ClientContext).slots
      if (!(registry instanceof SlotRegistry)) {
        throw new Error('clientModule requires the host-provided slots service')
      }
      const bound = createFiberBoundRegistry(
        registry,
        ctx,
        config.rowId ?? config.packageId,
        config.allowedSlots,
        config.slotCatalogVersion,
      )
      const getService = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get
      const agnes = getService?.('agnes', false)
      if (!(agnes instanceof AgnesClientService)) {
        throw new Error('clientModule requires the host-provided agnes service')
      }
      const commands = getService?.('commands', false)
      if (!(commands instanceof CommandService)) {
        throw new Error('clientModule requires the host-provided commands service')
      }
      const session = getService?.('session', false)
      if (!(session instanceof SessionService)) {
        throw new Error('clientModule requires the host-provided session service')
      }
      const resources =
        getService?.('resources', false) instanceof ClientResourceService
          ? (getService?.('resources', false) as ClientResourceService)
          : new ClientResourceService(ctx, agnes.client, session)
      const serviceApi = Object.freeze({
        call: async (name: string, input: Record<string, unknown>) => {
          if (!agnes.serviceCaller || !config.services?.includes(name))
            throw new Error(`client service is unavailable: ${name}`)
          const sessionId = session.sessionId
          if (!sessionId) throw new Error('client service requires an active session')
          return await agnes.serviceCaller(config, sessionId, name, input)
        },
      })
      const moduleAgnes = Object.freeze(
        Object.assign(Object.create(agnes.client) as import('./services.js').AgnesClient, {
          services: serviceApi,
        }),
      )
      Object.defineProperty(ctx, 'agnes', { value: moduleAgnes, configurable: true })
      const theme = getService?.('theme', false)
      if (!(theme instanceof ThemeService)) {
        throw new Error('clientModule requires the host-provided theme service')
      }
      const locale = getService?.('locale', false)
      if (!(locale instanceof LocaleService)) {
        throw new Error('clientModule requires the host-provided locale service')
      }
      const boundCommands = {
        register(command: ClientCommand) {
          const off = commands.register(config.rowId ?? config.packageId, command)
          ctx.effect(() => off)
          return off
        },
        registerEffect(command: ClientEffectCommand) {
          if (!agnes.effectCaller || !config.services?.includes(command.service))
            throw new Error(`client effect service is unavailable: ${command.service}`)
          return this.register({
            id: command.id,
            ...(command.title ? { title: command.title } : {}),
            effectService: command.service,
            execute: async (input: unknown) => {
              if (!input || typeof input !== 'object' || Array.isArray(input))
                throw new TypeError('client effect input must be an object')
              const sessionId = session.sessionId
              if (!sessionId) throw new Error('client effect requires an active session')
              return await agnes.effectCaller!(
                config,
                sessionId,
                command.service,
                crypto.randomUUID(),
                input as Record<string, unknown>,
              )
            },
          })
        },
        execute(id: string, input: unknown) {
          return commands.executeOwned(config.rowId ?? config.packageId, id, input)
        },
      }
      const stop = registry.bindSession(session)
      ctx.effect(() => stop)
      registry.setLocaleSource(locale)
      Object.defineProperty(ctx, 'slots', { value: bound, configurable: true })
      Object.defineProperty(ctx, 'module', { value: config, configurable: true })
      Object.defineProperty(ctx, 'commands', { value: boundCommands, configurable: true })
      Object.defineProperty(ctx, 'session', { value: session, configurable: true })
      Object.defineProperty(ctx, 'resources', { value: resources, configurable: true })
      Object.defineProperty(ctx, 'theme', { value: theme, configurable: true })
      Object.defineProperty(ctx, 'locale', { value: locale, configurable: true })
      return mod.apply(ctx as ClientContext, config)
    },
  }
}

function createFiberBoundRegistry(
  registry: SlotRegistry,
  fiberCtx: Context,
  owner: string,
  allowedSlots: readonly string[] | undefined,
  configCatalogVersion: string | undefined,
): SlotRegistry {
  const bound = Object.create(registry) as SlotRegistry
  bound.register = ((
    nameOrOptions: SlotName | Record<string, unknown>,
    component: unknown,
    options?: RegisterOptions,
  ) => {
    const requestedName =
      typeof nameOrOptions === 'string' ? nameOrOptions : (nameOrOptions as { name?: SlotName }).name
    const registration =
      typeof nameOrOptions === 'string'
        ? { name: nameOrOptions, ...(options ?? {}), owner }
        : { ...nameOrOptions, owner }
    const dshDefinition = getDshSlotDefinition(requestedName as string)
    if (dshDefinition !== undefined) {
      if (!isPublicDshSlot(requestedName as string))
        throw new Error(`client module ${owner} cannot register host-only slot ${requestedName}`)
      if (configCatalogVersion !== DSH_SLOT_CATALOG_VERSION)
        throw new Error(`client module ${owner} uses unsupported slot catalog version`)
      if (!isRuntimeSupportedDshSlot(requestedName as string))
        throw new Error(`client module ${owner} registered an unmounted slot ${requestedName}`)
    }
    if (allowedSlots !== undefined && !allowedSlots.includes(requestedName as string))
      throw new Error(`client module ${owner} registered undeclared slot ${String(requestedName)}`)
    const off = registry.register(registration as never, component)
    fiberCtx.effect(() => off)
    return off
  }) as SlotRegistry['register']
  bound.inject = ((name: string, factory: () => unknown) => {
    const off = registry.inject(name, factory)
    fiberCtx.effect(() => off)
    return off
  }) as SlotRegistry['inject']
  return bound
}
