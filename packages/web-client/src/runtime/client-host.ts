// The client host runtime. It turns one server-chosen selection into a client generation. The caller's
// loader imports each module the selection names, at most once per candidate, from its signed entry
// path after verifying its digest and hands back the module namespace; the host alone picks exports
// from it. The selected registry is the named export its contribution declares, built over this
// generation's renderer host; the selected shell is the named export its contribution declares, probed
// once for its id and never mounted here. The host then registers each selected renderer itself, for its
// module under the owner token the catalog issued it: the descriptor the catalog declares for it plus, for
// each target that descriptor declares, the module's fixed own function exports (`component` for Web,
// `format` for TUI and SDK, `format` and `encode` for IM); the namespace itself goes no further. Only then
// is a selected module that exports the fixed `clientEntry` activated through it with a ClientHost bound
// to the same token and a context of its own for this generation, which presents no view and so refuses
// every service call; it may register the other renderers its catalog entry declares, and registering a
// selected one again fails the candidate. A module without `clientEntry` is not activated, and a default
// export or another function never stands in for a named one. The registry leases a handle only for a
// definition registered for a module of this live generation, each lease presenting through a restricted
// per-view context the caller's presenter builds. A candidate becomes current only once every selected
// renderer is registered and every entry returned; otherwise everything it created is released and the
// current generation stays. A module the selection does not name is never loaded. The generation
// presents a domain view through the renderer the selection chose, then the selected fallback, then the
// built-in generic view, and never through a renderer the selection did not choose.
import type {
  ClientContribution,
  ClientEntry,
  ClientHost,
  ClientModule,
  ClientPresentation,
  DomainView,
  NegotiatedClientCapabilities,
  Outcome,
  RendererContext,
  RendererDefinition,
  RendererPresentation,
  RendererRegistration,
  RuntimeError,
  ShellProvider,
  UIRegistry,
  UIRegistryFactory,
  UIRegistryHost,
} from '@agnes/extension-api/client'
import type {
  ClientModuleContribution,
  ClientTarget,
  ResolvedClientSelection,
  SelectedContribution,
  SelectedRenderer,
  SelectedService,
} from './client-selection.js'
import type { createRendererPresenter } from './renderer-presentation.js'

export interface ClientModuleLoader {
  /** The namespace of `module`, imported from its signed entry path after its digest was verified. */
  load(module: ClientModule): Promise<Outcome<Readonly<Record<string, unknown>>>>
}

export interface ClientGeneration {
  readonly revision: number
  readonly registry: UIRegistry
  /** Presents through the selected renderers and the built-in generic view; refuses once released. */
  readonly presentation: ClientPresentation
  /** The selected shell's export; undefined when the selection has no shell or the generation was released. */
  shell(): (() => ShellProvider) | undefined
}

export interface ClientHostRuntime {
  /** Builds a candidate generation for the catalog; on any failure the candidate is released and the current generation stays. */
  activate(catalog: {
    revision: number
    modules: readonly ClientModule[]
    selection: Extract<ResolvedClientSelection, { kind: 'selected' }>
  }): Promise<Outcome<void>>
  current(): ClientGeneration | undefined
  dispose(): Promise<void>
}

type Catalog = Parameters<ClientHostRuntime['activate']>[0]
type Lease = ReturnType<ReturnType<typeof createRendererPresenter>['lease']>
type Owner = {
  readonly id: string
  readonly moduleId: string
  readonly ownerToken: string
  readonly leases: Set<Lease>
  presenting?: Lease
}
/** A module whose release, or the release of one of its renderer contributions, missed the deadline. */
type Failure = { moduleId: string; contributionId?: string; reason: 'dispose_timeout' }
/** One part of a generation's release: what it runs, the module it is part of and what a miss still closes. */
type Step = { moduleId?: string; run: () => unknown; missed?: () => void }

type Generation = {
  readonly revision: number
  readonly selection: Catalog['selection']
  readonly presentation: ClientPresentation
  registry: UIRegistry | undefined
  /** Cleared on release: every module host and the renderer host refuse from then on. */
  live: boolean
  /**
   * Registered definitions, the module each was registered for and the leases bound to it, among them
   * the one lease the generation's presentation presents the definition through.
   */
  readonly owners: Map<RendererDefinition, Owner>
  /** The definition of every live registration under its `moduleId`/descriptor id. */
  readonly registered: Map<string, RendererDefinition>
  /** The built-in generic view's lease, taken on first use. */
  generic: Lease | undefined
  /** The selected shell's export. */
  shell: (() => ShellProvider) | undefined
  readonly listeners: Set<(revision: number) => void>
  /** Each module context and renderer registration, released with the leases under one deadline. */
  readonly releases: Step[]
  /** Set once a module registers a renderer the host registered; it fails the candidate. */
  conflict: { ok: false; error: RuntimeError } | undefined
}

const refuse = (
  code: RuntimeError['code'],
  detailCode: string,
  message: string,
): { ok: false; error: RuntimeError } => ({
  ok: false,
  error: { code, detailCode, message, retryAdvice: { kind: 'never' }, diagnosticId: 'web-client-host' },
})
const closed = () => refuse('cancelled', 'client_host_disposed', 'the client closed')
const released = () => refuse('cancelled', 'client_generation_released', 'the client generation was released')
// ponytail: the slot schema source is still open, so every legacy slot refuses; render it here once
// the selection names that schema.
const legacySlot = () =>
  refuse('incompatible', 'legacy_slot_unwired', 'legacy slot presentation is not wired yet')

const text = (error: unknown) => (error instanceof Error ? error.message : String(error))
const key = (moduleId: string, id: string) => JSON.stringify([moduleId, id])

/** The declaration of `id` as a `kind` contribution in `module`. */
const declared = (module: ClientModule, kind: ClientModuleContribution['kind'], id: unknown) =>
  module.contributions?.find((entry) => entry.kind === kind && entry.contributionId === id) as
    | { readonly targets: readonly string[]; readonly export?: string }
    | undefined

/** The own export `name` of a loaded namespace; an inherited key or a malformed namespace exports nothing. */
const exported = (namespace: unknown, name: string): unknown => {
  const object = Object(namespace) as Record<string, unknown>
  return Object.hasOwn(object, name) ? object[name] : undefined
}

/** The fallback renderer and the renderer of every row. */
const picked = (selection: Catalog['selection']): SelectedRenderer[] => [
  selection.fallbackRenderer,
  ...selection.renderers.map((row) => row.renderer),
]

/** The fixed exports a renderer presents each target through. */
const PARTS: Readonly<Record<ClientTarget, readonly string[]>> = {
  web: ['component'],
  tui: ['format'],
  sdk: ['format'],
  im: ['format', 'encode'],
}

/**
 * The definition of a selected renderer: the descriptor its catalog contribution declares and, for each
 * target that descriptor declares, the fixed own function export of its module that presents it.
 */
function compose(namespace: unknown, renderer: SelectedRenderer): Outcome<RendererDefinition> {
  const definition: Record<string, unknown> = { descriptor: renderer.descriptor }
  for (const name of new Set(renderer.descriptor.targets.flatMap((target) => PARTS[target]))) {
    const value = exported(namespace, name)
    if (typeof value !== 'function')
      return refuse(
        'incompatible',
        value === undefined ? 'client_export_missing' : 'client_export_invalid',
        `module ${renderer.moduleId} has no function export ${name} for renderer ${renderer.contributionId}`,
      )
    definition[name] = value
  }
  return { ok: true, value: definition as unknown as RendererDefinition }
}

/** The descriptor id of a probe instance of `factory`; the probe is never mounted. */
function probe(factory: () => ShellProvider): Outcome<unknown> {
  try {
    return { ok: true, value: factory().descriptor.id }
  } catch (error) {
    return refuse('invalid_input', 'shell_invalid', `the shell could not be created: ${text(error)}`)
  }
}

const LATE = Symbol('late')
/** `promise`, or LATE when `ms` pass first. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(resolve, ms, LATE)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * One call into loader or module code under a deadline. A throw, a refusal, a malformed outcome or a
 * missed deadline all become one host refusal; a success that arrives after the deadline goes to `late`.
 */
async function bounded<T>(
  ms: number,
  prefix: string,
  what: string,
  call: () => Promise<Outcome<T>>,
  late: (value: T) => void = () => {},
): Promise<Outcome<T>> {
  const running = Promise.resolve().then(call)
  let reason: string
  try {
    const result = await within(running, ms)
    if (result === LATE) {
      running.then(
        (value) => value?.ok && late(value.value),
        () => {},
      )
      return refuse('timeout', `${prefix}_timeout`, `${what} did not finish within ${ms} ms`)
    }
    if (result?.ok) return result
    reason = String(result?.error?.message)
  } catch (error) {
    reason = text(error)
  }
  return refuse('internal', `${prefix}_failed`, `${what}: ${reason}`)
}

export function createClientHostRuntime(input: {
  target: ClientTarget
  loader: ClientModuleLoader
  clientInstanceId: string
  capabilities: NegotiatedClientCapabilities
  locale: RendererContext['locale']
  /** Presents a bound renderer, or the generic view, through a restricted context for the window's view. */
  presenter: Pick<ReturnType<typeof createRendererPresenter>, 'lease' | 'generic'>
  limits?: { entryMs?: number; disposeMs?: number }
  /** Told, with ids only, that a module's release or a renderer lease of it missed its dispose deadline. */
  onFailure?: (failure: Failure) => void
}): ClientHostRuntime {
  const entryMs = input.limits?.entryMs ?? 15_000
  const disposeMs = input.limits?.disposeMs ?? 5_000
  let current: { generation: Generation; view: ClientGeneration } | undefined
  let activating: Promise<Outcome<void>> | undefined
  let disposed = false
  let closing: Promise<void> | undefined

  /**
   * Runs one dispose under the dispose deadline; a throw is swallowed, and a miss, or a dispose that
   * reports its own miss by resolving false, resolves false.
   */
  const settle = (dispose: () => unknown) =>
    within(Promise.resolve().then(dispose), disposeMs).then(
      (result) => result !== LATE && result !== false,
      () => true,
    )

  const report = (failure: Failure) => {
    try {
      input.onFailure?.(failure)
    } catch {
      // A failing report changes nothing about the release.
    }
  }

  /**
   * Ends every lease bound to these registrations; a lease outliving its registration presents nothing.
   * A lease whose contexts miss the deadline is reported against its module and renderer.
   */
  const revoke = (owners: Iterable<Owner>) =>
    Promise.all(
      [...owners].flatMap((owner) => {
        const ending = [...owner.leases]
        owner.leases.clear()
        return ending.map(async (lease) => {
          if (!(await settle(() => lease.dispose())))
            report({ moduleId: owner.moduleId, contributionId: owner.id, reason: 'dispose_timeout' })
        })
      }),
    )

  /**
   * Stops admission, then starts every step of the release at once, so one deadline counted from that
   * moment holds them all: each renderer lease, the generic view's lease, each renderer registration and
   * each module context. A module with any step left at the deadline is reported once, by its id; its
   * context closes all the same, and no step waits for another.
   */
  async function release(generation: Generation): Promise<void> {
    generation.live = false
    generation.shell = undefined
    generation.listeners.clear()
    const steps: Step[] = []
    for (const owner of generation.owners.values()) {
      for (const lease of owner.leases) steps.push({ moduleId: owner.moduleId, run: () => lease.dispose() })
      owner.leases.clear()
    }
    const generic = generation.generic
    generation.generic = undefined
    if (generic) steps.push({ run: () => generic.dispose() })
    steps.push(...generation.releases.splice(0).reverse())
    const late = new Set<string>()
    await Promise.all(
      steps.map(async ({ moduleId, run, missed }) => {
        if (await settle(run)) return
        missed?.()
        if (moduleId !== undefined) late.add(moduleId)
      }),
    )
    for (const moduleId of late) report({ moduleId, reason: 'dispose_timeout' })
  }

  const rendererHost = (generation: Generation): UIRegistryHost => ({
    bindRenderer(definition) {
      const owner = generation.live ? generation.owners.get(definition) : undefined
      if (owner === undefined)
        return refuse(
          'denied',
          'renderer_unbound',
          'the definition was not registered for a module of this client generation',
        )
      const lease = input.presenter.lease({ definition, ownerToken: owner.ownerToken })
      owner.leases.add(lease)
      return {
        ok: true,
        value: {
          id: owner.id,
          ownerToken: owner.ownerToken,
          present: (view) => lease.present(view),
          // Ends only this lease; the registration stays with its module.
          dispose: async () => {
            owner.leases.delete(lease)
            await lease.dispose()
          },
        },
      }
    },
  })

  const definitionOf = (generation: Generation, contribution: SelectedContribution) =>
    generation.registered.get(key(contribution.moduleId, contribution.contributionId))

  /** The definition the registry matches for `view`, when the selection chose it; otherwise none. */
  function matched(generation: Generation, view: DomainView): RendererDefinition | undefined {
    try {
      const found = generation.registry?.resolve({
        renderKey: view.renderKey,
        viewSchema: view.viewSchema,
        target: input.target,
        // What the presenter holds a renderer to: the features of every action, disabled ones too.
        requiredFeatures: [...new Set(view.actions.flatMap((action) => action.requiredFeatures))],
      })
      if (found?.ok !== true || found.value.kind !== 'matched') return undefined
      const { handle } = found.value
      // The view presents through the definition's own lease, so the one the registry took ends here.
      void settle(() => handle.dispose())
      return picked(generation.selection)
        .map((contribution) => definitionOf(generation, contribution))
        .find((definition) => {
          const owner = definition && generation.owners.get(definition)
          return owner?.id === handle.id && owner.ownerToken === handle.ownerToken
        })
    } catch {
      return undefined
    }
  }

  /**
   * Presents `view` through the renderer the selection chose for its render key, else the registry's
   * match when the selection chose that one, then the selected fallback, then the built-in generic view.
   * A resync refusal goes back unchanged so the caller rereads the window; any other refusal moves on.
   * Each definition presents through one lease per generation, so an upsert of the same view keeps its
   * mount and context, while another definition for that view mounts afresh.
   */
  function domain(generation: Generation, view: DomainView): Outcome<RendererPresentation> {
    if (!generation.live) return released()
    const { fallbackRenderer, renderers } = generation.selection
    const row = renderers.find((entry) => entry.renderKey === view?.renderKey)
    const chosen = row ? definitionOf(generation, row.renderer) : matched(generation, view)
    for (const definition of new Set([chosen, definitionOf(generation, fallbackRenderer)])) {
      const owner = definition && generation.owners.get(definition)
      if (!definition || !owner) continue
      if (owner.presenting === undefined) {
        owner.presenting = input.presenter.lease({ definition, ownerToken: owner.ownerToken })
        owner.leases.add(owner.presenting)
      }
      const presented = owner.presenting.present(view)
      if (presented.ok || presented.error.retryAdvice.kind === 'retry_read') return presented
    }
    generation.generic ??= input.presenter.generic()
    return generation.generic.present(view)
  }

  /**
   * Registers `definition` for `module` with the generation's registry and records it for leases,
   * presentation and release: the host's registration of each selected renderer, and every one a
   * module makes, which may not register a selected renderer again.
   */
  function enroll(
    generation: Generation,
    module: ClientModule,
    definition: RendererDefinition,
    by: 'host' | 'module',
  ): Outcome<RendererRegistration> {
    if (!generation.live) return released()
    const descriptor = definition?.descriptor
    const declaration = declared(module, 'renderer', descriptor?.id)
    if (
      declaration === undefined ||
      !Array.isArray(descriptor.targets) ||
      !descriptor.targets.every((target) => declaration.targets.includes(target))
    )
      return refuse(
        'invalid_input',
        'renderer_undeclared',
        `module ${module.moduleId} does not declare renderer ${String(descriptor?.id)} for these targets`,
      )
    if (
      by === 'module' &&
      picked(generation.selection).some(({ contributionId }) => contributionId === descriptor.id)
    ) {
      // Whatever the module makes of this refusal, its candidate fails; the host's registration stays.
      generation.conflict ??= refuse(
        'conflict',
        'renderer_conflict',
        `module ${module.moduleId} registers renderer ${descriptor.id}, which the client host registered`,
      )
      return generation.conflict
    }
    const registered = (generation.registry as UIRegistry).register(definition)
    if (!registered.ok) return registered
    const { id, ownerToken: registrationToken, dispose } = registered.value
    const cell = key(module.moduleId, descriptor.id)
    // The server binds this token to the client instance and the module generation; it grants nothing.
    const owner: Owner = {
      id: descriptor.id,
      moduleId: module.moduleId,
      ownerToken: module.ownerToken,
      leases: new Set<Lease>(),
    }
    generation.owners.set(definition, owner)
    generation.registered.set(cell, definition)
    let done: Promise<void> | undefined
    const unregister = () => {
      done ??= (async () => {
        generation.owners.delete(definition)
        generation.registered.delete(cell)
        await revoke([owner])
        return dispose()
      })()
      return done
    }
    generation.releases.push({ moduleId: module.moduleId, run: unregister })
    return { ok: true, value: { id, ownerToken: registrationToken, dispose: unregister } }
  }

  /**
   * The host `module` is started with. Its context is the module's own for this generation and presents
   * no view, so it refuses every command, interaction and artifact call; module actions go through their
   * renderer's per-view context. Its release is pushed before the entry runs, so a failed candidate, a
   * late entry and dispose all close the context: the contribution the entry returned, then the context,
   * alongside the rest of the release and under its deadline. A miss closes the context anyway.
   */
  function moduleHost(generation: Generation, module: ClientModule) {
    const registry = generation.registry as UIRegistry
    const controller = new AbortController()
    const cleanups: (() => void | Promise<void>)[] = []
    let contribution: ClientContribution | undefined
    const close = () => {
      controller.abort()
      // Newest first, each started without waiting for the one before; a failure stops none of the rest.
      return Promise.allSettled(
        cleanups
          .splice(0)
          .reverse()
          .map(async (cleanup) => cleanup()),
      )
    }
    generation.releases.push({
      moduleId: module.moduleId,
      run: async () => {
        try {
          await contribution?.dispose()
        } catch {
          // A failed dispose still closes the context.
        }
        await close()
      },
      missed: () => void close(),
    })
    // ponytail: every call refuses; widen it once a Host-issued per-module credential is on the wire.
    const refusal = () =>
      generation.live ? refuse('denied', 'outside_view', 'a module context presents no view') : released()
    const refusing = async () => refusal()
    const host: ClientHost = {
      context: {
        clientInstanceId: input.clientInstanceId,
        ownerToken: module.ownerToken,
        signal: controller.signal,
        capabilities: structuredClone(input.capabilities),
        commands: { submit: refusing, commandStatus: refusing },
        interactions: {
          pending: refusing,
          read: refusing,
          respond: refusing,
          formLink: refusing,
          responseStatus: refusing,
        },
        artifacts: {
          describe: refusing,
          openDownload: refusing,
          readRange: refusing,
          openStream: refusing,
          followDownload: refusal,
        },
        // Formatting reads no user resource, so locale calls pass through.
        locale: input.locale,
        onDispose(cleanup) {
          if (typeof cleanup !== 'function') return
          if (controller.signal.aborted)
            void Promise.resolve()
              .then(cleanup)
              .catch(() => {})
          else cleanups.push(cleanup)
        },
      },
      presentation: generation.presentation,
      renderers: {
        register: (definition) => enroll(generation, module, definition, 'module'),
        resolve: (request) => registry.resolve(request),
      },
      registerShell(factory) {
        if (!generation.live) return released()
        if (input.target !== 'web')
          return refuse(
            'incompatible',
            'shell_target_unsupported',
            `a ${input.target} client mounts no shell`,
          )
        const id = probe(factory)
        if (!id.ok) return id
        if (declared(module, 'shell', id.value) === undefined)
          return refuse(
            'invalid_input',
            'shell_undeclared',
            `module ${module.moduleId} does not declare shell ${String(id.value)}`,
          )
        // The generation's shell is the selected module export; a registration never replaces it.
        return { ok: true, value: { dispose: async () => {} } }
      },
      observeCatalog(listener) {
        const own = (revision: number) => listener(revision)
        if (generation.live) generation.listeners.add(own)
        return {
          dispose: async () => {
            generation.listeners.delete(own)
          },
        }
      },
    }
    return {
      host,
      started: (value: ClientContribution) => {
        contribution = value
      },
    }
  }

  async function build(generation: Generation, catalog: Catalog): Promise<Outcome<void>> {
    const { selection } = catalog
    if (selection?.kind !== 'selected' || selection.target !== input.target)
      return refuse(
        'invalid_input',
        'client_target_mismatch',
        `the selection is not for a ${input.target} client`,
      )
    const modules = new Map(catalog.modules.map((module) => [module.moduleId, module]))
    const named = [selection.registry, selection.shell, ...picked(selection)].filter(
      (contribution) => contribution !== null,
    )
    const missing = named.find((contribution) => !modules.has(contribution.moduleId))?.moduleId
    if (missing !== undefined)
      return refuse('incompatible', 'client_module_missing', `the catalog has no module ${missing}`)

    // Each module loads at most once per candidate, whatever it serves; a late namespace holds nothing.
    const loads = new Map<string, Promise<Outcome<Readonly<Record<string, unknown>>>>>()
    const load = (module: ClientModule) => {
      const loading =
        loads.get(module.moduleId) ??
        bounded(entryMs, 'client_module_load', `loading module ${module.moduleId}`, () =>
          input.loader.load(module),
        )
      loads.set(module.moduleId, loading)
      return loading
    }
    /** The function a selected service names: the export its module declares for it, and only that. */
    const service = async <T>(kind: 'registry' | 'shell', selected: SelectedService): Promise<Outcome<T>> => {
      const module = modules.get(selected.moduleId) as ClientModule
      const declaration = declared(module, kind, selected.contributionId)
      if (declaration?.export !== selected.export || !declaration.targets.includes(input.target))
        return refuse(
          'incompatible',
          `${kind}_undeclared`,
          `module ${module.moduleId} does not declare ${kind} ${selected.contributionId} as export ${selected.export} for ${input.target}`,
        )
      const namespace = await load(module)
      if (!namespace.ok) return namespace
      const value = exported(namespace.value, selected.export)
      if (value === undefined)
        return refuse(
          'incompatible',
          'client_export_missing',
          `module ${module.moduleId} has no export ${selected.export}`,
        )
      if (typeof value !== 'function')
        return refuse(
          'incompatible',
          'client_export_invalid',
          `export ${selected.export} of module ${module.moduleId} is not a function`,
        )
      return { ok: true, value: value as T }
    }

    const registry = await service<UIRegistryFactory>('registry', selection.registry)
    if (!registry.ok) return registry
    if (disposed) return closed()
    const made = await bounded(
      entryMs,
      'client_registry',
      `registry ${selection.registry.contributionId}`,
      async () => registry.value(rendererHost(generation)),
    )
    if (!made.ok) return made
    generation.registry = made.value

    const shell = selection.shell
    if (shell !== null) {
      const factory = await service<() => ShellProvider>('shell', shell)
      if (!factory.ok) return factory
      const id = probe(factory.value)
      if (!id.ok || id.value !== shell.contributionId)
        return refuse(
          'incompatible',
          'client_export_invalid',
          `export ${shell.export} of module ${shell.moduleId} does not create shell ${shell.contributionId}`,
        )
      generation.shell = factory.value
    }

    // The host registers each selected renderer once, before any module starts, from its catalog
    // descriptor and its module's fixed exports; a module needs no clientEntry for it.
    const renderers = new Map(
      picked(selection).map((renderer) => [key(renderer.moduleId, renderer.contributionId), renderer]),
    )
    for (const renderer of renderers.values()) {
      if (disposed) return closed()
      const module = modules.get(renderer.moduleId) as ClientModule
      const namespace = await load(module)
      if (!namespace.ok) return namespace
      const definition = compose(namespace.value, renderer)
      if (!definition.ok) return definition
      const registered = enroll(generation, module, definition.value, 'host')
      if (!registered.ok) return registered
    }

    // A selected module is activated through its `clientEntry` export when it has one and is otherwise
    // loaded for its exports alone. One module at a time, so a failure leaves no later module started.
    for (const id of new Set(named.map((contribution) => contribution.moduleId))) {
      if (disposed) return closed()
      const module = modules.get(id) as ClientModule
      const namespace = await load(module)
      if (!namespace.ok) return namespace
      const entry = exported(namespace.value, 'clientEntry')
      if (entry === undefined) continue
      if (typeof entry !== 'function')
        return refuse(
          'incompatible',
          'client_entry_invalid',
          `the clientEntry export of module ${id} is not a function`,
        )
      const activated = moduleHost(generation, module)
      const started = await bounded(
        entryMs,
        'client_entry',
        `the client entry of ${id}`,
        async () => (entry as ClientEntry)(activated.host),
        // A late entry finds its generation released; what it returns is released as well.
        (contribution: ClientContribution) => void settle(() => contribution.dispose()),
      )
      if (started.ok) activated.started(started.value)
      if (generation.conflict) return generation.conflict
      if (!started.ok) return started
    }
    if (disposed) return closed()

    // Each selected renderer the host registered is still there once every entry returned.
    const lacking = picked(selection).find(
      (renderer) => !generation.registered.has(key(renderer.moduleId, renderer.contributionId)),
    )?.contributionId
    if (lacking !== undefined)
      return refuse(
        'incompatible',
        'client_contribution_missing',
        `the selected renderer ${lacking} was not registered`,
      )
    return { ok: true, value: undefined }
  }

  async function run(catalog: Catalog): Promise<Outcome<void>> {
    const generation: Generation = {
      revision: catalog.revision,
      selection: catalog.selection,
      presentation: { domain: (view) => domain(generation, view), legacySlot },
      registry: undefined,
      live: true,
      owners: new Map(),
      registered: new Map(),
      generic: undefined,
      shell: undefined,
      listeners: new Set(),
      releases: [],
      conflict: undefined,
    }
    // A throw from loader or module code, such as an export that cannot be read, fails the candidate too.
    const built = await build(generation, catalog).catch((error: unknown) =>
      refuse('internal', 'client_activation_failed', `the client generation was not built: ${text(error)}`),
    )
    if (!built.ok) {
      await release(generation)
      return built
    }
    const old = current?.generation
    current = {
      generation,
      view: {
        revision: generation.revision,
        registry: generation.registry as UIRegistry,
        presentation: generation.presentation,
        shell: () => generation.shell,
      },
    }
    if (old) await release(old)
    for (const listener of [...generation.listeners]) {
      try {
        listener(generation.revision)
      } catch {
        // A failing observer changes nothing about the committed generation.
      }
    }
    return { ok: true, value: undefined }
  }

  return {
    async activate(catalog) {
      if (disposed) return closed()
      if (activating)
        return refuse('conflict', 'client_activation_in_progress', 'another activation is running')
      activating = run(catalog).finally(() => {
        activating = undefined
      })
      return activating
    },
    current: () => current?.view,
    dispose() {
      disposed = true
      closing ??= (async () => {
        await activating
        const last = current?.generation
        current = undefined
        if (last) await release(last)
      })()
      return closing
    },
  }
}
