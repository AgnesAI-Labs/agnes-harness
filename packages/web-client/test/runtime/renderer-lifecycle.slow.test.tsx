/** @vitest-environment happy-dom */
// Renderer lifecycle under repetition and faults. 100 Web mount/unmount cycles through the presenter,
// 100 text presents per text target and 100 client generation swaps through the host must leave no
// context undisposed, no renderer timer or subscription, no pending deadline timer, no DOM node and no
// retained memory. An entry that hangs and a dispose that hangs are cut off at the host's default
// deadlines (15 000 ms entry, 5 000 ms dispose); those run on fake timers, so nothing waits for real.
//
// Memory: this repository documents no numeric memory budget for client renderer mounts, so the bound is
// relative to a warm-up baseline. The heap is compared after a full collection and may grow by less than
// HEAP_SLACK over a whole run; RSS, which the allocator returns lazily, by less than RSS_SLACK. When no
// collector can be exposed, the heap is held to the RSS tolerance instead.
import type {
  ClientEntry,
  ClientModule,
  DomainView,
  FormattedView,
  NegotiatedClientCapabilities,
  Outcome,
  RendererContext,
  RendererDefinition,
  RendererDescriptor,
  RendererHandle,
  RendererPresentation,
  UIRegistryFactory,
} from '@agnes/extension-api/client'
import { act, type ReactElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ClientModuleLoader, createClientHostRuntime } from '../../src/runtime/client-host.js'
import type {
  ClientModuleContribution,
  ClientTarget,
  SelectedRenderer,
} from '../../src/runtime/client-selection.js'
import { createUIRegistry } from '../../src/runtime/providers/ui-registry.js'
import { createRendererPresenter } from '../../src/runtime/renderer-presentation.js'

// Every context the presenter opens, seen through the factory it imports. The tracker's cleanup is the
// first one registered, so it starts last: `cleaned` reaches 1 once disposing reached every cleanup.
const opened = vi.hoisted(() => [] as { cleaned: number; aborted: number; ref: WeakRef<object> }[])
vi.mock('../../src/runtime/renderer-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/renderer-context.js')>()
  return {
    createRendererContext(input: Parameters<typeof actual.createRendererContext>[0]) {
      const mounted = actual.createRendererContext(input)
      const entry = { cleaned: 0, aborted: 0, ref: new WeakRef(mounted) }
      mounted.context.onDispose(() => {
        entry.cleaned += 1
      })
      mounted.context.signal.addEventListener('abort', () => {
        entry.aborted += 1
      })
      opened.push(entry)
      return mounted
    },
  }
})

const MIB = 1024 * 1024
// A clean run grew the heap by about 0.3 MiB (Web cycles) and 0.8 MiB (generation swaps, whose handles
// the test holds); keeping all 100 Web trees mounted grew it by about 10 MiB.
const HEAP_SLACK = 2 * MIB
const RSS_SLACK = 64 * MIB

// This package compiles without Node types, so the few Node APIs used here are typed locally.
const node = globalThis as unknown as {
  gc?: () => void
  setImmediate(callback: () => void): void
  process: {
    memoryUsage(): { heapUsed: number; rss: number }
    getBuiltinModule(id: 'node:v8'): { setFlagsFromString(flags: string): void }
    getBuiltinModule(id: 'node:vm'): { runInNewContext(code: string): unknown }
  }
}

/** A full collection: the process's own `gc`, else one V8 exposes on request, else none. */
const gc = ((): (() => void) | undefined => {
  if (typeof node.gc === 'function') return node.gc
  try {
    node.process.getBuiltinModule('node:v8').setFlagsFromString('--expose-gc')
    const exposed = node.process.getBuiltinModule('node:vm').runInNewContext('gc')
    return typeof exposed === 'function' ? (exposed as () => void) : undefined
  } catch {
    return undefined
  }
})()

async function memory() {
  await new Promise<void>((resolve) => node.setImmediate(resolve))
  gc?.()
  return node.process.memoryUsage()
}

/** Runs `run` and holds what it leaves behind to the bounds above. */
async function retained(run: () => Promise<void>) {
  const before = await memory()
  await run()
  const after = await memory()
  expect(after.heapUsed - before.heapUsed).toBeLessThan(gc ? HEAP_SLACK : RSS_SLACK)
  expect(after.rss - before.rss).toBeLessThan(RSS_SLACK)
}

const DIGEST = 'a'.repeat(64)
const RENDER_KEY = 'acme.notes/card'
const TARGETS: ClientTarget[] = ['web', 'tui', 'im', 'sdk']

const view: DomainView = {
  kind: 'domain',
  viewId: 'note-1',
  revision: 1,
  domainType: 'acme.notes',
  viewSchema: { typeId: 'acme.notes/view@1', revision: 1, digest: DIGEST },
  renderKey: RENDER_KEY,
  scope: {
    kind: 'session',
    installationId: 'install-1',
    runtimeId: 'runtime-1',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
  },
  source: { eventIds: ['event-1'], projectionRevision: 1 },
  phase: 'finalized',
  fallbackText: 'Note saved',
  data: {},
  resources: [],
  actions: [],
}

type Component = (props: { view: DomainView; context: RendererContext }) => ReactElement | null

const descriptorOf = (id: string, renderKey = RENDER_KEY): RendererDescriptor => ({
  id,
  packageDigest: DIGEST,
  renderKey,
  targets: TARGETS,
  viewSchemaRanges: [{ typeId: 'acme.notes/view@1', minRevision: 1, maxRevision: 1 }],
  requiredFeatures: [],
  optionalFeatures: [],
  scope: 'view',
  entry: './card.js',
})

/** The fixed exports of a renderer module for every target. */
const fixed = (component: Component) => ({
  component,
  format: (shown: DomainView): Outcome<FormattedView> => ({
    ok: true,
    value: {
      viewId: shown.viewId,
      revision: shown.revision,
      parts: [],
      complete: true,
      unsupportedRequiredFeatures: [],
    },
  }),
  encode: () => {
    throw new Error('not encoded')
  },
})

/** A renderer for every target, presenting `renderKey`. */
const definition = (id: string, component: Component, renderKey = RENDER_KEY) =>
  ({ descriptor: descriptorOf(id, renderKey), ...fixed(component) }) as unknown as RendererDefinition

/** Subscriptions renderers hold. A Card adds one and an interval, and releases both through onDispose. */
const feed = new Set<() => void>()

function Card({ view, context }: { view: DomainView; context: RendererContext }): ReactElement {
  useEffect(() => {
    const timer = setInterval(() => {}, 1_000)
    const listener = () => {}
    feed.add(listener)
    context.onDispose(() => {
      clearInterval(timer)
      feed.delete(listener)
    })
  }, [context])
  return <p>{`card ${view.viewId}@${view.revision}`}</p>
}

/** The contexts a Broken renderer was rendered with, the committed one last. */
const given: RendererContext[] = []

function Broken({ context }: { context: RendererContext }): ReactElement {
  given.push(context)
  throw new Error('broken renderer')
}

/** A renderer whose cleanup never finishes. */
function Stuck({ context }: { context: RendererContext }): ReactElement {
  useEffect(() => {
    context.onDispose(() => new Promise<void>(() => {}))
  }, [context])
  return <p>stuck</p>
}

const capabilities = {
  clientInstanceId: 'client-1',
  target: 'web',
  features: [],
} as unknown as NegotiatedClientCapabilities

// The generic card a failed renderer yields to reads the locale.
const services = {
  locale: { locale: 'en', text: (key: string) => key, formatNumber: () => '', formatDate: () => '' },
} as unknown as Pick<RendererContext, 'commands' | 'interactions' | 'artifacts' | 'locale'>

const presenterFor = (target: ClientTarget) =>
  createRendererPresenter({
    target,
    clientInstanceId: 'client-1',
    capabilities,
    locale: 'en',
    services,
    views: { current: (viewId) => (viewId === view.viewId ? view : undefined) },
  })

const outcome = (result: Outcome<unknown>) =>
  result.ok ? 'ok' : `${result.error.code}/${result.error.detailCode}`

function element(result: Outcome<RendererPresentation>): ReactElement {
  if (!result.ok || result.value.target !== 'web') throw new Error(`not a Web element: ${outcome(result)}`)
  return result.value.element
}

/** Mounts `node` into a fresh container under its own root. */
async function mount(node: ReactElement) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(node))
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

/** Whether `promise` has settled once `ms` more fake milliseconds have passed. */
async function settlesWithin(promise: Promise<unknown>, ms: number) {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await vi.advanceTimersByTimeAsync(ms)
  return settled
}

// `base` holds the registry and the fallback renderer; `cards` and `notes` each hold a card renderer for
// the same render key, and catalogs alternate between them.
const DECLARED: Record<string, ReadonlyArray<readonly [ClientModuleContribution['kind'], string]>> = {
  base: [
    ['registry', 'base.registry'],
    ['renderer', 'base.fallback'],
  ],
  cards: [['renderer', 'cards.card']],
  notes: [['renderer', 'notes.card']],
}

/** The fallback presents its own render key; each card presents the card's. */
const keyOf = (contributionId: string) => (contributionId === 'base.fallback' ? contributionId : RENDER_KEY)

const pick = (moduleId: string, contributionId: string) => ({
  moduleId,
  packageId: `acme.${moduleId}`,
  packageDigest: DIGEST,
  entryPath: `./${moduleId}.js`,
  contributionId,
})
const chose = (moduleId: string, contributionId: string): SelectedRenderer => ({
  ...pick(moduleId, contributionId),
  descriptor: descriptorOf(contributionId, keyOf(contributionId)),
})

const catalog = (revision: number, target: ClientTarget, card = revision % 2 ? 'cards' : 'notes') => ({
  revision,
  modules: Object.keys(DECLARED).map(
    (moduleId): ClientModule => ({
      moduleId,
      packageId: `acme.${moduleId}`,
      packageDigest: DIGEST,
      assetDigest: DIGEST,
      entryPath: `./${moduleId}.js`,
      ownerToken: `catalog-${moduleId}-${revision}`,
      authorApiMajor: 1,
      targets: TARGETS,
      schemas: [],
      requiredFeatures: [],
      styles: [],
      contributions: (DECLARED[moduleId] ?? []).map(
        ([kind, contributionId]) =>
          ({
            contributionId,
            kind,
            ...(kind === 'registry'
              ? { export: 'createRegistry' }
              : { descriptor: descriptorOf(contributionId, keyOf(contributionId)) }),
            targets: TARGETS,
          }) as ClientModuleContribution,
      ),
    }),
  ),
  selection: {
    kind: 'selected' as const,
    target,
    shell: null,
    registry: { ...pick('base', 'base.registry'), export: 'createRegistry' },
    fallbackRenderer: chose('base', 'base.fallback'),
    renderers: [{ renderKey: RENDER_KEY, renderer: chose(card, `${card}.card`) }],
  },
})

/**
 * A host runtime over a fake loader, the default registry and a real presenter, at the default limits.
 * Every module exports the fixed renderer functions over `component`, from which the host registers the
 * selected renderers before it starts any entry. `started` holds every renderer registration and entry
 * contribution with its generation and how often it was disposed; `entries` replaces one module's entry.
 */
function harness(target: ClientTarget, component: Component = Card) {
  const started: { generation: number; what: string; disposed: number }[] = []
  let generation = 0
  const factory: UIRegistryFactory = (host) => {
    const own = ++generation
    const made = createUIRegistry(host)
    if (!made.ok) return made
    const { register, resolve } = made.value
    return {
      ok: true,
      value: {
        resolve,
        register(registering) {
          const registered = register(registering)
          if (!registered.ok) return registered
          const entry = { generation: own, what: `register ${registered.value.id}`, disposed: 0 }
          started.push(entry)
          const dispose = async () => {
            entry.disposed += 1
            await registered.value.dispose()
          }
          return { ok: true, value: { ...registered.value, dispose } }
        },
      },
    }
  }
  const standard =
    (moduleId: string): ClientEntry =>
    async () => {
      const entry = { generation, what: `entry ${moduleId}`, disposed: 0 }
      started.push(entry)
      const dispose = async () => {
        entry.disposed += 1
      }
      return { ok: true, value: { dispose } }
    }
  const entries: Record<string, (own: ClientEntry) => ClientEntry> = {}
  const loader: ClientModuleLoader = {
    load: async (module) => {
      const own = standard(module.moduleId)
      return {
        ok: true,
        value: {
          clientEntry: entries[module.moduleId]?.(own) ?? own,
          createRegistry: factory,
          ...fixed(component),
        },
      }
    },
  }
  const runtime = createClientHostRuntime({
    target,
    loader,
    clientInstanceId: 'client-1',
    capabilities,
    locale: services.locale,
    presenter: presenterFor(target),
  })
  /** The current generation's handle for the card view. */
  const handle = (): RendererHandle => {
    const resolved = runtime
      .current()
      ?.registry.resolve({ renderKey: RENDER_KEY, viewSchema: view.viewSchema, target, requiredFeatures: [] })
    if (resolved?.ok !== true || resolved.value.kind !== 'matched') throw new Error('the card is not bound')
    return resolved.value.handle
  }
  const of = (revision: number) => started.filter((entry) => entry.generation === revision)
  return { runtime, started, entries, handle, of }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  // Only timers are faked, so vi.getTimerCount() counts every timeout and interval left pending.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  opened.length = 0
  feed.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('renderer lifecycle', () => {
  it('leaves no context, timer, subscription or node after 100 Web mount/unmount cycles', async () => {
    const presenter = presenterFor('web')
    const card = definition('acme.notes.card', Card)
    const leases: ReturnType<typeof presenter.lease>[] = []
    const cycle = async (index: number) => {
      const lease = presenter.lease({ definition: card, ownerToken: `owner-${index}` })
      leases.push(lease)
      const mounted = await mount(element(lease.present(view)))
      expect(mounted.container.textContent).toBe('card note-1@1')
      expect([vi.getTimerCount(), feed.size]).toEqual([1, 1])
      // Every tenth lease is released while its view is still mounted; the unmount then finds it disposed.
      if (index % 10 === 9) {
        await lease.dispose()
        expect([vi.getTimerCount(), feed.size]).toEqual([0, 0])
        expect(outcome(lease.present(view))).toBe('cancelled/renderer_released')
      }
      await mounted.unmount()
      expect([vi.getTimerCount(), feed.size, mounted.container.childNodes.length]).toEqual([0, 0, 0])
    }

    for (let index = 0; index < 10; index++) await cycle(index)
    await retained(async () => {
      for (let index = 10; index < 110; index++) await cycle(index)
    })

    expect(opened).toHaveLength(110)
    expect(opened.filter((entry) => entry.cleaned !== 1 || entry.aborted !== 1)).toEqual([])
    // Every lease is still held, yet none keeps a context it mounted.
    if (gc) expect(opened.filter((entry) => entry.ref.deref() !== undefined)).toEqual([])
    // Releasing every lease again runs no cleanup a second time.
    await Promise.all(leases.map((lease) => lease.dispose()))
    expect(opened.filter((entry) => entry.cleaned !== 1 || entry.aborted !== 1)).toEqual([])
    expect(document.body.childNodes.length).toBe(0)
  })

  it('switches a renderer that throws to the generic card and disposes both contexts', async () => {
    // React reports the error the boundary caught.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const presenter = presenterFor('web')
    const broken = definition('acme.notes.broken', Broken)
    for (let index = 0; index < 10; index++) {
      given.length = 0
      const lease = presenter.lease({ definition: broken, ownerToken: `owner-${index}` })
      const mounted = await mount(
        <>
          {element(lease.present(view))}
          <span>sibling</span>
        </>,
      )
      expect(mounted.container.querySelector('.generic-domain-view')?.textContent).toContain(
        view.fallbackText,
      )
      expect(mounted.container.lastChild?.textContent).toBe('sibling')
      // The failed renderer's context closes when it fails, before the view unmounts.
      expect(given.at(-1)?.signal.aborted).toBe(true)
      await mounted.unmount()
      expect(mounted.container.childNodes.length).toBe(0)
      // The render React discarded after the throw opened no context, so unmounting closed them all.
      expect(opened.filter((entry) => entry.cleaned !== 1 || entry.aborted !== 1)).toEqual([])
      await lease.dispose()
    }
    // One context for each failed renderer and one for each generic card that replaced it.
    expect(opened.length).toBe(20)
    expect(opened.filter((entry) => entry.cleaned !== 1 || entry.aborted !== 1)).toEqual([])
    expect([vi.getTimerCount(), document.body.childNodes.length]).toEqual([0, 0])
  })

  it.each<ClientTarget>(['tui', 'sdk', 'im'])('opens no context over 100 %s presents', async (target) => {
    const presenter = presenterFor(target)
    const card = definition('acme.notes.card', Card)
    const cycle = async (index: number) => {
      const lease = presenter.lease({ definition: card, ownerToken: `owner-${index}` })
      expect(outcome(lease.present(view))).toBe('ok')
      if (index % 10 === 9) {
        await lease.dispose()
        expect(outcome(lease.present(view))).toBe('cancelled/renderer_released')
      }
    }
    for (let index = 0; index < 10; index++) await cycle(index)
    await retained(async () => {
      for (let index = 10; index < 110; index++) await cycle(index)
    })
    expect([opened.length, vi.getTimerCount(), feed.size]).toEqual([0, 0, 0])
  })

  it('releases every contribution, registration and lease of 100 replaced generations once', async () => {
    const h = harness('tui')
    const handles: RendererHandle[] = []
    const swap = async (revision: number) => {
      expect(outcome(await h.runtime.activate(catalog(revision, 'tui')))).toBe('ok')
      const current = h.handle()
      expect(current.id).toBe(revision % 2 ? 'cards.card' : 'notes.card')
      expect(outcome(current.present(view))).toBe('ok')
      const previous = handles.at(-1)
      if (previous) expect(outcome(previous.present(view))).toBe('cancelled/renderer_released')
      handles.push(current)
    }

    for (let revision = 1; revision <= 10; revision++) await swap(revision)
    await retained(async () => {
      for (let revision = 11; revision <= 110; revision++) await swap(revision)
    })

    // Generation 110 is current: only what it started is live, and every earlier start was released once.
    expect(h.started).toHaveLength(440)
    expect(h.started.filter((entry) => entry.disposed !== (entry.generation === 110 ? 0 : 1))).toEqual([])
    expect(h.of(110).map((entry) => entry.what)).toEqual([
      'register base.fallback',
      'register notes.card',
      'entry base',
      'entry notes',
    ])
    const presented = handles.map((handle) => outcome(handle.present(view)))
    expect(presented.filter((result) => result !== 'cancelled/renderer_released')).toEqual(['ok'])
    expect(vi.getTimerCount()).toBe(0)

    await h.runtime.dispose()
    expect(h.started.filter((entry) => entry.disposed !== 1)).toEqual([])
    expect(handles.map((handle) => outcome(handle.present(view)))).toEqual(
      handles.map(() => 'cancelled/renderer_released'),
    )
    expect([opened.length, vi.getTimerCount()]).toEqual([0, 0])
  })

  it('refuses an entry that hangs at the 15 000 ms default and releases what it returns late', async () => {
    const h = harness('tui')
    expect(outcome(await h.runtime.activate(catalog(1, 'tui')))).toBe('ok')
    let arrive = () => {}
    const gate = new Promise<void>((resolve) => {
      arrive = resolve
    })
    // Starts, then hangs before returning its contribution.
    h.entries.notes = (own) => async (host) => {
      const started = await own(host)
      await gate
      return started
    }

    const activation = h.runtime.activate(catalog(2, 'tui'))
    expect(await settlesWithin(activation, 14_999)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const refused = await activation
    expect(outcome(refused)).toBe('timeout/client_entry_timeout')
    expect(!refused.ok && refused.error.message).toContain('within 15000 ms')
    expect(h.runtime.current()?.revision).toBe(1)
    expect(h.of(1).every((entry) => entry.disposed === 0)).toBe(true)
    // The candidate released everything it held; the contribution still on its way is not held yet.
    expect(h.of(2).map((entry) => [entry.what, entry.disposed])).toEqual([
      ['register base.fallback', 1],
      ['register notes.card', 1],
      ['entry base', 1],
      ['entry notes', 0],
    ])

    arrive()
    await vi.waitFor(() => expect(h.of(2).every((entry) => entry.disposed === 1)).toBe(true))
    expect(vi.getTimerCount()).toBe(0)
    await h.runtime.dispose()
  })

  it.each([
    { name: 'an entry contribution', target: 'tui' as const, component: Card, hangEntry: true },
    { name: 'a mounted renderer cleanup', target: 'web' as const, component: Stuck, hangEntry: false },
  ])(
    'gives up on $name whose dispose hangs at the 5 000 ms default',
    async ({ target, component, hangEntry }) => {
      const h = harness(target, component)
      if (hangEntry)
        h.entries.cards = (own) => async (host) => {
          const started = await own(host)
          if (!started.ok) return started
          const dispose = async () => {
            await started.value.dispose()
            await new Promise<void>(() => {})
          }
          return { ok: true, value: { dispose } }
        }
      expect(outcome(await h.runtime.activate(catalog(1, target)))).toBe('ok')
      const handle = h.handle()
      const presented = handle.present(view)
      expect(outcome(presented)).toBe('ok')
      const mounted = target === 'web' ? await mount(element(presented)) : undefined

      const activation = h.runtime.activate(catalog(2, target))
      expect(await settlesWithin(activation, 4_999)).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(outcome(await activation)).toBe('ok')
      expect(h.runtime.current()?.revision).toBe(2)
      // The rest of the old generation was still released, once, and its lease presents nothing.
      expect(h.of(1).filter((entry) => entry.disposed !== 1)).toEqual([])
      expect(outcome(handle.present(view))).toBe('cancelled/renderer_released')
      // A renderer still sees its signal aborted even though its own cleanup never finishes, and that
      // cleanup holds up none of the context's other cleanups.
      expect(opened.map((entry) => entry.aborted)).toEqual(target === 'web' ? [1] : [])
      expect(opened.map((entry) => entry.cleaned)).toEqual(target === 'web' ? [1] : [])
      expect(vi.getTimerCount()).toBe(0)
      await mounted?.unmount()
    },
  )
})
