import type {
  ClientContribution,
  ClientEntry,
  ClientHost,
  ClientModule,
  DomainView,
  NegotiatedClientCapabilities,
  Outcome,
  RendererContext,
  RendererDefinition,
  RendererDescriptor,
  RendererPresentation,
  RendererRegistration,
  ShellProvider,
  UIRegistry,
  UIRegistryFactory,
  UIRegistryHost,
} from '@agnes/extension-api/client'
import { describe, expect, it, vi } from 'vitest'
import { type ClientModuleLoader, createClientHostRuntime } from '../../src/runtime/client-host.js'
import type {
  ClientModuleContribution,
  ClientTarget,
  SelectedContribution,
  SelectedRenderer,
  SelectedService,
} from '../../src/runtime/client-selection.js'
import { createUIRegistry } from '../../src/runtime/providers/ui-registry.js'

const DIGEST = 'a'.repeat(64)
const TARGETS: RendererDescriptor['targets'] = ['web', 'tui', 'im']

// What each catalog module declares, with the export of every shell and registry. `base` holds the
// registry, the fallback renderer and the selected shell; `cards` holds the selected card renderer, a
// renderer and a shell nobody selected; `frame` holds only a shell and a registry; `spare` is never
// selected.
const DECLARED: Record<
  string,
  ReadonlyArray<readonly [ClientModuleContribution['kind'], string, string?]>
> = {
  base: [
    ['registry', 'base.registry', 'createRegistry'],
    ['renderer', 'base.fallback'],
    ['shell', 'base.shell', 'workbenchShell'],
  ],
  cards: [
    ['renderer', 'cards.card'],
    ['renderer', 'cards.other'],
    ['shell', 'cards.shell', 'cardsShell'],
  ],
  frame: [
    ['registry', 'frame.registry', 'createFrameRegistry'],
    ['shell', 'frame.shell', 'frameShell'],
  ],
  spare: [['renderer', 'spare.card']],
}

const descriptorOf = (id: string, targets = TARGETS): RendererDescriptor => ({
  id,
  packageDigest: DIGEST,
  renderKey: id,
  targets,
  viewSchemaRanges: [{ typeId: 'acme.card/view@1', minRevision: 1, maxRevision: 1 }],
  requiredFeatures: [],
  optionalFeatures: [],
  scope: 'view',
  entry: './card.js',
})

const catalogModule = (moduleId: string): ClientModule => ({
  moduleId,
  packageId: `acme.${moduleId}`,
  packageDigest: DIGEST,
  assetDigest: DIGEST,
  entryPath: `./${moduleId}.js`,
  ownerToken: `catalog-${moduleId}`,
  authorApiMajor: 1,
  targets: ['web', 'tui'],
  schemas: [],
  requiredFeatures: [],
  styles: [],
  contributions: (DECLARED[moduleId] ?? []).map(
    ([kind, contributionId, name]) =>
      ({
        contributionId,
        kind,
        ...(kind === 'renderer' ? { descriptor: descriptorOf(contributionId) } : { export: name }),
        targets: kind === 'shell' ? ['web'] : TARGETS,
      }) as ClientModuleContribution,
  ),
})
const MODULES = Object.keys(DECLARED).map(catalogModule)

const pick = (moduleId: string, contributionId: string): SelectedContribution => ({
  moduleId,
  packageId: `acme.${moduleId}`,
  packageDigest: DIGEST,
  entryPath: `./${moduleId}.js`,
  contributionId,
})
/** A selected renderer, with the descriptor its module declares for it. */
const chose = (moduleId: string, contributionId: string): SelectedRenderer => ({
  ...pick(moduleId, contributionId),
  descriptor: descriptorOf(contributionId),
})
/** A selected shell or registry, naming the export its module declares for it. */
const serve = (moduleId: string, contributionId: string): SelectedService => ({
  ...pick(moduleId, contributionId),
  export: DECLARED[moduleId]?.find(([, id]) => id === contributionId)?.[2] ?? '',
})

function catalog(revision: number, target: ClientTarget = 'web') {
  return {
    revision,
    // The server issues each module a fresh owner token per catalog generation.
    modules: MODULES.map((module) => ({ ...module, ownerToken: `${module.ownerToken}-${revision}` })),
    selection: {
      kind: 'selected' as const,
      target,
      shell: target === 'web' ? serve('base', 'base.shell') : null,
      registry: serve('base', 'base.registry'),
      fallbackRenderer: chose('base', 'base.fallback'),
      renderers: [{ renderKey: 'cards.card', renderer: chose('cards', 'cards.card') }],
    },
  }
}

// The fixed exports of a renderer module, for every target; the host never presents during these tests.
const presenting = () => ({
  component: () => null,
  format: () => {
    throw new Error('not presented')
  },
  encode: () => {
    throw new Error('not presented')
  },
})
// A definition a module registers itself.
const renderer = (id: string, targets = TARGETS) =>
  ({ descriptor: descriptorOf(id, targets), ...presenting() }) as unknown as RendererDefinition

// Only the descriptor id is read before a shell is mounted.
const shell = (id: string) => () => ({ descriptor: { id } }) as unknown as ShellProvider

const refused = (result: Outcome<unknown> | undefined) =>
  result?.ok === false ? `${result.error.code}/${result.error.detailCode}` : result?.ok ? 'ok' : 'none'

function resolved(registry: UIRegistry, renderKey: string, target: ClientTarget = 'web') {
  const result = registry.resolve({
    renderKey,
    viewSchema: { typeId: 'acme.card/view@1', revision: 1, digest: DIGEST },
    target,
    requiredFeatures: [],
  })
  return result.ok ? result.value : undefined
}
const kind = (registry: UIRegistry, renderKey: string, target?: ClientTarget) =>
  resolved(registry, renderKey, target)?.kind

type Namespace = Record<string, unknown>
/** Namespace edits: drop the export `name`, or set it to `value`. */
const without = (name: string) => (namespace: Namespace) =>
  Object.fromEntries(Object.entries(namespace).filter(([key]) => key !== name))
const replacing = (name: string, value: unknown) => (namespace: Namespace) => ({
  ...namespace,
  [name]: value,
})
/** Moves the export `name` onto the namespace's prototype. */
const inheriting = (name: string) => (namespace: Namespace) =>
  Object.assign(Object.create({ [name]: namespace[name] }) as Namespace, without(name)(namespace))
/** Makes the export `name` throw when read, like a binding read before its module initialized it. */
const unreadable = (name: string) => (namespace: Namespace) =>
  Object.defineProperty(without(name)(namespace), name, {
    enumerable: true,
    get() {
      throw new ReferenceError(`${name} is not initialized`)
    },
  })

const contribution = (log: string[], name: string): Outcome<ClientContribution> => ({
  ok: true,
  value: {
    dispose: async () => {
      log.push(`dispose ${name}`)
    },
  },
})

/**
 * A runtime over a fake loader. Each module namespace holds its `clientEntry`, a function under every
 * export it declares and, when it declares a renderer, the fixed renderer exports; `entries` replaces one
 * module's entry and `namespaces` edits its namespace for later loads. Every module's standard entry
 * registers the shells it declares. The registry is the default one, logging what it holds and keeping
 * every definition it took in `definitions`.
 */
function harness(options: { target?: ClientTarget; limits?: { entryMs?: number; disposeMs?: number } } = {}) {
  const target = options.target ?? 'web'
  const log: string[] = []
  const starts = new Map<string, number>()
  const factory: UIRegistryFactory = (host) => {
    h.hosts.push(host)
    const made = createUIRegistry(host)
    if (!made.ok) return made
    const { register, resolve } = made.value
    return {
      ok: true,
      value: {
        resolve,
        register(definition) {
          const registered = register(definition)
          if (!registered.ok) return registered
          h.definitions.push(definition)
          log.push(`register ${registered.value.id}`)
          const { id, ownerToken, dispose } = registered.value
          return {
            ok: true,
            value: {
              id,
              ownerToken,
              dispose: async () => {
                log.push(`unregister ${id}`)
                await dispose()
              },
            },
          }
        },
      },
    }
  }
  const standard =
    (moduleId: string): ClientEntry =>
    async (host) => {
      const run = (starts.get(moduleId) ?? 0) + 1
      starts.set(moduleId, run)
      for (const [kind, id] of DECLARED[moduleId] ?? []) {
        if (kind !== 'shell' || target !== 'web') continue
        const outcome = host.registerShell(shell(id))
        if (!outcome.ok) return outcome
      }
      return contribution(log, `${moduleId}#${run}`)
    }
  const loader: ClientModuleLoader = {
    load: async (module) => {
      log.push(`load ${module.moduleId}`)
      if (h.slow === module.moduleId) await sleep(100)
      if (h.unloadable === module.moduleId)
        return {
          ok: false,
          error: {
            code: 'internal',
            detailCode: 'missing_export',
            message: 'no client entry',
            retryAdvice: { kind: 'never' },
            diagnosticId: 'client-host-test',
          },
        }
      const own = standard(module.moduleId)
      const declared = DECLARED[module.moduleId] ?? []
      const namespace: Namespace = {
        clientEntry: h.entries[module.moduleId]?.(own) ?? own,
        ...(declared.some(([kind]) => kind === 'renderer') ? presenting() : {}),
      }
      for (const [kind, id, name] of declared)
        if (name !== undefined) namespace[name] = kind === 'registry' ? factory : shell(id)
      const loaded = h.namespaces[module.moduleId]?.(namespace) ?? namespace
      h.loaded[module.moduleId] = loaded
      return { ok: true, value: loaded }
    },
  }
  // The caller's services: the host takes their locale alone, and a module context reaches none of the rest.
  const services = {
    commands: { submit: vi.fn(), commandStatus: vi.fn() },
    interactions: {
      pending: vi.fn(),
      read: vi.fn(),
      respond: vi.fn(),
      formLink: vi.fn(),
      responseStatus: vi.fn(),
    },
    artifacts: {
      describe: vi.fn(),
      openDownload: vi.fn(),
      readRange: vi.fn(),
      openStream: vi.fn(),
      followDownload: vi.fn(),
    },
    locale: { locale: 'en', text: (key: string) => key, formatNumber: () => '', formatDate: () => '' },
  }
  const capabilities = {
    clientInstanceId: 'client-1',
    target,
    features: [],
  } as unknown as NegotiatedClientCapabilities
  const failures = vi.fn()
  /** Every lease the host took, with how often each was disposed; the generic view's is `generic`. */
  const leases: Array<{ id: string; ownerToken: string; disposed: number }> = []
  const lease = (id: string, ownerToken: string) => {
    const entry = { id, ownerToken, disposed: 0 }
    leases.push(entry)
    return {
      present: (view: DomainView) =>
        ({
          ok: true,
          value: { target: 'tui', formatted: view },
        }) as unknown as Outcome<RendererPresentation>,
      dispose: async () => {
        entry.disposed += 1
      },
    }
  }
  const presenter = {
    lease: ({ definition, ownerToken }: { definition: RendererDefinition; ownerToken: string }) =>
      lease(definition.descriptor.id, ownerToken),
    generic: () => lease('generic', 'generic'),
  }
  const h = {
    log,
    services,
    capabilities,
    /** Every module release that missed its dispose deadline, as reported. */
    failures,
    leases,
    /** How often each module's standard entry ran. */
    starts,
    hosts: [] as UIRegistryHost[],
    definitions: [] as RendererDefinition[],
    entries: {} as Record<string, (standard: ClientEntry) => ClientEntry>,
    namespaces: {} as Record<string, (standard: Namespace) => Namespace>,
    /** The namespace each module loaded last. */
    loaded: {} as Record<string, Namespace>,
    unloadable: undefined as string | undefined,
    slow: undefined as string | undefined,
    runtime: createClientHostRuntime({
      target,
      loader,
      clientInstanceId: 'client-1',
      capabilities,
      locale: services.locale,
      presenter,
      limits: options.limits ?? {},
      onFailure: failures,
    }),
  }
  return h
}

/** One call of every command, interaction and artifact method of `context`. */
const serviceCalls = (context: RendererContext) => {
  const { commands, interactions, artifacts } = context
  const request = {} as never
  return Promise.all([
    commands.submit(request),
    commands.commandStatus('request-1'),
    interactions.pending(request),
    interactions.read('interaction-1'),
    interactions.respond(request),
    interactions.formLink('interaction-1', 1),
    interactions.responseStatus('response-1'),
    artifacts.describe('artifact-1', 1),
    artifacts.openDownload(request),
    artifacts.readRange(request),
    artifacts.openStream(request),
    artifacts.followDownload(request),
  ])
}
/** How many calls reached the caller's services. */
const reached = ({ services }: ReturnType<typeof harness>) =>
  [services.commands, services.interactions, services.artifacts]
    .flatMap((client) => Object.values(client))
    .reduce((calls, spy) => calls + spy.mock.calls.length, 0)

type Opened = { moduleId: string; context: RendererContext; ran: string[] }
/** Records the context each module entry starts with, on which it registers two cleanups. */
function track(h: ReturnType<typeof harness>) {
  const opened: Opened[] = []
  const record = (moduleId: string, host: ClientHost) => {
    const ran: string[] = []
    host.context.onDispose(() => {
      ran.push('older')
    })
    host.context.onDispose(async () => {
      ran.push('newer')
    })
    opened.push({ moduleId, context: host.context, ran })
  }
  for (const moduleId of ['base', 'cards'])
    h.entries[moduleId] = (standard) => async (host) => {
      record(moduleId, host)
      return standard(host)
    }
  return { opened, record }
}

/**
 * `entry`'s context closed once: every call is refused as released, its signal aborted, each cleanup ran
 * once, newest first, and one registered afterwards runs right away.
 */
async function closedOnce(entry: Opened) {
  expect((await serviceCalls(entry.context)).map(refused)).toEqual(
    Array(12).fill('cancelled/client_generation_released'),
  )
  expect(entry.context.signal.aborted).toBe(true)
  expect(entry.ran).toEqual(['newer', 'older'])
  entry.context.onDispose(() => {
    entry.ran.push('later')
  })
  await vi.waitFor(() => expect(entry.ran).toEqual(['newer', 'older', 'later']))
}

function now(h: ReturnType<typeof harness>) {
  const generation = h.runtime.current()
  if (generation === undefined) throw new Error('no current generation')
  return generation
}

const sorted = (lines: readonly string[]) => [...lines].sort()
function at<T>(list: readonly T[], index: number): T {
  const item = list[index]
  if (item === undefined) throw new Error(`nothing at ${index}`)
  return item
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('client host runtime', () => {
  it('loads each selected module once, starts its entry and exposes the selected exports', async () => {
    const h = harness()
    let seen: ClientHost | undefined
    h.entries.cards = (standard) => async (host) => {
      seen = host
      return standard(host)
    }
    expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
    const generation = now(h)
    expect(generation.revision).toBe(1)
    // Both entries registered their own shells; the generation offers only the selected export.
    expect(generation.shell()).toBe(h.loaded.base?.workbenchShell)
    expect(kind(generation.registry, 'cards.card')).toBe('matched')
    // base serves the registry, the shell and a renderer, and still loads once. The host registers only
    // the selected renderers, so cards.other, declared by the same module, stays unregistered.
    expect(h.log).toEqual(['load base', 'register base.fallback', 'load cards', 'register cards.card'])
    // A module presents through its generation's presentation.
    expect(seen?.presentation).toBe(generation.presentation)
    expect(seen && kind(seen.renderers, 'base.fallback')).toBe('matched')
  })

  it('gives each module its own context per generation, which reaches no service', async () => {
    const h = harness()
    const { opened } = track(h)
    expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
    expect(refused(await h.runtime.activate(catalog(2)))).toBe('ok')
    // Each context carries the owner token the catalog issued its module for that generation.
    expect(opened.map(({ moduleId, context }) => `${moduleId} ${context.ownerToken}`)).toEqual([
      'base catalog-base-1',
      'cards catalog-cards-1',
      'base catalog-base-2',
      'cards catalog-cards-2',
    ])
    for (const { context } of opened) {
      expect(context.clientInstanceId).toBe('client-1')
      expect(context.capabilities).toEqual(h.capabilities)
      expect(context.capabilities).not.toBe(h.capabilities)
      expect(context.locale).toBe(h.services.locale)
    }
    expect(at(opened, 2).context.capabilities).not.toBe(at(opened, 3).context.capabilities)
    // A module context presents no view, so the live generation's contexts refuse every call outright.
    for (const { context, ran } of opened.slice(2)) {
      expect((await serviceCalls(context)).map(refused)).toEqual(Array(12).fill('denied/outside_view'))
      expect(context.signal.aborted).toBe(false)
      expect(ran).toEqual([])
    }
    expect(reached(h)).toBe(0)
  })

  it.each<{
    name: string
    release: (h: ReturnType<typeof harness>, tracked: ReturnType<typeof track>) => Promise<Opened[]>
  }>([
    {
      name: 'its generation is replaced',
      release: async (h, { opened }) => {
        expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
        expect(refused(await h.runtime.activate(catalog(2)))).toBe('ok')
        for (const { context } of opened.slice(2)) expect(context.signal.aborted).toBe(false)
        return opened.slice(0, 2)
      },
    },
    {
      name: 'its candidate fails',
      release: async (h, { opened, record }) => {
        h.entries.cards = () => async (host) => {
          record('cards', host)
          throw new Error('broken')
        }
        expect(refused(await h.runtime.activate(catalog(1)))).toBe('internal/client_entry_failed')
        return opened
      },
    },
    {
      name: 'its entry returns late',
      release: async (h, { opened, record }) => {
        h.entries.cards = () => async (host) => {
          record('cards', host)
          await sleep(100)
          return contribution(h.log, 'late')
        }
        expect(refused(await h.runtime.activate(catalog(1)))).toBe('timeout/client_entry_timeout')
        await vi.waitFor(() => expect(h.log).toContain('dispose late'))
        return opened
      },
    },
    {
      name: 'the runtime is disposed',
      release: async (h, { opened }) => {
        expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
        await h.runtime.dispose()
        return opened
      },
    },
  ])('closes each module context once when $name', async ({ release }) => {
    const h = harness({ limits: { entryMs: 50 } })
    const closed = await release(h, track(h))
    expect(closed.map(({ moduleId }) => moduleId)).toEqual(['base', 'cards'])
    for (const entry of closed) await closedOnce(entry)
    await h.runtime.dispose()
    for (const { ran } of closed) expect(ran).toEqual(['newer', 'older', 'later'])
    expect(reached(h)).toBe(0)
    expect(h.failures).not.toHaveBeenCalled()
  })

  it('activates a text target without a shell and refuses registerShell there', async () => {
    const h = harness({ target: 'tui' })
    let outcome: Outcome<unknown> | undefined
    h.entries.base = (standard) => async (host) => {
      outcome = host.registerShell(shell('base.shell'))
      return standard(host)
    }
    expect(refused(await h.runtime.activate(catalog(1, 'tui')))).toBe('ok')
    expect(refused(outcome)).toBe('incompatible/shell_target_unsupported')
    expect(now(h).shell()).toBeUndefined()
    expect(kind(now(h).registry, 'cards.card', 'tui')).toBe('matched')
  })

  it('registers each selected renderer from its catalog descriptor and the fixed exports of its module', async () => {
    const h = harness()
    // cards then serves only renderers: it is not activated, and neither its default export nor its
    // shell export stands in for an entry.
    h.namespaces.cards = (namespace) => ({
      ...without('clientEntry')(namespace),
      default: namespace.clientEntry,
    })
    expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
    expect([...h.starts.keys()]).toEqual(['base'])
    const { cards } = h.loaded
    // A definition the host composed, never the namespace itself.
    expect(h.definitions.find((definition) => definition.descriptor.id === 'cards.card')).toStrictEqual({
      descriptor: descriptorOf('cards.card'),
      component: cards?.component,
      format: cards?.format,
      encode: cards?.encode,
    })
    expect(kind(now(h).registry, 'cards.card')).toBe('matched')
    expect(kind(now(h).registry, 'cards.other')).toBe('fallback')
  })

  it.each([
    ['an undeclared renderer', 'base', renderer('base.other')],
    ['a target its declaration lacks', 'base', renderer('base.fallback', ['web', 'sdk'])],
    ["another module's renderer", 'base', renderer('cards.card')],
  ])('refuses to register %s', async (_name, moduleId, definition) => {
    const h = harness()
    let outcome: Outcome<unknown> | undefined
    h.entries[moduleId] = (standard) => async (host) => {
      outcome = host.renderers.register(definition)
      return standard(host)
    }
    expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
    expect(refused(outcome)).toBe('invalid_input/renderer_undeclared')
    expect(h.log.filter((line) => line.startsWith('register'))).toEqual([
      'register base.fallback',
      'register cards.card',
    ])
  })

  it.each([
    ['an undeclared shell', 'base', shell('base.other'), 'invalid_input/shell_undeclared'],
    ["another module's shell", 'cards', shell('base.shell'), 'invalid_input/shell_undeclared'],
    [
      'a shell that cannot be created',
      'base',
      () => {
        throw new Error('broken')
      },
      'invalid_input/shell_invalid',
    ],
  ])('refuses to register %s', async (_name, moduleId, factory, expected) => {
    const h = harness()
    let outcome: Outcome<unknown> | undefined
    h.entries[moduleId] = (standard) => async (host) => {
      outcome = host.registerShell(factory)
      return standard(host)
    }
    expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
    expect(refused(outcome)).toBe(expected)
    expect(now(h).shell()).toBe(h.loaded.base?.workbenchShell)
  })

  it('never lets a registered shell replace the selected export', async () => {
    const h = harness()
    let outcome: Outcome<ClientContribution> | undefined
    h.entries.base = (standard) => async (host) => {
      // The declared shell of this very module, from another factory than its export.
      outcome = host.registerShell(shell('base.shell'))
      return standard(host)
    }
    expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
    if (!outcome?.ok) throw new Error('the shell was not registered')
    expect(now(h).shell()).toBe(h.loaded.base?.workbenchShell)
    await outcome.value.dispose()
    expect(now(h).shell()).toBe(h.loaded.base?.workbenchShell)
  })

  it.each([
    [
      'shell',
      (next: ReturnType<typeof catalog>) => ({
        ...next,
        selection: { ...next.selection, shell: serve('frame', 'frame.shell') },
      }),
    ],
    [
      'registry',
      (next: ReturnType<typeof catalog>) => ({
        ...next,
        selection: { ...next.selection, registry: serve('frame', 'frame.registry') },
      }),
    ],
  ])('loads a %s module without clientEntry once and never activates it', async (_name, select) => {
    const h = harness()
    h.namespaces.frame = without('clientEntry')
    const next = select(catalog(1))
    expect(refused(await h.runtime.activate(next))).toBe('ok')
    expect(sorted(h.log.filter((line) => line.startsWith('load')))).toEqual([
      'load base',
      'load cards',
      'load frame',
    ])
    expect([...h.starts.keys()].sort()).toEqual(['base', 'cards'])
    const selected = next.selection.shell
    expect(now(h).shell()).toBe(selected && h.loaded[selected.moduleId]?.[selected.export])
    expect(kind(now(h).registry, 'cards.card')).toBe('matched')
  })

  it('leases handles only for definitions registered for a module of the live generation', async () => {
    const h = harness()
    /** The card definition the host registered in each generation. */
    const card = (index: number) =>
      at(
        h.definitions.filter((definition) => definition.descriptor.id === 'cards.card'),
        index,
      )
    /** The module host cards was started with in each generation. */
    const modules: ClientHost[] = []
    h.entries.cards = (standard) => async (host) => {
      modules.push(host)
      return standard(host)
    }
    expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
    const first = at(h.hosts, 0)
    const bound = first.bindRenderer(card(0))
    if (!bound.ok) throw new Error(bound.error.message)
    expect(bound.value.id).toBe('cards.card')
    const fallback = resolved(now(h).registry, 'base.fallback')
    if (fallback?.kind !== 'matched') throw new Error('the fallback renderer is not registered')
    // Each module is bound under the owner token its catalog entry carries.
    expect(bound.value.ownerToken).toBe('catalog-cards-1')
    expect(fallback.handle.ownerToken).toBe('catalog-base-1')
    // The handle presents through the lease the presenter issued under the module's token.
    const view = { viewId: 'v1', revision: 1 } as DomainView
    expect(bound.value.present(view)).toEqual({ ok: true, value: { target: 'tui', formatted: view } })
    const lease = (id: string, ownerToken: string) =>
      h.leases.filter((entry) => entry.id === id && entry.ownerToken === ownerToken)
    expect(lease('cards.card', 'catalog-cards-1')).toEqual([
      { id: 'cards.card', ownerToken: 'catalog-cards-1', disposed: 0 },
    ])
    await bound.value.dispose()
    // Releasing a lease ends that lease only and leaves the renderer registered.
    expect(lease('cards.card', 'catalog-cards-1')[0]?.disposed).toBe(1)
    expect(lease('base.fallback', 'catalog-base-1')[0]?.disposed).toBe(0)
    expect(kind(now(h).registry, 'cards.card')).toBe('matched')
    // An equal definition that was never registered.
    expect(refused(first.bindRenderer(renderer('cards.card')))).toBe('denied/renderer_unbound')

    expect(refused(await h.runtime.activate(catalog(2)))).toBe('ok')
    // Releasing the generation ends every lease it still held.
    expect(lease('base.fallback', 'catalog-base-1')[0]?.disposed).toBe(1)
    const second = at(h.hosts, 1)
    expect(refused(first.bindRenderer(card(0)))).toBe('denied/renderer_unbound')
    expect(refused(second.bindRenderer(card(0)))).toBe('denied/renderer_unbound')
    const rebound = second.bindRenderer(card(1))
    if (!rebound.ok) throw new Error(rebound.error.message)
    // The next generation binds the module under that generation's token.
    expect(rebound.value.ownerToken).toBe('catalog-cards-2')

    // A late call from an old owner is refused: the module host the replaced generation started cards
    // with registers, presents and observes nothing, while the current one still registers.
    const old = at(modules, 0)
    expect(refused(old.renderers.register(renderer('cards.other')))).toBe(
      'cancelled/client_generation_released',
    )
    expect(refused(old.registerShell(shell('cards.shell')))).toBe('cancelled/client_generation_released')
    expect(refused(old.presentation.domain({ viewId: 'v1', revision: 1 } as DomainView))).toBe(
      'cancelled/client_generation_released',
    )
    expect(kind(old.renderers, 'cards.card')).toBe('fallback')
    expect(refused(at(modules, 1).renderers.register(renderer('cards.other')))).toBe('ok')
    const told: number[] = []
    old.observeCatalog((revision) => told.push(revision))
    expect(refused(await h.runtime.activate(catalog(3)))).toBe('ok')
    expect(told).toEqual([])
  })

  const late = (h: ReturnType<typeof harness>) => () => async (host: ClientHost) => {
    await sleep(100)
    h.log.push(`late ${refused(host.renderers.register(renderer('cards.other')))}`)
    return contribution(h.log, 'late')
  }
  // The candidate loaded both modules and registered the fallback, then failed on cards.
  const unloaded = ['load base', 'register base.fallback', 'load cards', 'unregister base.fallback']
  // The candidate registered both selected renderers, started base, then failed on the entry of cards.
  const started = [
    'load base',
    'register base.fallback',
    'load cards',
    'register cards.card',
    'dispose base#2',
    'unregister cards.card',
    'unregister base.fallback',
  ]
  const failing: Array<{
    name: string
    target?: ClientTarget
    arrange: (h: ReturnType<typeof harness>) => void
    select?: (next: ReturnType<typeof catalog>) => ReturnType<typeof catalog>
    expected: string
    log: string[]
    eventually?: string[]
    /** Nothing more happens once the refusal returned. */
    quiet?: boolean
  }> = [
    {
      name: 'the registry module cannot be loaded',
      arrange: (h) => {
        h.unloadable = 'base'
      },
      expected: 'internal/client_module_load_failed',
      log: ['load base'],
    },
    {
      name: 'the registry factory throws',
      arrange: (h) => {
        h.namespaces.base = replacing('createRegistry', () => {
          throw new Error('broken')
        })
      },
      expected: 'internal/client_registry_failed',
      log: ['load base'],
    },
    // Every other export of base stays in place, and none of them is taken instead.
    ...(
      [
        ['the registry export is missing', without('createRegistry'), 'client_export_missing'],
        ['the registry export is not a function', replacing('createRegistry', {}), 'client_export_invalid'],
        ['the shell export is missing', without('workbenchShell'), 'client_export_missing'],
        // A shell instance in place of its factory.
        [
          'the shell export is not a function',
          replacing('workbenchShell', shell('base.shell')()),
          'client_export_invalid',
        ],
        [
          'the shell export creates another shell',
          replacing('workbenchShell', shell('cards.shell')),
          'client_export_invalid',
        ],
        [
          'the shell export throws',
          replacing('workbenchShell', () => {
            throw new Error('broken')
          }),
          'client_export_invalid',
        ],
      ] as const
    ).map(([name, edit, detail]) => ({
      name,
      arrange: (h: ReturnType<typeof harness>) => {
        h.namespaces.base = edit
      },
      expected: `incompatible/${detail}`,
      log: ['load base'],
    })),
    {
      name: "the registry's declared export differs from the selection's",
      arrange: () => {},
      select: (next) => ({
        ...next,
        selection: {
          ...next.selection,
          registry: { ...serve('base', 'base.registry'), export: 'workbenchShell' },
        },
      }),
      expected: 'incompatible/registry_undeclared',
      log: [],
    },
    {
      name: "the shell's declared export differs from the selection's",
      arrange: () => {},
      select: (next) => ({
        ...next,
        selection: { ...next.selection, shell: { ...serve('base', 'base.shell'), export: 'createRegistry' } },
      }),
      expected: 'incompatible/shell_undeclared',
      log: ['load base'],
    },
    {
      name: 'a renderer module cannot be loaded',
      arrange: (h) => {
        h.unloadable = 'cards'
      },
      expected: 'internal/client_module_load_failed',
      log: unloaded,
    },
    // The fixed renderer exports for the target, each an own function of the namespace.
    ...(
      [
        ['a Web renderer module has no component', 'web', without('component'), 'client_export_missing'],
        ['component is not a function', 'web', replacing('component', {}), 'client_export_invalid'],
        ['component is inherited', 'web', inheriting('component'), 'client_export_missing'],
        ['a TUI renderer module has no format', 'tui', without('format'), 'client_export_missing'],
        ['an IM renderer module has no encode', 'im', without('encode'), 'client_export_missing'],
      ] as const
    ).map(([name, target, edit, detail]) => ({
      name,
      target,
      arrange: (h: ReturnType<typeof harness>) => {
        h.namespaces.cards = edit
      },
      expected: `incompatible/${detail}`,
      log: unloaded,
    })),
    {
      name: 'reading a renderer export throws',
      arrange: (h) => {
        h.namespaces.cards = unreadable('component')
      },
      expected: 'internal/client_activation_failed',
      log: unloaded,
    },
    {
      name: 'an entry registers a selected renderer again and ignores the refusal',
      arrange: (h) => {
        h.entries.cards = (standard) => async (host) => {
          h.log.push(`again ${refused(host.renderers.register(renderer('cards.card')))}`)
          return standard(host)
        }
      },
      expected: 'conflict/renderer_conflict',
      // Its contribution and both host registrations are released with the candidate.
      log: [...started, 'again conflict/renderer_conflict', 'dispose cards#2'],
    },
    ...(
      [
        [
          'an entry throws',
          (h) =>
            (h.entries.cards = () => async () => {
              throw new Error('broken')
            }),
          'internal/client_entry_failed',
        ],
        [
          'an entry refuses',
          (h) =>
            (h.entries.cards = () => async () => ({
              ok: false,
              error: {
                code: 'denied',
                detailCode: 'no',
                message: 'no',
                retryAdvice: { kind: 'never' },
                diagnosticId: 'client-host-test',
              },
            })),
          'internal/client_entry_failed',
        ],
        [
          'clientEntry is not a function',
          (h) => (h.namespaces.cards = replacing('clientEntry', {})),
          'incompatible/client_entry_invalid',
        ],
      ] as Array<[string, (h: ReturnType<typeof harness>) => void, string]>
    ).map(([name, arrange, expected]) => ({ name, arrange, expected, log: started })),
    {
      name: 'an entry misses its deadline',
      arrange: (h) => {
        h.entries.cards = late(h)
      },
      expected: 'timeout/client_entry_timeout',
      log: [
        'load base',
        'register base.fallback',
        'load cards',
        'register cards.card',
        'unregister cards.card',
        'dispose base#2',
        'unregister base.fallback',
      ],
      // The late entry finds its host released, and what it returns is released too.
      eventually: ['late cancelled/client_generation_released', 'dispose late'],
    },
    {
      name: 'a module loads past its deadline',
      arrange: (h) => {
        h.slow = 'cards'
        h.entries.cards = (standard) => async (host) => {
          h.log.push('start cards')
          return standard(host)
        }
      },
      expected: 'timeout/client_module_load_timeout',
      log: unloaded,
      // The entry of a late load is never started.
      quiet: true,
    },
    {
      name: 'the selection is for another target',
      arrange: () => {},
      select: () => catalog(2, 'tui'),
      expected: 'invalid_input/client_target_mismatch',
      log: [],
    },
    {
      name: 'a selected module is missing from the catalog',
      arrange: () => {},
      select: (next) => ({ ...next, modules: MODULES.filter((module) => module.moduleId !== 'cards') }),
      expected: 'incompatible/client_module_missing',
      log: [],
    },
  ]

  it.each(failing)('keeps the current generation and releases the candidate when $name', async (row) => {
    const target = row.target ?? 'web'
    const h = harness({ target, limits: { entryMs: 50 } })
    expect(refused(await h.runtime.activate(catalog(1, target)))).toBe('ok')
    h.log.length = 0
    row.arrange(h)
    const next = catalog(2, target)
    expect(refused(await h.runtime.activate(row.select ? row.select(next) : next))).toBe(row.expected)
    expect(sorted(h.log)).toEqual(sorted(row.log))
    const generation = now(h)
    expect(generation.revision).toBe(1)
    expect(generation.shell()?.().descriptor.id).toBe(target === 'web' ? 'base.shell' : undefined)
    expect(kind(generation.registry, 'cards.card', target)).toBe('matched')
    if (row.eventually) {
      const eventually = row.eventually
      await vi.waitFor(() => expect(h.log).toEqual(expect.arrayContaining(eventually)))
    }
    if (row.quiet) {
      await sleep(150)
      expect(sorted(h.log)).toEqual(sorted(row.log))
    }
  })

  it('commits a new generation before releasing the old one', async () => {
    const h = harness()
    let currentAtRelease: number | undefined
    h.entries.base = (standard) => async (host) => {
      const started = await standard(host)
      if (!started.ok) return started
      return {
        ok: true,
        value: {
          dispose: async () => {
            currentAtRelease = h.runtime.current()?.revision
            await started.value.dispose()
          },
        },
      }
    }
    expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
    const old = now(h)
    h.log.length = 0
    expect(refused(await h.runtime.activate(catalog(2)))).toBe('ok')
    expect(now(h).revision).toBe(2)
    expect(currentAtRelease).toBe(2)
    // The next generation loads each module afresh, once.
    expect(h.log.filter((line) => line.startsWith('load'))).toEqual(['load base', 'load cards'])
    expect(h.log).toEqual(
      expect.arrayContaining([
        'dispose base#1',
        'dispose cards#1',
        'unregister base.fallback',
        'unregister cards.card',
      ]),
    )
    expect(h.log).not.toContain('dispose base#2')
    expect(old.shell()).toBeUndefined()
    expect(kind(old.registry, 'cards.card')).toBe('fallback')
    expect(refused(old.presentation.domain({ viewId: 'v1', revision: 1 } as DomainView))).toBe(
      'cancelled/client_generation_released',
    )
    expect(kind(now(h).registry, 'cards.card')).toBe('matched')
  })

  it("never lets a replaced generation's disposers remove the next generation's renderers", async () => {
    const h = harness()
    const kept: RendererRegistration[] = []
    h.entries.cards = (standard) => async (host) => {
      const registered = host.renderers.register(renderer('cards.other'))
      if (!registered.ok) return registered
      kept.push(registered.value)
      return standard(host)
    }
    expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
    const old = resolved(now(h).registry, 'cards.card')
    if (old?.kind !== 'matched') throw new Error('the card is not registered')
    expect(refused(await h.runtime.activate(catalog(2)))).toBe('ok')
    h.log.length = 0
    // The first generation's module registration and lease, disposed again once the second is current.
    await at(kept, 0).dispose()
    await old.handle.dispose()
    expect(h.log).toEqual([])
    expect(kind(now(h).registry, 'cards.card')).toBe('matched')
    expect(kind(now(h).registry, 'cards.other')).toBe('matched')
  })

  it('gives up on a dispose past its deadline, reports it and still releases the rest', async () => {
    const h = harness({ limits: { disposeMs: 20 } })
    let context: RendererContext | undefined
    h.entries.cards = (standard) => async (host) => {
      context = host.context
      const started = await standard(host)
      return started.ok ? { ok: true, value: { dispose: () => new Promise<void>(() => {}) } } : started
    }
    h.entries.base = (standard) => async (host) => {
      const started = await standard(host)
      return started.ok
        ? {
            ok: true,
            value: {
              dispose: async () => {
                throw new Error('broken')
              },
            },
          }
        : started
    }
    expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
    const started = Date.now()
    await h.runtime.dispose()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(h.log).toEqual(expect.arrayContaining(['unregister base.fallback', 'unregister cards.card']))
    expect(h.runtime.current()).toBeUndefined()
    // Only the hung release is reported, by module id alone; its context closes all the same.
    expect(h.failures.mock.calls).toEqual([[{ moduleId: 'cards', reason: 'dispose_timeout' }]])
    expect(context?.signal.aborted).toBe(true)
  })

  it("holds a module's contribution and its cleanups to one dispose deadline", async () => {
    const h = harness({ limits: { disposeMs: 40 } })
    // Each part fits the deadline on its own; together they miss it.
    h.entries.cards = (standard) => async (host) => {
      host.context.onDispose(() => sleep(30))
      const started = await standard(host)
      return started.ok ? { ok: true, value: { dispose: () => sleep(30) } } : started
    }
    expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
    await h.runtime.dispose()
    expect(h.failures.mock.calls).toEqual([[{ moduleId: 'cards', reason: 'dispose_timeout' }]])
    expect(h.log).toEqual(
      expect.arrayContaining(['dispose base#1', 'unregister base.fallback', 'unregister cards.card']),
    )
  })

  it('refuses a second activation while one runs', async () => {
    const h = harness()
    let open = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    h.entries.cards = (standard) => async (host) => {
      await gate
      return standard(host)
    }
    const first = h.runtime.activate(catalog(1))
    expect(refused(await h.runtime.activate(catalog(2)))).toBe('conflict/client_activation_in_progress')
    open()
    expect(refused(await first)).toBe('ok')
    expect(now(h).revision).toBe(1)
    expect(refused(await h.runtime.activate(catalog(2)))).toBe('ok')
  })

  it('ends a running activation on dispose and refuses everything after', async () => {
    const h = harness()
    expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
    let open = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    h.entries.cards = (standard) => async (host) => {
      await gate
      return standard(host)
    }
    const running = h.runtime.activate(catalog(2))
    const closing = h.runtime.dispose()
    open()
    expect(refused(await running)).toBe('cancelled/client_host_disposed')
    await closing
    expect(h.runtime.current()).toBeUndefined()
    expect(h.log).toEqual(expect.arrayContaining(['dispose base#1', 'dispose cards#1']))
    // Whatever the stopped candidate had registered is gone with the rest.
    const count = (prefix: string) => h.log.filter((line) => line.startsWith(prefix)).length
    expect(count('register')).toBe(count('unregister'))
    expect(refused(await h.runtime.activate(catalog(3)))).toBe('cancelled/client_host_disposed')
  })

  it('tells catalog observers the revision once their generation is current', async () => {
    const h = harness()
    const seen: string[] = []
    h.entries.base = (standard) => async (host) => {
      host.observeCatalog((revision) => seen.push(`${revision} while ${h.runtime.current()?.revision}`))
      host.observeCatalog(() => {
        throw new Error('observer failed')
      })
      const dropped = host.observeCatalog(() => seen.push('dropped'))
      await dropped.dispose()
      await dropped.dispose()
      return standard(host)
    }
    expect(refused(await h.runtime.activate(catalog(1)))).toBe('ok')
    expect(seen).toEqual(['1 while 1'])
    expect(refused(await h.runtime.activate(catalog(2)))).toBe('ok')
    // The first generation's observer was released with it; the second generation's was told once.
    expect(seen).toEqual(['1 while 1', '2 while 2'])
    h.unloadable = 'cards'
    expect(refused(await h.runtime.activate(catalog(3)))).toBe('internal/client_module_load_failed')
    expect(seen).toEqual(['1 while 1', '2 while 2'])
  })
})
