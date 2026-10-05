/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import type { EventEnvelope } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgnesClientService,
  CommandService,
  clientModule,
  LocaleService,
  SessionService,
  SlotRegistry,
  ThemeService,
  type WorkbenchClient,
  type WorkbenchProvider,
  WorkbenchService,
  type WorkbenchSnapshot,
  type WorkbenchTarget,
} from '../src/index.js'

const roots: Context[] = []
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(
  select = vi.fn(async (_target: WorkbenchTarget | undefined, _current?: () => boolean) => {}),
) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SlotRegistry)
  const client = { sessions: { get: () => undefined } } as never
  new AgnesClientService(ctx, client)
  new CommandService(ctx, async () => true)
  new SessionService(ctx, undefined, client)
  new ThemeService(ctx, 'light')
  new LocaleService(ctx, 'zh-CN')
  const workbench = new WorkbenchService(ctx)
  workbench.configure({
    surfaces: Object.fromEntries(
      ['root', 'chat', 'aside', 'divider', 'footer', 'toolbar', 'overlay'].map((name) => [
        name,
        document.createElement('div'),
      ]),
    ) as never,
    select,
    changed: vi.fn(),
  })
  const state = (patch: Partial<WorkbenchSnapshot> = {}) => {
    workbench.publish({ ...workbench.snapshot, ...patch })
  }
  const mount = async (owner: string, apply?: (api: WorkbenchClient) => void) => {
    let api!: WorkbenchClient
    const fiber = await ctx.plugin(
      clientModule({
        apply(module) {
          if (!module.workbench) throw new Error('missing workbench')
          api = module.workbench
          apply?.(api)
        },
      }),
      { packageId: owner, revision: '1' },
    )
    return { api, fiber }
  }
  return { ctx, workbench, mount, state, select }
}

function provider(id = 'plugin-a', overrides: Partial<WorkbenchProvider> = {}): WorkbenchProvider {
  return {
    id,
    modes: () => [{ id, label: id, available: true }],
    resolve: (url) => url.searchParams.get(id) ?? undefined,
    open: vi.fn(async () => {}),
    submit: vi.fn(async () => {}),
    close: vi.fn(),
    ...overrides,
  }
}
function target(id = 'plugin-a', record = 'record-1'): WorkbenchTarget {
  return {
    provider: id,
    id: record,
    mode: id,
    title: 'Target',
    label: id,
    hint: 'hint',
    modelLabel: 'model',
    workspaceLabel: 'workspace',
    query: { [id]: record },
  }
}
const event = { seq: 1, type: 'turn.start', ts: '2026-10-05T00:00:00Z', data: {} } as unknown as EventEnvelope

describe('WorkbenchService fiber ownership', () => {
  it('removes providers and both subscriptions across ten real module enable/disable cycles', async () => {
    const { mount, workbench, state } = await fixture()
    state({ session: { id: 'session-a', head: 1 } })
    const snapshots: number[] = []
    const events: number[] = []
    for (let cycle = 0; cycle < 10; cycle++) {
      const plug = provider()
      const { api, fiber } = await mount('module-a', (bound) => {
        bound.register(plug)
        bound.subscribe((value) => snapshots.push(value.revision))
        bound.observe((value) => events.push(value.seq))
      })
      state()
      workbench.event('session-a', event)
      expect(snapshots).toHaveLength(cycle + 1)
      expect(events).toHaveLength(cycle + 1)
      expect(workbench.modes.map((mode) => mode.id)).toEqual(['plugin-a'])
      await fiber.dispose()
      expect(plug.close).toHaveBeenCalledOnce()
      expect(workbench.modes).toEqual([])
      state()
      workbench.event('session-a', event)
      expect(snapshots).toHaveLength(cycle + 1)
      expect(events).toHaveLength(cycle + 1)
      expect(() => api.register(plug)).toThrow('已卸载')
      expect(() => api.subscribe(() => {})).toThrow('已卸载')
    }
  })

  it('captures deeply immutable snapshots and targets without letting one subscriber corrupt another', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { mount, workbench, state } = await fixture()
    const { api } = await mount('module-a')
    const plug = provider()
    api.register(plug)
    let seen: WorkbenchSnapshot | undefined
    api.subscribe((value) => {
      Object.assign(value.model ?? {}, { route: 'corrupt' })
    })
    api.subscribe((value) => {
      seen = value
    })
    const input = { route: 'account-a', model: 'model-a' }
    state({ selectedMode: 'plugin-a', model: input })
    input.route = 'changed outside'
    expect(seen?.model?.route).toBe('account-a')
    expect(api.snapshot).toBe(workbench.snapshot)
    expect(Object.isFrozen(api.snapshot.model)).toBe(true)
    const selected = target()
    await api.select(selected)
    selected.query = { 'plugin-a': 'mutated' }
    expect(workbench.target?.query).toEqual({ 'plugin-a': 'record-1' })
    expect(() => {
      Object.assign(api.target?.query ?? {}, { 'plugin-a': 'bad' })
    }).toThrow()
    await workbench.submit('key', 'text')
    const capture = vi.mocked(plug.submit).mock.calls[0]?.[0].snapshot
    state({ model: { route: 'account-b', model: 'model-b' } })
    expect(capture?.model?.route).toBe('account-a')
    expect(Object.isFrozen(capture?.model)).toBe(true)
  })

  it('dispatches only the selected provider and refuses a missing bound provider instead of Native fallback', async () => {
    const { mount, workbench, state } = await fixture()
    const a = await mount('module-a')
    const b = await mount('module-b')
    const pa = provider('plugin-a', { errorMessage: () => 'a error' })
    const pb = provider('plugin-b', { errorMessage: () => 'b error' })
    a.api.register(pa)
    b.api.register(pb)
    state({ selectedMode: 'plugin-b' })
    await workbench.submit('first', 'draft')
    expect(pb.submit).toHaveBeenCalledOnce()
    expect(pa.submit).not.toHaveBeenCalled()
    await a.api.select(target())
    await expect(b.api.select(target())).rejects.toThrow('其他模块')
    await expect(b.api.select(undefined)).rejects.toThrow('其他模块')
    await workbench.submit('second', 'bound')
    expect(vi.mocked(pa.submit).mock.calls[0]?.[0].target).toBe('record-1')
    expect(workbench.errorMessage(new Error())).toBe('a error')
    await a.fiber.dispose()
    expect(workbench.available).toBe(false)
    await expect(workbench.submit('third', 'unavailable')).rejects.toThrow('已禁用')
    expect(workbench.errorMessage(new Error())).toBeUndefined()
    expect(pb.submit).toHaveBeenCalledOnce()
  })

  it('keeps an accepted pending submission successful while rejecting its late navigation after unload', async () => {
    const gate = deferred()
    const { mount, workbench, state, select } = await fixture()
    const { api, fiber } = await mount('module-a')
    let navigationError: unknown
    const plug = provider('plugin-a', {
      submit: async () => {
        await gate.promise
        try {
          await api.select(target())
        } catch (error) {
          navigationError = error
        }
      },
    })
    api.register(plug)
    state({ selectedMode: 'plugin-a' })
    const pending = workbench.submit('accepted-key', 'accepted task')
    await fiber.dispose()
    gate.resolve()
    await expect(pending).resolves.toBe(true)
    expect(navigationError).toBeInstanceOf(Error)
    expect(select).not.toHaveBeenCalled()
    expect(plug.close).toHaveBeenCalledOnce()
  })

  it('invalidates pending host selection on unload and clear without restoring a stale target', async () => {
    const gate = deferred()
    const navigated: string[] = []
    const hostSelect = vi.fn(async (selected: WorkbenchTarget | undefined, current?: () => boolean) => {
      await gate.promise
      if (current?.() && selected) navigated.push(selected.id)
    })
    const { mount, workbench } = await fixture(hostSelect)
    const { api, fiber } = await mount('module-a')
    api.register(provider())
    const pending = api.select(target())
    const rejected = expect(pending).rejects.toThrow('已卸载')
    await fiber.dispose()
    gate.resolve()
    await rejected
    expect(navigated).toEqual([])
    expect(workbench.target?.id).toBe('record-1')
    expect(workbench.available).toBe(false)
    workbench.clear()
    expect(workbench.target).toBeUndefined()
    const next = await mount('module-a')
    next.api.register(provider())
    const switching = next.api.select(target('plugin-a', 'record-2'))
    const stale = expect(switching).rejects.toThrow('选择已改变')
    workbench.clear()
    await stale
    expect(navigated).toEqual([])
    expect(workbench.target).toBeUndefined()
  })

  it('refuses duplicate modes, dynamic collisions, unknown selections and ambiguous or unknown routes', async () => {
    const { mount, workbench, state } = await fixture()
    const a = await mount('module-a')
    const b = await mount('module-b')
    const pa = provider()
    a.api.register(pa)
    expect(() =>
      b.api.register(
        provider('different', { modes: () => [{ id: 'plugin-a', label: 'collision', available: true }] }),
      ),
    ).toThrow('duplicate workbench mode')
    expect(() =>
      b.api.register(
        provider('duplicate', {
          modes: () => [
            { id: 'one', label: 'one', available: true },
            { id: 'one', label: 'one', available: true },
          ],
        }),
      ),
    ).toThrow('duplicate workbench mode')
    expect(() => b.api.register(provider('plugin-a'))).toThrow('duplicate workbench provider')
    state({ selectedMode: 'unknown' })
    await expect(workbench.submit('key', 'draft')).rejects.toThrow('不可用')
    state({ selectedMode: 'native' })
    await expect(workbench.submit('key', 'draft')).resolves.toBe(false)
    await expect(workbench.restore(new URL('https://host/?unknown=record'))).rejects.toThrow('尚未加载')
    await expect(workbench.restore(new URL('https://host/?session=native-record'))).resolves.toBe(false)
    await expect(workbench.restore(new URL('https://host/?plugin-a=record'))).resolves.toBe(true)
    expect(pa.open).toHaveBeenCalledWith('record')
    const pb = provider('plugin-b', {
      resolve: () => 'ambiguous',
      modes: (snapshot) => [
        { id: snapshot.connected ? 'plugin-a' : 'plugin-b', label: 'b', available: true },
      ],
    })
    b.api.register(pb)
    await expect(workbench.restore(new URL('https://host/?plugin-a=record'))).rejects.toThrow('多个插件')
    expect(pb.open).not.toHaveBeenCalled()
    state({ connected: true })
    await expect(workbench.submit('key', 'draft')).rejects.toThrow('duplicate workbench mode')
  })
})

describe('WorkbenchService replay cut', () => {
  it('shares value-deduplicated cut notifications and clears only the cut its module owns', async () => {
    const { mount, workbench } = await fixture()
    const seen: Array<{ sessionId: string; through: number } | undefined> = []
    const off = workbench.observeReplayCut((cut) => seen.push(cut))
    const a = await mount('module-a')
    const b = await mount('module-b')
    a.api.setReplayCut({ sessionId: 'session-a', through: 12 })
    expect(workbench.replayCut).toEqual({ sessionId: 'session-a', through: 12 })
    expect(seen).toHaveLength(1)
    a.api.setReplayCut({ sessionId: 'session-a', through: 12 })
    expect(seen).toHaveLength(1)
    a.api.setReplayCut({ sessionId: 'session-a', through: 40 })
    expect(seen.at(-1)).toEqual({ sessionId: 'session-a', through: 40 })
    // A different module's unload must not clear a cut it does not own.
    await b.fiber.dispose()
    expect(workbench.replayCut).toEqual({ sessionId: 'session-a', through: 40 })
    expect(seen).toHaveLength(2)
    // The owning module's unload restores the live conversation.
    await a.fiber.dispose()
    expect(workbench.replayCut).toBeUndefined()
    expect(seen.at(-1)).toBeUndefined()
    // Host-side cuts survive module lifecycles; clear() also clears them.
    workbench.setReplayCut({ sessionId: 'session-a', through: 7 })
    const c = await mount('module-c')
    await c.fiber.dispose()
    expect(workbench.replayCut).toEqual({ sessionId: 'session-a', through: 7 })
    workbench.clear()
    expect(workbench.replayCut).toBeUndefined()
    off()
    workbench.setReplayCut({ sessionId: 'session-a', through: 9 })
    expect(seen.at(-1)).toBeUndefined()
    expect(() => a.api.setReplayCut(undefined)).toThrow('已卸载')
  })
})
