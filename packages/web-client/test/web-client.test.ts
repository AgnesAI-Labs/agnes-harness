/** @vitest-environment happy-dom */
// WC6 合同测试：注册/撤销、未知槽位 fail-closed、排序、fiber 绑定门面、outlet 渲染与错误边界。

import { Context } from '@agnes/cordis'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext, DshSlotProps } from '../src/index.js'
import {
  AgnesClientService,
  ClientResourceReclaimedError,
  ClientResourceService,
  CommandService,
  clientModule,
  DSH_SLOT_CATALOG_VERSION,
  LocaleService,
  SessionService,
  SlotOutlet,
  SlotRegistry,
  SlotsProvider,
  ThemeService,
} from '../src/index.js'

// Roots here render without a flush, and a slot change commits on a later scheduler task. That takes a
// few milliseconds, but a loaded runner has taken longer than the fixed sleeps these checks used
// before. Wait for the rendered state instead.
const committed = { timeout: 5_000 }

const containers: { root: Root; el: HTMLElement }[] = []

function mount(node: ReactNode): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  root.render(node)
  containers.push({ root, el })
  return el
}

afterEach(() => {
  for (const { root, el } of containers) {
    root.unmount()
    el.remove()
  }
  containers.length = 0
})

async function makeRegistry(
  client = { sessions: { get: () => undefined } } as never,
  serviceCaller?: ConstructorParameters<typeof AgnesClientService>[2],
) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  new AgnesClientService(ctx, client, serviceCaller)
  new CommandService(ctx, async () => true)
  const session = new SessionService(ctx, undefined, client)
  new ClientResourceService(ctx, client, session)
  new ThemeService(ctx, 'light')
  new LocaleService(ctx, 'zh-CN')
  const registry = (ctx as unknown as ClientContext).slots as SlotRegistry
  return { ctx, registry }
}

describe('SlotRegistry', () => {
  it('注册返回撤销函数，撤销后条目消失并通知订阅者', async () => {
    const { registry } = await makeRegistry()
    let notified = 0
    registry.subscribe(() => {
      notified += 1
    })
    const Comp = () => null
    const off = registry.register('workbench.panel', Comp)
    expect(registry.entries('workbench.panel')).toHaveLength(1)
    off()
    expect(registry.entries('workbench.panel')).toHaveLength(0)
    expect(notified).toBe(2)
  })

  it('未知槽位名抛错（fail-closed）', async () => {
    const { registry } = await makeRegistry()
    const Comp = () => null
    expect(() => registry.register('not.a.slot' as never, Comp)).toThrow('unknown slot')
  })

  it('order 小者在前', async () => {
    const { registry } = await makeRegistry()
    const A = () => null
    const B = () => null
    registry.register('workbench.panel', A)
    registry.register('workbench.panel', B, { order: -1 })
    expect(registry.entries('workbench.panel').map((entry) => entry.component)).toEqual([B, A])
  })

  it('register 的内部 owner 选项落在条目上（缺省为 undefined）', async () => {
    const { registry } = await makeRegistry()
    registry.register('workbench.panel', () => null, { owner: 'pkg-host' })
    registry.register('workbench.panel', () => null)
    expect(registry.entries('workbench.panel').map((entry) => entry.owner)).toEqual(['pkg-host', undefined])
  })

  it('按 owner 返回实际注册槽位，而非 manifest 声明', async () => {
    const { registry } = await makeRegistry()
    registry.register('workbench.panel', () => null, { owner: 'pkg-a' })
    registry.register('workbench.panel', () => null, { owner: 'pkg-b', order: 1 })
    expect(registry.entriesByOwner('pkg-a').map((entry) => entry.name)).toEqual(['workbench.panel'])
    expect(registry.entriesByOwner('missing')).toEqual([])
  })
})

describe('clientModule fiber 绑定', () => {
  it('插件 fiber 卸载时注册自动撤销', async () => {
    const { ctx, registry } = await makeRegistry()
    const mod = {
      async apply(cctx: ClientContext) {
        function Panel() {
          return null
        }
        cctx.slots.register('workbench.panel', Panel)
      },
    }
    const fiber = ctx.plugin(clientModule(mod), { packageId: 'p', revision: 'r1' })
    await fiber
    expect(registry.entries('workbench.panel')).toHaveLength(1)
    await fiber.dispose()
    expect(registry.entries('workbench.panel')).toHaveLength(0)
  })

  it('缺 slots 服务时包装层报错', () => {
    const ctx = new Context()
    const mod = { apply() {} }
    expect(() =>
      (clientModule(mod) as { apply: (ctx: unknown, config: unknown) => void }).apply(ctx, {
        packageId: 'p',
        revision: 'r',
      }),
    ).toThrow('slots')
  })

  it('门面把插件 config 的 packageId 注入为注册项 owner（WC9 认领真源）', async () => {
    const { ctx, registry } = await makeRegistry()
    const mod = {
      apply(cctx: ClientContext) {
        cctx.slots.register('workbench.panel', () => null)
      },
    }
    const fiber = ctx.plugin(clientModule(mod), { packageId: 'pkg-a', revision: 'r1' })
    await fiber
    expect(registry.entries('workbench.panel')[0]?.owner).toBe('pkg-a')
    await fiber.dispose()
  })

  it('向插件注入以宿主 SDK 为原型、但带模块私有服务门面的 ctx.agnes', async () => {
    const client = { sessions: { get: () => undefined } } as never
    const { ctx } = await makeRegistry(client)
    let received: unknown
    const fiber = ctx.plugin(
      clientModule({
        apply(cctx: ClientContext) {
          received = cctx.agnes
        },
      }),
      { packageId: 'pkg-sdk', revision: 'r1' },
    )
    await fiber
    expect(Object.getPrototypeOf(received as object)).toBe(client)
    expect(received).toHaveProperty('services.call')
    await fiber.dispose()
  })

  it('only relays a module-declared service with the active host session', async () => {
    const handle = {
      id: 'session-a',
      listeners: new Set<(...args: never[]) => void>(),
      projectUI: async () => ({}),
      prompt: async () => undefined,
      steer: async () => undefined,
      followUp: async () => undefined,
      compact: async () => undefined,
      cancel: async () => undefined,
    }
    const caller = vi.fn(async () => ({ answer: 42 }))
    const { ctx } = await makeRegistry(
      { sessions: { get: (id: string) => (id === 'session-a' ? handle : undefined) } } as never,
      caller,
    )
    const session = (ctx as unknown as { session: SessionService }).session
    session.setSession('session-a')
    let service: ClientContext['agnes']['services'] | undefined
    const fiber = ctx.plugin(
      clientModule({
        apply(cctx: ClientContext) {
          service = cctx.agnes.services
        },
      }),
      { packageId: 'acme/panel', rowId: 'web:acme/panel', revision: 'r1', services: ['panel.search'] },
    )
    await fiber
    await expect(service?.call('panel.search', { text: 'hello' })).resolves.toEqual({ answer: 42 })
    expect(caller).toHaveBeenCalledWith(
      expect.objectContaining({
        packageId: 'acme/panel',
        rowId: 'web:acme/panel',
        services: ['panel.search'],
      }),
      'session-a',
      'panel.search',
      { text: 'hello' },
    )
    await expect(service?.call('other.read', {})).rejects.toThrow('unavailable')
    await fiber.dispose()
  })

  it('fails closed before a current session exists', async () => {
    const caller = vi.fn()
    const { ctx } = await makeRegistry(undefined, caller)
    let service: ClientContext['agnes']['services'] | undefined
    const fiber = ctx.plugin(
      clientModule({
        apply(cctx: ClientContext) {
          service = cctx.agnes.services
        },
      }),
      { packageId: 'acme/panel', revision: 'r1', services: ['panel.search'] },
    )
    await fiber
    await expect(service?.call('panel.search', {})).rejects.toThrow('active session')
    expect(caller).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it('向插件注入同一会话、主题与语言服务，并在卸载时撤销会话绑定', async () => {
    const { ctx } = await makeRegistry()
    let received: Pick<ClientContext, 'session' | 'theme' | 'locale'> | undefined
    const fiber = ctx.plugin(
      clientModule({
        apply(cctx: ClientContext) {
          received = { session: cctx.session, theme: cctx.theme, locale: cctx.locale }
        },
      }),
      { packageId: 'pkg-host-services', revision: 'r1' },
    )
    await fiber
    expect(received?.session).toBeInstanceOf(SessionService)
    expect(received?.theme).toBeInstanceOf(ThemeService)
    expect(received?.locale).toBeInstanceOf(LocaleService)
    await fiber.dispose()
  })
})

describe('ClientResourceService', () => {
  it('只通过当前会话授权读取图片，并提供可回收的 Blob URL', async () => {
    const ctx = new Context()
    const session = new SessionService(ctx, 'session-a')
    const artifact = { sha256: 'a'.repeat(64), size: 3, mime: 'image/png' as const }
    const call = vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      artifact,
      acceptRanges: 'bytes' as const,
      contentLength: 3,
      etag: `"${artifact.sha256}"`,
      base64: 'AQID',
    }))
    const service = new ClientResourceService(ctx, { call } as never, session)
    const createObjectUrl = vi.spyOn(globalThis.URL, 'createObjectURL').mockReturnValue('blob:test-image')
    const revokeObjectUrl = vi.spyOn(globalThis.URL, 'revokeObjectURL').mockImplementation(() => undefined)

    const image = await service.images.load({ laneId: 'lane-a', artifact })

    expect(call).toHaveBeenCalledWith('_agnes/v1/artifact.read', {
      sessionId: 'session-a',
      laneId: 'lane-a',
      artifact,
    })
    expect(image.url).toBe('blob:test-image')
    image.release()
    image.release()
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1)
    await service.images.load({ laneId: 'lane-a', artifact })
    await ctx.fiber.dispose()
    expect(revokeObjectUrl).toHaveBeenCalledTimes(2)
    createObjectUrl.mockRestore()
    revokeObjectUrl.mockRestore()
  })

  it('拒绝外部 URL 和不支持的图片类型', async () => {
    const ctx = new Context()
    const session = new SessionService(ctx, 'session-a')
    const call = vi.fn()
    const service = new ClientResourceService(ctx, { call } as never, session)

    await expect(
      service.images.load({ laneId: 'lane-a', artifact: { url: 'https://example.test/a.png' } } as never),
    ).rejects.toThrow('image resource reference is invalid')
    await expect(
      service.images.load({
        laneId: 'lane-a',
        artifact: { sha256: 'a'.repeat(64), size: 3, mime: 'image/gif' },
      } as never),
    ).rejects.toThrow('image resource reference is invalid')
    expect(call).not.toHaveBeenCalled()
  })

  it('通过同一会话授权读取文本文档，并把字节解码为预览内容', async () => {
    const ctx = new Context()
    const session = new SessionService(ctx, 'session-a')
    const artifact = { sha256: 'b'.repeat(64), size: 2, mime: 'text/plain' }
    const call = vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      artifact,
      acceptRanges: 'bytes' as const,
      contentLength: 2,
      etag: `"${artifact.sha256}"`,
      base64: 'SGk=',
    }))
    const service = new ClientResourceService(ctx, { call } as never, session)

    const document = await service.documents.load({ laneId: 'lane-a', kind: 'text', artifact })

    expect(document.content).toBe('Hi')
    expect(document.url).toBeUndefined()
    expect(call).toHaveBeenCalledWith('_agnes/v1/artifact.read', {
      sessionId: 'session-a',
      laneId: 'lane-a',
      artifact,
    })
    document.release()
  })

  it('为 PDF 创建可回收对象 URL，并拒绝不匹配的文档 MIME', async () => {
    const ctx = new Context()
    const session = new SessionService(ctx, 'session-a')
    const artifact = { sha256: 'c'.repeat(64), size: 4, mime: 'application/pdf' }
    const call = vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      artifact,
      acceptRanges: 'bytes' as const,
      contentLength: 4,
      etag: `"${artifact.sha256}"`,
      base64: 'JVBERg==',
    }))
    const service = new ClientResourceService(ctx, { call } as never, session)
    const createObjectUrl = vi.spyOn(globalThis.URL, 'createObjectURL').mockReturnValue('blob:test-pdf')
    const revokeObjectUrl = vi.spyOn(globalThis.URL, 'revokeObjectURL').mockImplementation(() => undefined)

    const document = await service.documents.load({ laneId: 'lane-a', kind: 'pdf', artifact })

    expect(document.url).toBe('blob:test-pdf')
    document.release()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:test-pdf')
    await expect(
      service.documents.load({
        laneId: 'lane-a',
        kind: 'pdf',
        artifact: { ...artifact, mime: 'text/plain' },
      }),
    ).rejects.toThrow('document resource reference is invalid')
    createObjectUrl.mockRestore()
    revokeObjectUrl.mockRestore()
  })

  it('对按保留策略清理的截图抛出可识别错误，其余失败不变', async () => {
    const ctx = new Context()
    const session = new SessionService(ctx, 'session-a')
    const artifact = { sha256: 'd'.repeat(64), size: 4, mime: 'image/png' }
    const call = vi.fn(async () => ({ ok: false as const, status: 410 as const, code: 'artifact_reclaimed' }))
    const service = new ClientResourceService(ctx, { call } as never, session)
    await expect(
      service.documents.load({ laneId: 'lane-a', kind: 'image', artifact }),
    ).rejects.toBeInstanceOf(ClientResourceReclaimedError)
    call.mockResolvedValueOnce({ ok: false, status: 500, code: 'artifact_unavailable' } as never)
    const other = service.documents.load({ laneId: 'lane-a', kind: 'image', artifact })
    await expect(other).rejects.toThrow('document resource is unavailable: artifact_unavailable')
    await expect(other).rejects.not.toBeInstanceOf(ClientResourceReclaimedError)
  })
})

describe('SessionService plugin boundary', () => {
  it('binds projection and commands to the current host session only', async () => {
    const ctx = new Context()
    const changed = vi.fn()
    const handle = {
      id: 'session-a',
      listeners: new Set<(...args: never[]) => void>(),
      projectUI: vi.fn(async () => ({ status: 'ready' })),
      prompt: vi.fn(async () => 'prompted'),
      steer: vi.fn(async () => 'steered'),
      followUp: vi.fn(async () => 'followed'),
      compact: vi.fn(async () => 'compacted'),
      cancel: vi.fn(async () => undefined),
    }
    const service = new SessionService(ctx, 'session-a', {
      sessions: { get: (id: string) => (id === 'session-a' ? handle : undefined) },
    } as never)
    const stop = service.projection.subscribe(changed)
    await expect(service.projection.read()).resolves.toMatchObject({
      status: 'available',
      value: { status: 'ready' },
    })
    await expect(service.commands.prompt({ text: 'hello' })).resolves.toBe('prompted')
    expect(handle.prompt).toHaveBeenCalledWith({ text: 'hello' })
    handle.listeners.forEach((listener) => {
      listener()
    })
    expect(changed).toHaveBeenCalledTimes(1)
    service.setSession(undefined)
    await expect(service.projection.read()).resolves.toMatchObject({ status: 'unavailable' })
    expect(() => service.commands.cancel()).toThrow('session unavailable')
    stop()
  })

  it('drops the old session handle before service, projection, and command calls use the new session', async () => {
    const makeHandle = (id: string) => ({
      id,
      listeners: new Set<(...args: never[]) => void>(),
      projectUI: vi.fn(async () => ({ session: id })),
      prompt: vi.fn(async () => id),
      steer: vi.fn(async () => id),
      followUp: vi.fn(async () => id),
      compact: vi.fn(async () => id),
      cancel: vi.fn(async () => undefined),
    })
    const first = makeHandle('session-a')
    const second = makeHandle('session-b')
    const caller = vi.fn(async () => ({ ok: true }))
    const { ctx } = await makeRegistry(
      {
        sessions: {
          get: (id: string) => (id === 'session-a' ? first : id === 'session-b' ? second : undefined),
        },
      } as never,
      caller,
    )
    const session = (ctx as unknown as { session: SessionService }).session
    session.setSession('session-a')
    let services: ClientContext['agnes']['services'] | undefined
    const fiber = ctx.plugin(
      clientModule({
        apply(plugin) {
          services = plugin.agnes.services
        },
      }),
      { packageId: 'acme/panel', rowId: 'web:acme/panel', revision: 'r1', services: ['panel.query'] },
    )
    await fiber
    const changed = vi.fn()
    const stop = session.projection.subscribe(changed)

    await services?.call('panel.query', {})
    expect(caller).toHaveBeenLastCalledWith(expect.anything(), 'session-a', 'panel.query', {})
    first.listeners.forEach((listener) => {
      listener()
    })
    expect(changed).toHaveBeenCalledTimes(1)

    session.setSession('session-b')
    first.listeners.forEach((listener) => {
      listener()
    })
    expect(changed).toHaveBeenCalledTimes(2)
    await services?.call('panel.query', {})
    expect(caller).toHaveBeenLastCalledWith(expect.anything(), 'session-b', 'panel.query', {})
    await expect(session.projection.read()).resolves.toMatchObject({ value: { session: 'session-b' } })
    await expect(session.commands.prompt({ text: 'new session only' })).resolves.toBe('session-b')
    expect(first.prompt).not.toHaveBeenCalled()
    expect(second.prompt).toHaveBeenCalledWith({ text: 'new session only' })
    second.listeners.forEach((listener) => {
      listener()
    })
    expect(changed).toHaveBeenCalledTimes(3)

    stop()
    await fiber.dispose()
  })
})

describe('client command boundary', () => {
  it('binds registrations to the module fiber and asks the host policy at execution time', async () => {
    const { ctx } = await makeRegistry()
    const commands = (ctx as unknown as { commands: CommandService }).commands
    const run = vi.fn(async (input: unknown) => input)
    const fiber = ctx.plugin(
      clientModule({
        apply(cctx: ClientContext) {
          cctx.commands.register({ id: 'demo.run', title: 'Run demo', execute: run })
        },
      }),
      { packageId: 'pkg-demo', revision: 'r1' },
    )
    await fiber
    expect(commands.list()).toEqual([{ id: 'demo.run', owner: 'pkg-demo', title: 'Run demo' }])
    await expect(commands.execute('demo.run', { ok: true })).resolves.toEqual({ ok: true })
    expect(run).toHaveBeenCalledWith({ ok: true })
    await fiber.dispose()
    await expect(commands.execute('demo.run', {})).rejects.toThrow('not registered')
  })

  it('fails closed when the host does not authorize an execution', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry)
    const client = { sessions: { get: () => undefined } } as never
    new AgnesClientService(ctx, client)
    const commands = new CommandService(ctx)
    new SessionService(ctx, undefined, client)
    new ThemeService(ctx, 'light')
    new LocaleService(ctx, 'zh-CN')
    const fiber = ctx.plugin(
      clientModule({
        apply(cctx: ClientContext) {
          cctx.commands.register({ id: 'demo.deny', execute() {} })
        },
      }),
      { packageId: 'pkg-demo', revision: 'r1' },
    )
    await fiber
    await expect(commands.execute('demo.deny', {})).rejects.toThrow('not authorized')
    await fiber.dispose()
  })

  it('routes an authorized effect through the current session and isolates command ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry)
    const client = { sessions: { get: () => undefined } } as never
    const effect = vi.fn(async (...args: unknown[]) => ({ args }))
    new AgnesClientService(ctx, client, undefined, effect)
    const commands = new CommandService(ctx, async () => true)
    new SessionService(ctx, 'session-a', client)
    new ThemeService(ctx, 'light')
    new LocaleService(ctx, 'zh-CN')
    let first: ClientContext['commands'] | undefined
    const fiber = ctx.plugin(
      clientModule({
        apply(cctx: ClientContext) {
          first = cctx.commands
          cctx.commands.registerEffect({ id: 'demo.write', service: 'panel.write' })
        },
      }),
      {
        rowId: 'web:pkg-demo/panel',
        packageId: 'pkg-demo',
        revision: 'r1',
        services: ['panel.write'],
      },
    )
    await fiber
    await expect(first?.execute('demo.write', { value: 1 })).resolves.toBeDefined()
    expect(effect).toHaveBeenCalledWith(
      expect.objectContaining({ rowId: 'web:pkg-demo/panel' }),
      'session-a',
      'panel.write',
      expect.any(String),
      { value: 1 },
    )
    await expect(commands.executeOwned('web:other/panel', 'demo.write', {})).rejects.toThrow('not registered')
    await fiber.dispose()
    await expect(commands.execute('demo.write', {})).rejects.toThrow('not registered')
  })

  it('never reaches the effect relay when host authorization is denied', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry)
    const client = { sessions: { get: () => undefined } } as never
    const effect = vi.fn()
    new AgnesClientService(ctx, client, undefined, effect)
    const commands = new CommandService(ctx)
    new SessionService(ctx, 'session-a', client)
    new ThemeService(ctx, 'light')
    new LocaleService(ctx, 'zh-CN')
    const fiber = ctx.plugin(
      clientModule({
        apply(cctx: ClientContext) {
          cctx.commands.registerEffect({ id: 'demo.denied-effect', service: 'panel.write' })
        },
      }),
      { packageId: 'pkg-demo', revision: 'r1', services: ['panel.write'] },
    )
    await fiber
    await expect(commands.execute('demo.denied-effect', {})).rejects.toThrow('not authorized')
    expect(effect).not.toHaveBeenCalled()
    await fiber.dispose()
  })
})

describe('SlotOutlet', () => {
  it('passes DSH scope arguments, store actions, locale, and matched values to entries', async () => {
    const { ctx, registry } = await makeRegistry()
    registry.declare('conversation.input.left', { kind: 'list', scope: 'session' })
    const session = (ctx as unknown as { session: SessionService }).session
    session.setSession('session-a')
    const createStore = vi.fn((scopeKey?: string) => {
      const listeners = new Set<() => void>()
      const snapshot = { scopeKey }
      return {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        actions: { scopeKey },
        destroy: vi.fn(),
      }
    })
    const injected = vi.fn((sessionId: string, actions: { scopeKey?: string }) => ({
      injectedSessionId: sessionId,
      injectedScope: actions.scopeKey,
    }))
    let received: Record<string, unknown> | undefined
    const Panel = (props: DshSlotProps) => {
      received = props as Record<string, unknown>
      return createElement(
        'div',
        { 'data-dsh-contract': '1' },
        String((props as DshSlotProps & { injectedScope?: string }).injectedScope),
      )
    }
    const fiber = ctx.plugin(
      clientModule({
        apply(cctx: ClientContext) {
          cctx.slots.register('conversation.input.left', Panel, {
            id: 'contract',
            store: { create: createStore },
            inject: injected,
          })
        },
      }),
      {
        packageId: 'pkg-dsh-contract',
        revision: 'r1',
        allowedSlots: ['conversation.input.left'],
        slotCatalogVersion: DSH_SLOT_CATALOG_VERSION,
      },
    )
    await fiber
    const el = mount(
      createElement(
        SlotsProvider,
        { registry },
        createElement(SlotOutlet, { name: 'conversation.input.left', props: { value: 'owner' } }),
      ),
    )
    await vi.waitFor(() => {
      expect(createStore).toHaveBeenCalledWith('session-a')
      expect(injected).toHaveBeenCalledWith('session-a', { scopeKey: 'session-a' })
      expect(received).toMatchObject({
        value: 'owner',
        sessionId: 'session-a',
        injectedSessionId: 'session-a',
        injectedScope: 'session-a',
      })
      expect(received?.actions).toEqual({ scopeKey: 'session-a' })
      expect(typeof received?.t).toBe('function')
      expect(el.textContent).toContain('session-a')
    }, committed)

    session.setSession('session-b')
    await vi.waitFor(() => {
      expect(createStore).toHaveBeenLastCalledWith('session-b')
      expect(injected).toHaveBeenLastCalledWith('session-b', { scopeKey: 'session-b' })
      expect(el.textContent).toContain('session-b')
    }, committed)

    await fiber.dispose()
    expect(registry.entries('conversation.input.left')).toHaveLength(0)
  })

  it('passes undefined actions to an empty session-maybe seat and remints them on session attach', async () => {
    const { registry } = await makeRegistry()
    registry.declare('conversation.input.attachments', { kind: 'single', scope: 'session-maybe' })
    const injected = vi.fn((sessionId: string | undefined, actions: { ready: boolean } | undefined) => ({
      state: sessionId ?? `empty:${actions === undefined ? 'no-actions' : 'actions'}`,
    }))
    const createStore = vi.fn((scopeKey?: string) => {
      const snapshot = { scopeKey }
      return {
        getSnapshot: () => snapshot,
        subscribe: () => () => undefined,
        actions: { ready: true },
        destroy: vi.fn(),
      }
    })
    registry.register(
      'conversation.input.attachments',
      (props: DshSlotProps) => createElement('span', {}, (props as DshSlotProps & { state?: string }).state),
      {
        store: { create: createStore },
        inject: injected,
      },
    )
    const el = mount(
      createElement(
        SlotsProvider,
        { registry },
        createElement(SlotOutlet, { name: 'conversation.input.attachments' }),
      ),
    )
    await vi.waitFor(() => {
      expect(injected).toHaveBeenLastCalledWith(undefined, undefined)
      expect(el.textContent).toContain('empty:no-actions')
    }, committed)

    registry.setSession('session-a')
    await vi.waitFor(() => {
      expect(injected).toHaveBeenLastCalledWith('session-a', { ready: true })
      expect(createStore).toHaveBeenLastCalledWith('session-a')
      expect(el.textContent).toContain('session-a')
    }, committed)
  })

  it('keeps a session-maybe component mounted across empty to first session, then remounts between sessions', async () => {
    const { registry } = await makeRegistry()
    registry.declare('session-maybe-fixture', { kind: 'single', scope: 'session-maybe' })
    let mounted = 0
    let unmounted = 0
    const fixtureRef = (node: HTMLDivElement | null) => {
      if (node) mounted += 1
      else unmounted += 1
    }
    function Fixture() {
      return createElement(
        'div',
        {
          'data-session-maybe': 'fixture',
          ref: fixtureRef,
        },
        'fixture',
      )
    }
    registry.register('session-maybe-fixture' as never, Fixture as never)
    const el = mount(
      createElement(
        SlotsProvider,
        { registry },
        createElement(SlotOutlet, { name: 'session-maybe-fixture' as never }),
      ),
    )
    await vi.waitFor(() => {
      expect(el.querySelector('[data-session-maybe="fixture"]')).toBeTruthy()
      expect(mounted).toBe(1)
    }, committed)

    registry.setSession('session-a')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mounted).toBe(1)
    expect(unmounted).toBe(0)

    registry.setSession('session-b')
    await vi.waitFor(() => {
      expect(mounted).toBe(2)
      expect(unmounted).toBe(1)
    }, committed)

    registry.setSession(undefined)
    await vi.waitFor(() => {
      expect(mounted).toBe(3)
      expect(unmounted).toBe(2)
    }, committed)
  })

  it('renders only the selected business key for a keyed slot', async () => {
    const { registry } = await makeRegistry()
    registry.declare('keyed-fixture', { kind: 'keyed', scope: 'root' })
    registry.register({ name: 'keyed-fixture', key: 'a' }, () => createElement('div', {}, 'A'))
    registry.register({ name: 'keyed-fixture', key: 'b' }, () => createElement('div', {}, 'B'))
    const el = mount(
      createElement(
        SlotsProvider,
        { registry },
        createElement(SlotOutlet, { name: 'keyed-fixture' as never, entryKey: 'b' }),
      ),
    )
    await vi.waitFor(() => {
      expect(el.textContent).toContain('B')
      expect(el.textContent).not.toContain('A')
    }, committed)
  })

  it('空槽位渲染占位，注册后原地变卡片', async () => {
    const { ctx, registry } = await makeRegistry()
    const mod = {
      async apply(cctx: ClientContext) {
        cctx.slots.register('workbench.panel', () => createElement('div', {}, 'hello-card'))
      },
    }
    const el = mount(
      createElement(SlotsProvider, { registry }, createElement(SlotOutlet, { name: 'workbench.panel' })),
    )
    await vi.waitFor(() => {
      expect(el.textContent).toContain('此槽位的插件未就绪')
    }, committed)
    ctx.plugin(clientModule(mod), { packageId: 'p', revision: 'r1' })
    await vi.waitFor(() => {
      expect(el.textContent).toContain('hello-card')
      expect(el.textContent).not.toContain('此槽位的插件未就绪')
      expect(el.querySelector('[data-slot="workbench.panel"]')).toBeTruthy()
    }, committed)
  })

  it('宿主可隐藏空面板，注册后仍原地显示插件', async () => {
    const { registry } = await makeRegistry()
    const el = mount(
      createElement(
        SlotsProvider,
        { registry },
        createElement(SlotOutlet, { name: 'workbench.panel', hideWhenEmpty: true }),
      ),
    )
    await vi.waitFor(() => {
      const empty = el.querySelector('[data-slot="workbench.panel"]')
      expect(empty?.hasAttribute('hidden')).toBe(true)
      expect(el.textContent).not.toContain('此槽位的插件未就绪')
    }, committed)

    registry.register('workbench.panel', () => createElement('div', {}, 'ready-panel'))
    await vi.waitFor(() => {
      const ready = el.querySelector('[data-slot="workbench.panel"]')
      expect(ready?.hasAttribute('hidden')).toBe(false)
      expect(el.textContent).toContain('ready-panel')
    }, committed)
  })

  it('插件停用后回到 tool.card.inline 的现有占位路径', async () => {
    const { registry } = await makeRegistry()
    const el = mount(
      createElement(SlotsProvider, { registry }, createElement(SlotOutlet, { name: 'tool.card.inline' })),
    )
    let host: Element | null = null
    await vi.waitFor(() => {
      host = el.querySelector('[data-slot="tool.card.inline"]')
      expect(host?.textContent).toContain('此槽位的插件未就绪')
    }, committed)

    const off = registry.register('tool.card.inline', () => createElement('div', {}, 'inline-card'))
    await vi.waitFor(() => {
      expect(el.textContent).toContain('inline-card')
      expect(el.querySelector('[data-slot="tool.card.inline"]')).toBe(host)
    }, committed)

    off()
    await vi.waitFor(() => {
      expect(el.textContent).toContain('此槽位的插件未就绪')
      expect(el.querySelector('[data-slot="tool.card.inline"]')).toBe(host)
    }, committed)
  })

  it('单插件渲染失败被边界隔离（G6）', async () => {
    const { registry } = await makeRegistry()
    const errSpy: unknown[] = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      errSpy.push(args)
    })
    const secret = 'fixture-secret-must-not-reach-browser-log'
    const Bad = (): never => {
      throw new Error(secret)
    }
    const Good = () => createElement('div', {}, 'good')
    registry.register('workbench.panel', Bad as never)
    registry.register('workbench.panel', Good as never)
    const el = mount(
      createElement(SlotsProvider, { registry }, createElement(SlotOutlet, { name: 'workbench.panel' })),
    )
    await vi.waitFor(() => {
      expect(el.textContent).toContain('插件渲染失败')
      expect(el.textContent).toContain('good')
      expect(el.querySelector('[data-slot="workbench.panel"]')).toBeTruthy()
      expect(errSpy.length).toBeGreaterThan(0)
      expect(errSpy.flat().some((item) => item === secret || item instanceof Error)).toBe(false)
    }, committed)
    vi.restoreAllMocks()
  })
})
