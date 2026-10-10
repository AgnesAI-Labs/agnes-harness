/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import type { ComparisonSnapshot, EventEnvelope, RuntimeDescriptor } from '@agnes/protocol'
import {
  AgnesClientService,
  CommandService,
  clientModule,
  LocaleService,
  SessionService,
  SlotRegistry,
  ThemeService,
  WorkbenchService,
  type WorkbenchSnapshot,
  type WorkbenchSurfaces,
} from '@agnes/web-client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'

const roots: Context[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
  localStorage.clear()
  sessionStorage.clear()
})
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Missing expected lifecycle evidence')
  return value
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function flush() {
  for (let turn = 0; turn < 30; turn++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}
function observers() {
  const active = new Set<object>()
  class Resize {
    observe() {
      active.add(this)
    }
    unobserve() {}
    disconnect() {
      active.delete(this)
    }
  }
  const NativeMutation = MutationObserver
  class Mutation extends NativeMutation {
    override observe(...args: Parameters<MutationObserver['observe']>) {
      active.add(this)
      super.observe(...args)
    }
    override disconnect() {
      active.delete(this)
      super.disconnect()
    }
  }
  vi.stubGlobal('ResizeObserver', Resize)
  vi.stubGlobal('MutationObserver', Mutation)
  return active
}
const archived: ComparisonSnapshot = {
  id: 'comparison-archived',
  revision: 1,
  phase: 'completed',
  storageState: 'released',
  baselineId: 'baseline',
  baselineDigest: 'a'.repeat(64),
  policyHash: 'b'.repeat(64),
  rounds: [],
  lanes: [
    {
      side: 'left',
      sessionId: 'left',
      runtime: { id: 'native', version: '1' },
      workspaceLabel: 'left',
      phase: 'idle',
      lastSeq: 0,
    },
    {
      side: 'right',
      sessionId: 'right',
      runtime: { id: 'jevloop', version: '1' },
      workspaceLabel: 'right',
      phase: 'idle',
      lastSeq: 0,
    },
  ],
}
const zeroTotal = { state: 'complete', value: 0, knownSubtotal: null, missing: 0 }
/** Minimal complete `SessionAccountingResult` body for the single-line accounting reader. */
const emptyAccounting = {
  afterSeq: 0,
  throughSeq: 0,
  state: 'complete',
  jev: {
    attempts: 0,
    tokens: {
      inputUncached: zeroTotal,
      cacheRead: zeroTotal,
      cacheWrite: zeroTotal,
      output: zeroTotal,
      reasoning: zeroTotal,
    },
    costs: {},
    unpricedAttempts: 0,
  },
  llm: {
    attempts: 0,
    tokens: {
      inputUncached: zeroTotal,
      cacheRead: zeroTotal,
      cacheWrite: zeroTotal,
      output: zeroTotal,
      reasoning: zeroTotal,
    },
    costs: {},
    unpricedAttempts: 0,
  },
  issues: [],
}
async function fixture() {
  vi.useFakeTimers()
  const activeObservers = observers()
  const connectionListeners = new Set<() => void>()
  const client = {
    connectionState: 'connected',
    sessions: { get: () => undefined },
    on: (_name: string, listener: () => void) => {
      connectionListeners.add(listener)
      return () => {
        connectionListeners.delete(listener)
      }
    },
    call: vi.fn(async (method: string, params: { sessionId?: string } = {}): Promise<unknown> => {
      if (method === '_agnes/v1/session.accounting')
        return {
          sessionId: params.sessionId ?? '',
          runtime: { id: 'jevloop', version: '1' },
          accounting: emptyAccounting,
        }
      return { events: [] as EventEnvelope[], lastSeq: 0, nextAfterSeq: null }
    }),
    comparison: {
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
      get: vi.fn(async (_id: string) => structuredClone(archived)),
      journal: vi.fn(async ({ id }: { id: string }) => ({
        id,
        entries: [
          {
            seq: 1,
            cuts: { left: 0, right: 0 },
            fact: {
              kind: 'coordinator',
              revision: 1,
              creation: 'ready',
              lanes: {},
              roundCount: 0,
              latestRound: null,
              cancellation: {},
              cleanup: { exited: ['left', 'right'], released: true },
            },
          },
        ],
        afterSeq: 0,
        throughSeq: 1,
        nextAfterSeq: 1,
        complete: true,
      })),
      projectUI: vi.fn(
        async ({ id, side, atSeq }: { id: string; side: 'left' | 'right'; atSeq: number }) => ({
          id,
          side,
          atSeq,
          sessionId: side,
          throughSeq: 0,
          timeline: { sessionId: side, upto: 0, nodes: [], turns: [] },
        }),
      ),
      cancel: vi.fn(),
      remove: vi.fn(),
      release: vi.fn(),
      priceDetails: vi.fn(),
      metrics: vi.fn(),
    },
  }
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SlotRegistry)
  new AgnesClientService(ctx, client as never)
  new CommandService(ctx, async () => true)
  new SessionService(ctx, undefined, client as never)
  new ThemeService(ctx, 'light')
  new LocaleService(ctx, 'zh-CN')
  const workbench = new WorkbenchService(ctx)
  const root = document.createElement('section')
  const surfaces = Object.fromEntries(
    ['chat', 'aside', 'divider', 'footer', 'toolbar', 'overlay'].map((name) => {
      const element = document.createElement(name === 'aside' ? 'aside' : 'div')
      element.dataset.surface = name
      root.append(element)
      return [name, element]
    }),
  ) as unknown as WorkbenchSurfaces
  surfaces.root = root
  surfaces.aside.hidden = true
  surfaces.divider.hidden = true
  document.body.append(root)
  const openSettings = vi.fn(async (_pane: 'model' | 'jev') => {})
  workbench.configure({ surfaces, select: async () => {}, changed: () => {}, openSettings })
  const publish = (patch: Partial<WorkbenchSnapshot> = {}) =>
    workbench.publish({ ...workbench.snapshot, connected: true, ...patch })
  const mount = () => ctx.plugin(clientModule({ apply }), { packageId: '@agnes/jev-web', revision: '1' })
  return {
    ctx,
    workbench,
    surfaces,
    client,
    mount,
    publish,
    activeObservers,
    connectionListeners,
    openSettings,
  }
}

it('returns Native DOM, observers, timers and subscribers to baseline across ten real module cycles', async () => {
  const { workbench, surfaces, client, mount, publish, activeObservers, connectionListeners, openSettings } =
    await fixture()
  const baseline = surfaces.root.outerHTML
  const timers = vi.getTimerCount()
  expect(document.querySelector('.jev-decision-graph')).toBeNull()
  for (let cycle = 0; cycle < 10; cycle++) {
    publish({ session: { id: 'native-session', runtime: { id: 'native', version: '1' }, head: 0 } })
    const fiber = await mount()
    expect(surfaces.aside.hidden).toBe(true)
    // Each finished cycle leaves one diagnostics read plus one single-line
    // accounting read for its Jev session behind.
    expect(client.call).toHaveBeenCalledTimes(cycle * 2)
    expect(activeObservers.size).toBeGreaterThan(0)
    publish({ session: { id: `jev-${cycle}`, runtime: { id: 'jevloop', version: '1' }, head: 0 } })
    await flush()
    expect(surfaces.aside.hidden).toBe(false)
    expect(surfaces.aside.querySelector('.jev-decision-graph')).not.toBeNull()
    expect(client.call).toHaveBeenCalledTimes(cycle * 2 + 2)
    workbench.event(`jev-${cycle}`, {
      seq: 1,
      id: `event-${cycle}`,
      type: 'runtime/cancel',
      ts: '2026-10-05T00:00:00Z',
      data: {},
    } as unknown as EventEnvelope)
    expect(surfaces.aside.querySelectorAll('.runtime-record-rows li')).toHaveLength(1)
    const oldSettings = required(surfaces.toolbar.querySelector<HTMLButtonElement>('.jev-open-settings'))
    oldSettings.click()
    await flush()
    // Ant Design's shared document-click coordinate timer is bounded to 100 ms.
    await vi.advanceTimersByTimeAsync(100)
    expect(openSettings).toHaveBeenLastCalledWith('jev')
    expect(openSettings).toHaveBeenCalledTimes(cycle + 1)
    const oldButton = required(surfaces.toolbar.querySelector<HTMLButtonElement>('.jev-open-comparison'))
    await fiber.dispose()
    await flush()
    expect(surfaces.root.outerHTML).toBe(baseline)
    expect(workbench.modes).toEqual([])
    expect(activeObservers.size).toBe(0)
    expect(connectionListeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(timers)
    oldSettings.click()
    oldButton.click()
    expect(openSettings).toHaveBeenCalledTimes(cycle + 1)
    publish({ session: { id: `late-${cycle}`, runtime: { id: 'jevloop', version: '1' }, head: 0 } })
    workbench.event(`late-${cycle}`, { seq: 2, type: 'runtime/cancel', data: {} } as unknown as EventEnvelope)
    surfaces.divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await flush()
    expect(client.call).toHaveBeenCalledTimes(cycle * 2 + 2)
    expect(surfaces.root.outerHTML).toBe(baseline)
  }
  expect(client.comparison.cancel).not.toHaveBeenCalled()
  expect(client.comparison.remove).not.toHaveBeenCalled()
  expect(client.comparison.release).not.toHaveBeenCalled()
})

it('hides the dual-line toolbar entry beside single-line sessions and keeps it for drafts and comparison targets', async () => {
  const { workbench, surfaces, mount, publish } = await fixture()
  const fiber = await mount()
  const button = required(surfaces.toolbar.querySelector<HTMLButtonElement>('.jev-open-comparison'))
  const status = required(surfaces.toolbar.querySelector<HTMLElement>('.jev-workspace-status'))
  const capabilities = { prompt: true, cancel: true, resume: true, compact: true, fork: true }
  const runtimes: RuntimeDescriptor[] = [
    { id: 'native', version: '1', label: 'Native', apiVersion: 1, available: true, capabilities },
    { id: 'jevloop', version: '1', label: 'JevLoop', apiVersion: 1, available: true, capabilities },
  ]
  // The host omits the session key for a draft; publish the same shape instead of
  // assigning undefined, which exactOptionalPropertyTypes forbids.
  const draft = (patch: Partial<Omit<WorkbenchSnapshot, 'session'>> = {}) => {
    const { session: _session, ...rest } = workbench.snapshot
    workbench.publish({ ...rest, connected: true, runtimes, loading: false, ...patch })
  }

  draft()
  expect(button.hidden).toBe(false)
  expect(status.hidden).toBe(false)
  expect(workbench.modes.map((mode) => mode.id)).toContain('comparison')

  publish({ runtimes, session: { id: 'native-history', runtime: { id: 'native', version: '1' }, head: 0 } })
  expect(button.hidden).toBe(true)
  expect(status.hidden).toBe(true)
  publish({ runtimes, session: { id: 'jev-history', runtime: { id: 'jevloop', version: '1' }, head: 0 } })
  expect(button.hidden).toBe(true)
  // A session is still loading and has no identity yet; the entry must not flash back.
  draft({ loading: true })
  expect(button.hidden).toBe(true)

  draft()
  expect(button.hidden).toBe(false)

  await expect(workbench.restore(new URL('https://host/?comparison=comparison-archived'))).resolves.toBe(true)
  await flush()
  expect(workbench.target?.provider).toBe('jev-workspace')
  draft({ loading: true })
  expect(button.hidden).toBe(false)
  draft()
  expect(button.hidden).toBe(false)

  // The host opens a session by clearing the extension target first; the entry hides again.
  workbench.clear()
  publish({ runtimes, session: { id: 'native-after', runtime: { id: 'native', version: '1' }, head: 0 } })
  expect(button.hidden).toBe(true)

  await fiber.dispose()
  await flush()
  expect(surfaces.toolbar.querySelector('.jev-open-comparison')).toBeNull()
  expect(surfaces.toolbar.querySelector('.jev-workspace-status')).toBeNull()
})

it('ignores late diagnostic and comparison-history replies after module unload', async () => {
  const { workbench, surfaces, client, mount, publish, activeObservers, connectionListeners } =
    await fixture()
  const diagnostic = deferred<{ events: EventEnvelope[]; lastSeq: number; nextAfterSeq: null }>()
  const history = deferred<{ items: []; nextCursor: null }>()
  client.call.mockImplementationOnce(() => diagnostic.promise)
  client.comparison.list.mockImplementationOnce(() => history.promise)
  publish({ session: { id: 'pending-jev', runtime: { id: 'jevloop', version: '1' }, head: 0 } })
  const baseline = surfaces.root.outerHTML
  const fiber = await mount()
  required(surfaces.toolbar.querySelector<HTMLButtonElement>('.jev-open-comparison')).click()
  await flush()
  expect(client.comparison.list).toHaveBeenCalledOnce()
  expect(connectionListeners.size).toBe(1)
  const dialog = required(surfaces.overlay.querySelector('dialog'))
  await fiber.dispose()
  // Ant Design captures document-click coordinates for 100 ms in a shared UI timer.
  // Let that bounded timer settle; module replay and polling timers must still be absent.
  await vi.advanceTimersByTimeAsync(100)
  const detached = dialog.outerHTML
  diagnostic.resolve({ events: [], lastSeq: 0, nextAfterSeq: null })
  history.resolve({ items: [], nextCursor: null })
  await flush()
  expect(dialog.isConnected).toBe(false)
  expect(dialog.outerHTML).toBe(detached)
  expect(surfaces.root.outerHTML).toBe(baseline)
  expect(activeObservers.size).toBe(0)
  expect(connectionListeners.size).toBe(0)
  expect(workbench.modes).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves a disabled comparison target, refuses submission, and reopens it on reload without backend cancellation', async () => {
  const { workbench, surfaces, client, mount, activeObservers, connectionListeners } = await fixture()
  const baseline = surfaces.root.outerHTML
  let fiber = await mount()
  await expect(workbench.restore(new URL('https://host/?comparison=comparison-archived'))).resolves.toBe(true)
  await flush()
  expect(workbench.target?.id).toBe(archived.id)
  expect(surfaces.overlay.querySelectorAll('.comparison-lane')).toHaveLength(2)
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  await fiber.dispose()
  expect(workbench.available).toBe(false)
  expect(workbench.target?.id).toBe(archived.id)
  await expect(workbench.submit('key', 'follow-up')).rejects.toThrow('已禁用')
  expect(surfaces.root.outerHTML).toBe(baseline)
  expect(vi.getTimerCount()).toBe(0)
  fiber = await mount()
  await flush()
  expect(workbench.available).toBe(true)
  expect(required(surfaces.overlay.querySelector<HTMLDialogElement>('dialog')).open).toBe(true)
  expect(surfaces.overlay.querySelectorAll('.comparison-lane')).toHaveLength(2)
  expect(client.comparison.get).toHaveBeenCalledWith(archived.id)
  await fiber.dispose()
  expect(activeObservers.size).toBe(0)
  expect(connectionListeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(client.comparison.cancel).not.toHaveBeenCalled()
  expect(client.comparison.remove).not.toHaveBeenCalled()
  expect(client.comparison.release).not.toHaveBeenCalled()
})

it('cleans partially applied UI when provider registration fails', async () => {
  const { ctx, workbench, surfaces, mount, activeObservers } = await fixture()
  const conflict = await ctx.plugin({
    apply(owner) {
      workbench.bind(owner, 'collision-owner').register({
        id: 'collision',
        modes: () => [{ id: 'comparison', label: 'collision', available: true }],
        resolve: () => undefined,
        open: async () => {},
        submit: async () => {},
        close: () => {},
      })
    },
  })
  const baseline = surfaces.root.outerHTML
  await expect(Promise.resolve(mount())).rejects.toThrow('duplicate workbench mode')
  await flush()
  expect(surfaces.root.outerHTML).toBe(baseline)
  expect(activeObservers.size).toBe(0)
  expect(workbench.modes.map((mode) => mode.id)).toEqual(['comparison'])
  await conflict.dispose()
})
