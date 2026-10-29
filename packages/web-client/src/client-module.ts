/** Client-module adapter: plugin registrations are owned by their Cordis fiber. */
import type { Context } from '@agnes/cordis'
import { createExampleClient, type ExampleLaunches, type ExamplePackages } from '@agnes/sdk/browser'
import {
  type ContributionAvailability,
  contributionAvailability,
  ownContribution,
  scopedHomeEntries,
} from './contribution-scope.js'
import {
  DSH_SLOT_CATALOG_VERSION,
  getDshSlotDefinition,
  isPublicDshSlot,
  isRuntimeSupportedDshSlot,
} from './dsh-slot-catalog.js'
import { scopedExamplePages } from './example-pages.js'
import { scopedPresentationRoles } from './presentation-roles.js'
import { scopedProfileStreams } from './profile-streams.js'
import { type RegisterOptions, SlotRegistry } from './registry.js'
import { bindContributions } from './scoped-contributions.js'
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
import { type PresentationHost, PresentationService } from './services-presentation.js'
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
  profile: Readonly<{
    streams: ReturnType<typeof scopedProfileStreams>
    services: import('./service-contracts.js').ClientProfileServices
    examples: ExamplePackages
    launch: ExampleLaunches & { openPage(exampleId: string): void }
  }>
  sessionStreams: ReturnType<typeof scopedProfileStreams>
  examplePages: ReturnType<typeof scopedExamplePages>
  availability: ContributionAvailability
  homeEntries: ReturnType<typeof scopedHomeEntries>
  settingsSections: Pick<typeof import('./ui-registries.js').settingsSections, 'register'>
  conversationCards: Pick<typeof import('./ui-registries.js').conversationCards, 'register'>
  workbenchPanels: Pick<typeof import('./ui-registries.js').workbenchPanels, 'register'>
  fileViewerActions: Pick<typeof import('./ui-registries.js').fileViewerActions, 'register'>
  composerCommands: Pick<typeof import('./ui-registries.js').composerCommands, 'register'>
  factChainLinks: Pick<typeof import('./fact-chain-links.js').factChainLinks, 'register'>
  workbenchNavigation: Pick<typeof import('./fact-chain-links.js').workbenchNavigation, 'register'>
  resources: ClientResourceService
  presentation: PresentationHost
  presentationRoles: ReturnType<typeof scopedPresentationRoles>
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
        (off) => {
          ctx.effect(() => off)
        },
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
        effect: async (name: string, input: Record<string, unknown>, options: { operationId: string }) => {
          if (!agnes.effectCaller || !config.services?.includes(name) || !options.operationId)
            throw new Error('client effect is unavailable')
          const selected = session.readiness.getSnapshot()
          if (!selected.sessionId || selected.status !== 'ready')
            throw new Error('client effect requires a ready session')
          return agnes.effectCaller(config, selected.sessionId, name, options.operationId, input)
        },
        call: async (name: string, input: Record<string, unknown>) => {
          if (!agnes.serviceCaller || !config.services?.includes(name))
            throw new Error(`client service is unavailable: ${name}`)
          const sessionId = session.sessionId
          if (!sessionId) throw new Error('client service requires an active session')
          return await agnes.serviceCaller(config, sessionId, name, input)
        },
      })
      const profileCall = async (
        name: string,
        input: Record<string, unknown> | undefined,
        options?: { operationId?: string; read?: boolean; sessionReads?: readonly string[] },
      ) => {
        if (
          availability.getSnapshot()?.lifetime !== 'profile' ||
          availability.getSnapshot()?.availability !== 'active'
        )
          throw new Error('CAPABILITY_DENIED')
        if (!agnes.profileCaller || !config.services?.includes(name))
          throw new Error(`client profile service is unavailable: ${name}`)
        return agnes.profileCaller(config, name, input, options)
      }
      const profile = Object.freeze({
        services: Object.freeze({
          query: async (
            name: string,
            input: Record<string, unknown>,
            options?: { sessionReads?: readonly string[] },
          ) => {
            const value = await profileCall(name, input, options)
            if (!value || typeof value !== 'object' || !('output' in value))
              throw new Error('Invalid profile query result')
            return value.output
          },
          effect: (name: string, input: Record<string, unknown>, options: { operationId: string }) =>
            profileCall(name, input, options),
          readOperation: (name: string, operationId: string) =>
            profileCall(name, undefined, { operationId, read: true }),
        }),
      })
      const moduleAgnes = Object.freeze(
        Object.assign(bindClient(agnes.client), {
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
          return commands.register(config.rowId ?? config.packageId, command)
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
      Object.defineProperty(ctx, 'homeEntries', {
        value: scopedHomeEntries(config, (off) => {
          ctx.effect(() => off)
        }),
        configurable: true,
      })
      const availability = contributionAvailability(config, (off) => {
        ctx.effect(() => off)
      })
      Object.defineProperty(ctx, 'sessionStreams', {
        value: scopedProfileStreams(config, availability, (off) => ctx.effect(() => off), session),
        configurable: true,
      })
      const presentation = getService?.('presentation', false)
      Object.defineProperty(ctx, 'presentation', {
        value: presentation instanceof PresentationService ? presentation.host : {},
        configurable: true,
      })
      Object.defineProperty(ctx, 'presentationRoles', {
        value: scopedPresentationRoles(config, (off) => {
          ctx.effect(() => off)
        }),
        configurable: true,
      })
      Object.defineProperty(ctx, 'availability', { value: availability, configurable: true })
      const examplePages = scopedExamplePages(config, (off) => {
        ctx.effect(() => off)
      })
      Object.defineProperty(ctx, 'examplePages', { value: examplePages, configurable: true })
      const exampleClient = createExampleClient(async (request) => {
        if (
          availability.getSnapshot()?.lifetime !== 'profile' ||
          availability.getSnapshot()?.availability !== 'active'
        )
          throw new Error('CAPABILITY_DENIED')
        const response = await fetch('/api/client-modules/examples', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rowId: config.rowId, request }),
        })
        const value: unknown = await response.json()
        if (!response.ok) {
          const code = (value as { error?: { data?: { code?: unknown } } })?.error?.data?.code
          throw new Error(
            typeof code === 'string' &&
              [
                'E_PACKAGE_PREVIEW_STALE',
                'E_PACKAGE_BLOCKED',
                'E_PACKAGE_STATE',
                'OUTCOME_UNKNOWN',
                'INVALID_REQUEST',
                'OVERLOADED',
              ].includes(code)
              ? code
              : 'CAPABILITY_DENIED',
          )
        }
        return value
      })
      Object.defineProperty(ctx, 'profile', {
        value: Object.freeze({
          streams: scopedProfileStreams(config, availability, (off) => {
            ctx.effect(() => off)
          }),
          services: profile.services,
          examples: exampleClient.packages,
          launch: Object.freeze({ ...exampleClient.launches, openPage: examplePages.open }),
        }),
        configurable: true,
      })
      bindContributions(
        ctx as ClientContext,
        config,
        registry,
        (effect, assert) =>
          createFiberBoundRegistry(
            registry,
            effect,
            config.rowId ?? config.packageId,
            config.allowedSlots,
            config.slotCatalogVersion,
            assert,
          ),
        boundCommands.register,
        (off) => {
          ctx.effect(() => off)
        },
      )
      return mod.apply(ctx as ClientContext, config)
    },
  }
}

/** A frozen module facade must keep SDK mutations on the actual connection, including reconnect. */
function bindClient(client: import('./services.js').HostAgnesClient): import('./services.js').AgnesClient {
  const facade = Object.create(client) as import('./services.js').AgnesClient
  const bound = new Set<string>()
  for (
    let owner: object | null = client;
    owner && owner !== Object.prototype;
    owner = Object.getPrototypeOf(owner)
  ) {
    for (const name of Object.getOwnPropertyNames(owner)) {
      if (name === 'constructor' || bound.has(name)) continue
      const value = Object.getOwnPropertyDescriptor(owner, name)?.value
      if (typeof value !== 'function') continue
      Object.defineProperty(facade, name, { value: value.bind(client) })
      bound.add(name)
    }
  }
  return facade
}

function createFiberBoundRegistry(
  registry: SlotRegistry,
  effect: (off: () => void) => void,
  owner: string,
  allowedSlots: readonly string[] | undefined,
  configCatalogVersion: string | undefined,
  assert: (name?: string, deferred?: boolean) => void = () => {},
): SlotRegistry {
  const bound = Object.create(registry) as SlotRegistry
  // Session binding state belongs to the host registry, never to a role facade.
  Object.defineProperty(bound, 'sessionId', { get: () => registry.sessionId })
  bound.bindSession = registry.bindSession.bind(registry)
  bound.setSession = registry.setSession.bind(registry)
  bound.subscribeSession = registry.subscribeSession.bind(registry)
  bound.register = ((
    nameOrOptions: SlotName | Record<string, unknown>,
    component: unknown,
    options?: RegisterOptions,
  ) => {
    const requestedName =
      typeof nameOrOptions === 'string' ? nameOrOptions : (nameOrOptions as { name?: SlotName }).name
    assert(requestedName as string)
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
    return ownContribution(owner, off, effect)
  }) as SlotRegistry['register']
  bound.inject = ((name: string, factory: () => unknown) => {
    assert(name, true)
    const definition = getDshSlotDefinition(name)
    if (definition) {
      if (!isPublicDshSlot(name) || !isRuntimeSupportedDshSlot(name))
        throw new Error(`client module ${owner} injected an unavailable slot ${name}`)
      if (configCatalogVersion !== DSH_SLOT_CATALOG_VERSION)
        throw new Error(`client module ${owner} uses unsupported slot catalog version`)
    }
    if (allowedSlots !== undefined && !allowedSlots.includes(name))
      throw new Error(`client module ${owner} injected undeclared slot ${name}`)
    const off = registry.inject(name, factory)
    return ownContribution(owner, off, effect)
  }) as SlotRegistry['inject']
  return bound
}
