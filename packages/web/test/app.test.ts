/** @vitest-environment happy-dom */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ConfigSnapshot, UIOpeningResult, UIProjectionUpdate, UITimeline } from '@agnes/protocol'
import { MAX_FRAME_BYTES } from '@agnes/protocol'
import type { LedgerEvent } from '@agnes/sdk/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  createClient: vi.fn(),
  memoryJournal: vi.fn(() => ({})),
}))
const configurationCallback = vi.hoisted(() => ({
  saved: undefined as ((snapshot: ConfigSnapshot) => Promise<void>) | undefined,
}))
const traceBridge = vi.hoisted(() => ({
  options: undefined as unknown,
  transcriptOptions: undefined as unknown,
  claim: undefined as unknown,
  metas: [] as unknown[],
}))
vi.mock('../src/client-modules/boot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client-modules/boot.js')>()
  return {
    ...actual,
    startClientModules: async (options: Parameters<typeof actual.startClientModules>[0]) => {
      traceBridge.options = options.trace
      traceBridge.transcriptOptions = options.transcript
      traceBridge.claim = options.claim
      const runtime = await actual.startClientModules(options)
      if (runtime.trace) {
        const render = runtime.trace.render.bind(runtime.trace)
        runtime.trace.render = (nodes, turns, meta) => {
          traceBridge.metas.push(meta)
          render(nodes, turns, meta)
        }
      }
      return runtime
    },
  }
})
vi.mock('../src/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/settings.js')>()
  return {
    ...actual,
    createSettingsController: (options: Parameters<typeof actual.createSettingsController>[0]) => {
      configurationCallback.saved = options.onSaved
      return actual.createSettingsController(options)
    },
  }
})

const binding = vi.hoisted(() => ({
  bindWebSession: vi.fn(),
  loadWebSession: vi.fn(),
}))
const timelineRenderer = vi.hoisted(() => ({
  createTimelineRenderer: vi.fn(() => ({
    render: vi.fn(),
    reset: vi.fn(),
    pinToBottom: vi.fn(),
  })),
  nearBottom: vi.fn(() => true),
}))
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

vi.mock('@agnes/sdk/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agnes/sdk/browser')>()),
  // The live projection reads the connection state and keeps the disposers `on` returns.
  createClient: (...args: unknown[]) => {
    const client = sdk.createClient(...args)
    if (client && !('connectionState' in client)) client.connectionState = 'connected'
    if (vi.isMockFunction(client?.on) && !client.on.getMockImplementation())
      client.on.mockImplementation(() => () => undefined)
    return client
  },
  memoryJournal: sdk.memoryJournal,
}))

// i18n: the workbench defaults to English; these tests assert the zh-CN catalog,
// so the locale preference is pinned before each app start.
beforeEach(() => {
  localStorage.setItem('agnes-locale', 'zh-CN')
})
vi.mock('../src/session-binding.js', () => ({
  bindWebSession: binding.bindWebSession,
  loadWebSession: binding.loadWebSession,
}))
vi.mock('../src/timeline.js', () => ({
  createTimelineRenderer: timelineRenderer.createTimelineRenderer,
  nearBottom: timelineRenderer.nearBottom,
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

type SessionDouble = {
  id: string
  cancel: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  events: ReturnType<typeof vi.fn>
  followUp: ReturnType<typeof vi.fn>
  sendNow: ReturnType<typeof vi.fn>
  removeQueued: ReturnType<typeof vi.fn>
  onPermissionRequest: ReturnType<typeof vi.fn>
  onPreview: ReturnType<typeof vi.fn>
  projectUI: ReturnType<typeof vi.fn>
  projectUIOpening: ReturnType<typeof vi.fn<() => Promise<UIOpeningResult>>>
  projectUIPatch: ReturnType<typeof vi.fn<(after: number) => Promise<UIProjectionUpdate>>>
  projectUIHistory: ReturnType<typeof vi.fn>
  readToolDetail: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  setModel: ReturnType<typeof vi.fn>
  setYolo: ReturnType<typeof vi.fn>
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function idleTimeline(sessionId: string, model?: { route: string; id: string }): UITimeline {
  return {
    sessionId,
    upto: 0,
    generation: 1,
    opState: null,
    yolo: false,
    nodes: [],
    turns: [],
    ...(model
      ? {
          usage: {
            totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            reasoningComplete: false,
            billingComplete: false,
            context: { tokens: 0, window: 128_000, autoCompact: true, source: 'estimated' as const },
            model: { ...model, thinking: 'off' as const },
          },
        }
      : {}),
  }
}

function busyTimeline(sessionId: string, model?: { route: string; id: string }): UITimeline {
  return {
    ...idleTimeline(sessionId, model),
    sessionId,
    upto: 1,
    generation: 1,
    opState: { turn: 1, step: 1, phase: 'inference' },
    yolo: false,
    nodes: [],
    turns: [],
  }
}

/**
 * The Web reads a bounded opening and then patches. The doubles serve both from one full-timeline
 * function: a patch upserts every node and turn of the latest timeline, which the windowed merge
 * accepts whatever changed.
 */
function session(id: string, projectUI: () => Promise<UITimeline>): SessionDouble {
  const opening = vi.fn<() => Promise<UIOpeningResult>>(async () => {
    const timeline = await projectUI()
    return { timeline, history: { hasEarlier: false, startIndex: 0, totalNodes: timeline.nodes.length } }
  })
  const patch = vi.fn(async (after: number) => {
    const timeline = await projectUI()
    return {
      kind: 'patch' as const,
      patch: {
        sessionId: timeline.sessionId,
        generation: timeline.generation,
        from: after,
        upto: Math.max(after, timeline.upto),
        totalNodes: timeline.nodes.length,
        opState: timeline.opState,
        ...(timeline.yolo === undefined ? {} : { yolo: timeline.yolo }),
        ...(timeline.pendingInputs === undefined ? {} : { pendingInputs: timeline.pendingInputs }),
        changes: timeline.nodes.map((node, index) => ({ op: 'upsert' as const, index, node })),
        turnChanges: timeline.turns.map((turn, index) => ({ op: 'upsert' as const, index, turn })),
        ...(timeline.usage ? { usage: timeline.usage } : {}),
      },
    }
  })
  return {
    projectUIOpening: opening,
    projectUIPatch: patch,
    projectUIHistory: vi.fn(async () => {
      throw new Error('no history in this double')
    }),
    id,
    cancel: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    events: vi.fn(() => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
        return: async () => ({ done: true, value: undefined }),
      }),
    })),
    followUp: vi.fn(async () => undefined),
    sendNow: vi.fn(async () => 1),
    removeQueued: vi.fn(async () => 1),
    onPermissionRequest: vi.fn(() => vi.fn()),
    onPreview: vi.fn(() => vi.fn()),
    projectUI: vi.fn(projectUI),
    readToolDetail: vi.fn(async () => ({
      call: { toolUseId: 'tool-1', name: 'read', args: { path: 'a' }, ordinal: 0 },
    })),
    prompt: vi.fn(async () => undefined),
    setModel: vi.fn(async () => ({ effectiveFromSeq: 1 })),
    setYolo: vi.fn(async () => ({ effectiveFromSeq: 1 })),
  }
}

const packageRoot = process.cwd().endsWith('/packages/web')
  ? process.cwd()
  : resolve(process.cwd(), 'packages/web')
const publicHtml = await readFile(resolve(packageRoot, 'public/index.html'), 'utf8')

function installPublicFixture(): void {
  // The entry point is imported directly below; removing only its production module tag keeps this
  // test rooted in the public DOM without attempting an HTTP fetch for /app.js.
  document.documentElement.innerHTML = publicHtml
    .replace(/<link rel="stylesheet" href="\/(?:style|antd|tokens)\.css" \/>/g, '')
    .replace(/<script type="module" src="\/app\.js"><\/script>/, '')
  if (!document.getElementById('new-session'))
    document.body.insertAdjacentHTML(
      'beforeend',
      `<dialog id="new-session"><form id="new-session-form"><input id="new-session-cwd" value="." /><button id="new-session-cancel" type="button">取消</button><button id="new-session-create" type="submit">创建任务</button></form></dialog>`,
    )
  history.replaceState(null, '', '/?session=old#test-launcher-token')
  sessionStorage.clear()
  localStorage.clear()
  localStorage.setItem('agnes-locale', 'zh-CN')
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ available: false }), { status: 200 })),
  )
}

function submit(text: string): void {
  const composer = document.getElementById('prompt') as HTMLTextAreaElement
  composer.value = text
  document.getElementById('composer')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

/** The model trigger opens the complete flat model list. */
function openModelList(): void {
  if (!document.querySelector('#model-listbox')) throw new Error('model picker did not open')
}

/** The model list is rendered directly in the picker. */
function modelMenu(): HTMLElement {
  const found = document.querySelector<HTMLElement>('#model-listbox')
  if (!found) throw new Error('model picker did not open')
  return found
}

/** 用真实校验器造一个错误实例：断言本地化时不必依赖 protocol-validation 的内部类。 */
function raisedBy(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('the invalid input was accepted')
}

afterEach(async () => {
  window.dispatchEvent(new Event('pagehide'))
  await Promise.resolve()
  vi.resetModules()
  vi.clearAllMocks()
  traceBridge.options = undefined
  traceBridge.transcriptOptions = undefined
  traceBridge.claim = undefined
  traceBridge.metas.length = 0
  vi.unstubAllGlobals()
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
  document.documentElement.replaceChildren()
  sessionStorage.clear()
  localStorage.clear()
})

describe('web permission synchronization', () => {
  const label = () => document.querySelector('[data-permission-label]')?.textContent
  const choose = (name: string) => {
    document.getElementById('composer-permission')?.click()
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (row) => row.querySelector('.permission-picker-label')?.textContent === name,
    )
    expect(option).toBeDefined()
    option?.click()
  }

  async function boot(yolo: boolean | undefined) {
    installPublicFixture()
    const timeline = idleTimeline('old')
    timeline.upto = 10
    if (yolo === undefined) delete timeline.yolo
    else timeline.yolo = yolo
    const old = session('old', async () => ({ ...timeline }))
    let receive: ((value: IteratorResult<LedgerEvent>) => void) | undefined
    const queued: LedgerEvent[] = []
    old.events.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<LedgerEvent>>((resolve) => {
            const event = queued.shift()
            if (event) resolve({ done: false, value: event })
            else receive = resolve
          }),
        return: async () => {
          receive?.({ done: true, value: undefined })
          receive = undefined
          queued.length = 0
          return { done: true, value: undefined }
        },
      }),
    }))
    const publish = (enabled: boolean) => {
      timeline.yolo = enabled
      timeline.upto++
      const next = receive
      receive = undefined
      const event: LedgerEvent = {
        seq: timeline.upto,
        ts: '2026-10-01T00:00:00.000Z',
        id: String(timeline.upto).padStart(26, '0'),
        type: 'x/core/yolo-switch',
        data: { to: enabled },
        actor: { id: 'test', org: '', role: 'user', deptPath: [], attrs: {} },
        origin: 'principal',
        trust: 'trusted',
        _meta: {
          promptTurnId: '',
          eventSequence: timeline.upto,
          generation: 1,
          lane: 'main',
          phase: 'event',
        },
      }
      if (next) next({ done: false, value: event })
      else queued.push(event)
      return timeline.upto
    }
    old.setYolo.mockImplementation(async (enabled: boolean) => ({ effectiveFromSeq: publish(enabled) }))
    const listeners = new Map<string, Set<() => void>>()
    const client = {
      connectionState: 'connected',
      initialize: vi.fn(async () => undefined),
      on: vi.fn((event: string, listener: () => void) => {
        const handlers = listeners.get(event) ?? new Set<() => void>()
        handlers.add(listener)
        listeners.set(event, handlers)
        return () => handlers.delete(listener)
      }),
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old' }] })), load: vi.fn(async () => old) },
    }
    sdk.createClient.mockReturnValue(client)
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await import('../src/app.js')
    await vi.waitFor(() =>
      expect((document.getElementById('composer-permission') as HTMLButtonElement).disabled).toBe(false),
    )
    const connect = (event: 'reconnecting' | 'reconnected') => {
      client.connectionState = event === 'reconnected' ? 'connected' : 'reconnecting'
      for (const listener of [...(listeners.get(event) ?? [])]) listener()
    }
    return { old, publish, timeline, connect }
  }

  it('restores full access on reopening, applies workspace selections, and follows remote patches', async () => {
    const { old, publish } = await boot(false)
    const staleReady = deferred<void>()
    const freshReady = deferred<void>()
    const projectPatch = old.projectUIPatch.getMockImplementation()
    if (!projectPatch) throw new Error('missing projection fixture')
    old.projectUIPatch
      .mockImplementationOnce(async (...args) => {
        const stale = await projectPatch(...args)
        await staleReady.promise
        return stale
      })
      .mockImplementationOnce(async (...args) => {
        await freshReady.promise
        return projectPatch(...args)
      })
    publish(false)
    await vi.waitFor(() => expect(old.projectUIPatch).toHaveBeenCalledTimes(1))
    choose('完全权限')
    await vi.waitFor(() => expect(label()).toBe('完全权限'))
    expect(old.setYolo).toHaveBeenLastCalledWith(true)
    staleReady.resolve()
    await vi.waitFor(() => expect(old.projectUIPatch).toHaveBeenCalledTimes(2))
    expect(label()).toBe('完全权限')
    freshReady.resolve()
    const opened = old.projectUIOpening.mock.calls.length
    document.querySelector<HTMLButtonElement>('[data-session="old"]')?.click()
    await vi.waitFor(() => expect(old.projectUIOpening.mock.calls.length).toBeGreaterThan(opened))
    await vi.waitFor(() => expect(label()).toBe('完全权限'))
    expect(old.setYolo.mock.calls.some(([enabled]) => enabled === false)).toBe(false)

    choose('工作区内修改')
    await vi.waitFor(() => expect(old.setYolo).toHaveBeenLastCalledWith(false))
    await vi.waitFor(() => expect(label()).toBe('工作区内修改'))
    const applied = old.setYolo.mock.calls.length
    choose('工作区内修改')
    await vi.waitFor(() => expect(old.setYolo.mock.calls.length).toBe(applied + 1))
    expect(old.setYolo).toHaveBeenLastCalledWith(false)

    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull())
    const calls = old.setYolo.mock.calls.length
    publish(true)
    await vi.waitFor(() => expect(label()).toBe('完全权限'))
    publish(false)
    await vi.waitFor(() => expect(label()).toBe('工作区内修改'))
    submit('use the remotely selected workspace permissions')
    await vi.waitFor(() => expect(old.prompt).toHaveBeenCalled())
    expect(old.setYolo).toHaveBeenCalledTimes(calls)
    expect(old.projectUIPatch).toHaveBeenCalled()
  }, 40_000)

  it.each([false, true])(
    'refreshes permission before sending after reconnect (previous full: %s)',
    async (before) => {
      const { old, timeline, connect } = await boot(before)
      const failed = deferred<void>()
      const ready = deferred<void>()
      const opening = old.projectUIOpening.getMockImplementation()
      if (!opening) throw new Error('missing opening fixture')
      old.projectUIOpening
        .mockImplementationOnce(async (...args) => {
          await failed.promise
          return opening(...args)
        })
        .mockImplementationOnce(async (...args) => {
          await ready.promise
          return opening(...args)
        })
      const opened = old.projectUIOpening.mock.calls.length
      connect('reconnecting')
      timeline.yolo = !before
      timeline.upto++
      connect('reconnected')
      await vi.waitFor(() => expect(old.projectUIOpening.mock.calls.length).toBeGreaterThan(opened))

      const pendingLabel = label()
      // An unrelated approval render must not restore the cached pre-disconnect projection.
      const permission = binding.loadWebSession.mock.calls.at(-1)?.[2]
      const abort = new AbortController()
      const approval = permission(
        {
          sessionId: 'old',
          toolCall: { toolCallId: 'reconnect-check', title: 'Reconnect check' },
          options: [],
        },
        { signal: abort.signal },
      )
      abort.abort()
      await approval
      const renderedLabel = label()
      submit('wait for the current permission')
      const submittedWhilePending = old.prompt.mock.calls.length
      failed.reject(new Error('reconnect opening unavailable'))
      await vi.waitFor(() => expect(old.projectUIOpening.mock.calls.length).toBeGreaterThan(opened + 1))
      const failedLabel = label()
      submit('wait after the opening failed')
      const submittedAfterFailure = old.prompt.mock.calls.length
      ready.resolve()
      await vi.waitFor(() => expect(label()).toBe(before ? '工作区内修改' : '完全权限'))
      old.prompt.mockClear()
      submit('use the current permission')
      await vi.waitFor(() =>
        expect(old.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'use the current permission' }], {
          titleLocale: 'zh-CN',
        }),
      )
      expect.soft(pendingLabel).toBe('请选择权限')
      expect.soft(renderedLabel).toBe('请选择权限')
      expect.soft(failedLabel).toBe('请选择权限')
      expect.soft(submittedWhilePending).toBe(0)
      expect.soft(submittedAfterFailure).toBe(0)
      expect(old.setYolo).not.toHaveBeenCalled()
    },
    40_000,
  )

  describe('live approval card', () => {
    const options = [
      { optionId: 'allow_once', name: 'allow_once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'allow_always', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'reject_once', kind: 'reject_once' },
    ]
    const card = (tool: string, kind: string, rawInput: unknown) => ({
      sessionId: 'old',
      toolCall: {
        toolCallId: `call-${tool}`,
        title: `${tool} summary`,
        kind,
        rawInput,
        _meta: { 'ai.agnes.harness': { tool } },
      },
      options,
    })
    const ask = async (request: ReturnType<typeof card>) => {
      await boot(false)
      const permission = binding.loadWebSession.mock.calls.at(-1)?.[2]
      const answer = permission(request, { signal: new AbortController().signal })
      const region = document.getElementById('approval') as HTMLElement
      await vi.waitFor(() => expect(region.querySelector('.approval-actions button')).toBeTruthy())
      const buttons = () => [...region.querySelectorAll<HTMLButtonElement>('.approval-actions button')]
      return { answer, region, buttons, preview: () => region.querySelector('pre')?.textContent ?? '' }
    }

    it('keeps the end of a long command on the card and says what the session choice covers', async () => {
      const command = `${'a'.repeat(2900)} && touch TAIL_UNSEEN`
      const { answer, region, buttons, preview } = await ask(card('shell', 'execute', { command }))
      expect(region.textContent).toContain('将在此任务的工作目录执行命令')
      expect(preview()).toContain('touch TAIL_UNSEEN')
      expect(region.querySelector('.approval-warning')).toBeNull()
      expect(buttons().map((b) => b.textContent)).toEqual([
        '仅允许这次',
        '本会话内允许所有 shell 调用',
        '拒绝',
      ])
      buttons()[0]?.click()
      await expect(answer).resolves.toEqual({ optionId: 'allow_once' })
    })

    it.each([
      ['write', 'edit', { content: 'body', path: 'src/a.ts' }, '将创建或覆盖文件 src/a.ts'],
      ['edit', 'edit', { edits: [], path: 'src/a.ts' }, '将修改文件 src/a.ts'],
      ['web_fetch', 'fetch', { url: 'https://example.com/x' }, '将访问网址 https://example.com/x'],
      ['read', 'read', { path: 'notes.md' }, '将读取 notes.md'],
      ['mcp__db__query', 'other', { sql: 'select 1' }, '请核对工具及参数后决定是否继续'],
    ])('%s says what it will do and puts its locating field first', async (tool, kind, input, text) => {
      const { region, preview } = await ask(card(tool, kind, input))
      expect(region.textContent).toContain(text)
      expect(region.textContent).not.toContain('执行命令')
      const first = Object.keys(JSON.parse(preview()))[0]
      expect(first).toBe(Object.keys(input).includes('path') ? 'path' : Object.keys(input)[0])
    })

    it('puts path before content in the preview although it arrived after it', async () => {
      const { preview } = await ask(card('write', 'edit', { content: 'body', path: 'src/a.ts' }))
      expect(preview().indexOf('"path"')).toBeGreaterThan(-1)
      expect(preview().indexOf('"path"')).toBeLessThan(preview().indexOf('"content"'))
    })

    it('does not offer the session grant when part of the call is not on the card, and says so', async () => {
      const command = `${'a'.repeat(40_000)}TAIL_UNSEEN`
      const { answer, region, buttons, preview } = await ask(card('shell', 'execute', { command }))
      const total = JSON.stringify({ command }, null, 2).length
      expect(preview()).toContain(`…[已显示 32768 / 共 ${total} 字符]`)
      expect(preview()).not.toContain('TAIL_UNSEEN')
      expect(region.querySelector('.approval-warning')?.textContent).toContain('内容未完整显示')
      expect(buttons().map((b) => b.textContent)).toEqual(['仅允许这次', '拒绝'])
      buttons()[1]?.click()
      await expect(answer).resolves.toEqual({ optionId: 'reject_once' })
    })
  })

  it('requires a confirmed selection when an older backend omits its permission state', async () => {
    const { old, timeline, connect } = await boot(undefined)
    expect(label()).toBe('请选择权限')
    submit('wait for permission')
    expect(old.prompt).not.toHaveBeenCalled()
    const applied = deferred<{ effectiveFromSeq: number }>()
    old.setYolo.mockImplementationOnce(() => applied.promise)
    choose('工作区内修改')
    await vi.waitFor(() => expect(old.setYolo).toHaveBeenCalledWith(false))
    submit('still waiting')
    expect(old.prompt).not.toHaveBeenCalled()
    applied.resolve({ effectiveFromSeq: 11 })
    await vi.waitFor(() => expect(label()).toBe('工作区内修改'))
    submit('confirmed permission')
    await vi.waitFor(() =>
      expect(old.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'confirmed permission' }], {
        titleLocale: 'zh-CN',
      }),
    )

    const opened = old.projectUIOpening.mock.calls.length
    connect('reconnecting')
    timeline.upto = 12
    connect('reconnected')
    await vi.waitFor(() => expect(old.projectUIOpening.mock.calls.length).toBeGreaterThan(opened))
    await vi.waitFor(() => expect(label()).toBe('请选择权限'))
    old.prompt.mockClear()
    submit('reconnect needs a new confirmation')
    expect(old.prompt).not.toHaveBeenCalled()
    expect(old.setYolo).toHaveBeenCalledTimes(1)
    old.setYolo.mockImplementationOnce(async () => ({ effectiveFromSeq: ++timeline.upto }))
    choose('工作区内修改')
    await vi.waitFor(() => expect(label()).toBe('工作区内修改'))
    submit('confirmed after reconnect')
    await vi.waitFor(() =>
      expect(old.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'confirmed after reconnect' }], {
        titleLocale: 'zh-CN',
      }),
    )
    expect(old.setYolo).toHaveBeenCalledTimes(2)
  }, 20_000)
})

describe('web session selection', () => {
  it('reads trace tool details from the selected session and tags trace snapshots with that session', async () => {
    installPublicFixture()
    const old = session('old', async () => idleTimeline('old'))
    const next = session('next', async () => idleTimeline('next'))
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models: [] } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: {
        list: vi.fn(async () => ({ items: [{ sessionId: 'old' }, { sessionId: 'next' }] })),
        load: vi.fn(async (id: string) => (id === 'old' ? old : next)),
      },
    })
    binding.loadWebSession.mockImplementation(async (_load: unknown, id: string) => ({
      session: id === 'old' ? old : next,
      offPermission: vi.fn(),
    }))

    await import('../src/app.js')
    expect(traceBridge.transcriptOptions).toMatchObject({ nodeHost: 'react' })
    expect(traceBridge.claim).toEqual(expect.any(Function))
    await vi.waitFor(() => expect(traceBridge.metas.at(-1)).toMatchObject({ sessionId: 'old' }))
    const reportProblem = document.getElementById('report-problem') as HTMLButtonElement
    reportProblem.click()
    const diagnostics = document.querySelector('dialog.diagnostics-dialog') as HTMLDialogElement
    expect(diagnostics.open).toBe(true)
    expect(diagnostics.querySelector('section:not([hidden])')?.getAttribute('data-step')).toBe('menu')
    diagnostics.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click()
    expect(diagnostics.open).toBe(false)
    expect(document.activeElement).toBe(reportProblem)
    const trace = traceBridge.options as {
      readToolDetail: (sessionId: string, callSeq: number, resultSeq?: number) => Promise<unknown>
    }
    await trace.readToolDetail('old', 3, 7)
    expect(old.readToolDetail).toHaveBeenCalledWith(3, 7, undefined)

    document.querySelector<HTMLButtonElement>('[data-session="next"]')?.click()
    await vi.waitFor(() => expect(traceBridge.metas.at(-1)).toMatchObject({ sessionId: 'next' }))
    await expect(trace.readToolDetail('old', 3, 7)).rejects.toThrow('会话已切换')
    await trace.readToolDetail('next', 9)
    expect(next.readToolDetail).toHaveBeenCalledWith(9, undefined, undefined)
    expect(old.readToolDetail).toHaveBeenCalledTimes(1)

    document.getElementById('new')?.click()
    await vi.waitFor(() => expect(traceBridge.metas.at(-1)).toBeUndefined())
    await expect(trace.readToolDetail('next', 9)).rejects.toThrow('没有当前会话')
    expect(next.readToolDetail).toHaveBeenCalledTimes(1)
  }, 15_000)

  it.each(['none', 'model', 'permission'] as const)(
    'opens a new draft with the last model and permission (reconnect during %s)',
    async (reconnectDuring) => {
      installPublicFixture()
      history.replaceState(null, '', '/#test-launcher-token')
      localStorage.setItem(
        'agnes-web-composer-selection',
        JSON.stringify({ model: { route: 'local', id: 'model-b' }, permission: 'full' }),
      )
      const fresh = session('fresh', async () => idleTimeline('fresh'))
      const applied = deferred<{ effectiveFromSeq: number }>()
      if (reconnectDuring === 'model') fresh.setModel.mockImplementationOnce(() => applied.promise)
      if (reconnectDuring === 'permission') fresh.setYolo.mockImplementationOnce(() => applied.promise)
      const draftModel = {
        route: 'local',
        id: 'model-b',
        contextWindow: 128000,
        thinkingLevelMap: { low: 'low', high: 'high' },
        defaultSettings: { thinking: 'high', contextWindow: 64000 },
      }
      const listeners = new Map<string, Set<() => void>>()
      const client = {
        connectionState: 'connected',
        initialize: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: () => void) => {
          const handlers = listeners.get(event) ?? new Set<() => void>()
          handlers.add(listener)
          listeners.set(event, handlers)
          return () => handlers.delete(listener)
        }),
        close: vi.fn(async () => undefined),
        apis: vi.fn(async () => ({
          profile: {
            models: [{ route: 'local', id: 'model-a' }, draftModel],
          },
        })),
        config: {
          get: vi.fn(async () => ({
            configured: true,
            profile: 'local',
            provider: { id: 'local', route: 'local', model: 'model-a' },
          })),
          providers: vi.fn(async () => ({ providers: [] })),
          save: vi.fn(async () => ({ configured: true })),
          test: vi.fn(async () => ({ verified: true, models: [] })),
        },
        approval: { decide: vi.fn(async () => undefined) },
        workspace: {
          list: vi.fn(async () => ({ items: [] })),
          add: vi.fn(async (path: string) => ({
            workspace: { path, name: 'agnes', lastUsedAt: null, sessionCount: 0, available: true },
          })),
        },
        session: {
          list: vi.fn(async () => ({ items: [] })),
          load: vi.fn(async () => fresh),
          new: vi.fn(async () => fresh),
        },
      }
      sdk.createClient.mockReturnValue(client)
      const connect = (event: 'reconnecting' | 'reconnected') => {
        client.connectionState = event === 'reconnected' ? 'connected' : 'reconnecting'
        for (const listener of [...(listeners.get(event) ?? [])]) listener()
      }
      binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
        session: selected,
        offPermission: vi.fn(),
      }))
      await import('../src/app.js')
      const model = document.getElementById('model') as HTMLButtonElement
      const permission = document.getElementById('composer-permission') as HTMLButtonElement
      await vi.waitFor(() => {
        expect(model.disabled).toBe(false)
        expect(model.querySelector('[data-model-label]')?.textContent).toBe('model-b')
      })
      expect(permission.querySelector('[data-permission-label]')?.textContent).toBe('完全权限')
      // 会话参数在模型行展开的详情里：模型列表 → 详情 → 参数选项三级。
      const row = (index: number) =>
        document.querySelectorAll<HTMLElement>('#model-listbox [role="option"]')[index]
      const detailRow = (id: string) => document.querySelector<HTMLElement>(`#model-settings-popover #${id}`)
      const leafOption = (label: string) =>
        [...document.querySelectorAll<HTMLElement>('#session-model-thinking [role="option"]')].find(
          (option) => option.textContent?.startsWith(label),
        )
      const budgetOption = (label: string) =>
        [...document.querySelectorAll<HTMLElement>('#session-model-budget [role="option"]')].find(
          (option) => option.textContent === label,
        )
      // 提交在飞行中时触发按钮与面板会一起禁用，每次开关前等它落定。
      const openPanel = async () => {
        await vi.waitFor(() => expect(model.disabled).toBe(false))
        if (!document.getElementById('model-listbox')) model.click()
        await vi.waitFor(() => expect(document.getElementById('model-listbox')).not.toBeNull())
      }
      const openDetail = async () => {
        await openPanel()
        if (!document.getElementById('model-settings-popover')) row(1)?.click()
        await vi.waitFor(() => expect(document.getElementById('model-settings-popover')).not.toBeNull())
      }
      const closePanel = async () => {
        await vi.waitFor(() => expect(model.disabled).toBe(false))
        if (document.getElementById('model-listbox')) model.click()
        await vi.waitFor(() => expect(document.getElementById('model-listbox')).toBeNull())
      }
      await openDetail()
      expect(detailRow('model-detail-capacity')?.textContent).toContain('128K')
      detailRow('model-detail-thinking')?.click()
      expect(leafOption('高')?.getAttribute('aria-selected')).toBe('true')
      leafOption('低')?.click()
      await vi.waitFor(() => expect(document.getElementById('notice')?.textContent).toContain('新会话将使用'))
      // 选完一个参数整条菜单收起，改下一个要重新展开。
      await vi.waitFor(() => expect(document.getElementById('model-listbox')).toBeNull())
      await openDetail()
      detailRow('model-detail-budget')?.click()
      budgetOption('32K')?.click()
      await vi.waitFor(() => expect(document.getElementById('model-listbox')).toBeNull())
      draftModel.defaultSettings.contextWindow = 96000
      await configurationCallback.saved?.({
        profile: 'local',
        revision: 1,
        configured: true,
        provider: null,
        effect: 'new-sessions',
      })
      await openDetail()
      expect(detailRow('model-detail-thinking')?.textContent).toContain('低')
      expect(detailRow('model-detail-budget')?.textContent).toContain('32K')
      await closePanel()
      const cwd = document.getElementById('new-session-cwd') as HTMLInputElement
      cwd.value = '/workspace/agnes'
      document
        .getElementById('new-session-form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await vi.waitFor(() =>
        expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(false),
      )
      const prompt = document.getElementById('prompt') as HTMLTextAreaElement
      prompt.value = 'use the remembered selection'
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
      document
        .getElementById('composer')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await vi.waitFor(() => expect(fresh.setModel).toHaveBeenCalled())
      expect(fresh.setModel).toHaveBeenCalledWith({
        slot: 'primary',
        route: 'local',
        model: 'model-b',
        thinking: 'low',
        contextWindow: 32000,
      })
      if (reconnectDuring !== 'none') {
        if (reconnectDuring === 'permission')
          await vi.waitFor(() => expect(fresh.setYolo).toHaveBeenCalledWith(true))
        const ready = deferred<void>()
        const opening = fresh.projectUIOpening.getMockImplementation()
        if (!opening) throw new Error('missing opening fixture')
        fresh.projectUIOpening.mockImplementationOnce(async (...args) => {
          await ready.promise
          return opening(...args)
        })
        const opened = fresh.projectUIOpening.mock.calls.length
        connect('reconnecting')
        connect('reconnected')
        await vi.waitFor(() => expect(fresh.projectUIOpening.mock.calls.length).toBeGreaterThan(opened))
        applied.resolve({ effectiveFromSeq: 1 })
        // A settled first-turn RPC must not continue sending on a different connection.
        await vi.waitFor(() =>
          expect(fresh.prompt.mock.calls.length > 0 || prompt.value === 'use the remembered selection').toBe(
            true,
          ),
        )
        const submittedBeforeOpening = fresh.prompt.mock.calls.length
        const permissionCalls = fresh.setYolo.mock.calls.length
        ready.resolve()
        await vi.waitFor(() =>
          expect(permission.querySelector('[data-permission-label]')?.textContent).toBe('工作区内修改'),
        )
        expect.soft(submittedBeforeOpening).toBe(0)
        expect.soft(permissionCalls).toBe(reconnectDuring === 'model' ? 0 : 1)
        expect.soft(prompt.value).toBe('use the remembered selection')
        permission.click()
        ;[...document.querySelectorAll<HTMLElement>('[role="option"]')]
          .find((row) => row.querySelector('.permission-picker-label')?.textContent === '完全权限')
          ?.click()
        await vi.waitFor(() =>
          expect(permission.querySelector('[data-permission-label]')?.textContent).toBe('完全权限'),
        )
        submit('use the remembered selection')
      }
      expect(fresh.setYolo).toHaveBeenCalledWith(true)
      await vi.waitFor(() =>
        expect(fresh.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'use the remembered selection' }], {
          titleLocale: 'zh-CN',
        }),
      )
      expect(permission.querySelector('[data-permission-label]')?.textContent).toBe('完全权限')
    },
    20_000,
  )

  it('starts a draft in the workspace chosen from its sidebar action', async () => {
    installPublicFixture()
    const alpha = {
      path: '/workspace/alpha',
      name: 'Alpha',
      lastUsedAt: null,
      sessionCount: 1,
      available: true,
    }
    const beta = {
      path: '/workspace/beta',
      name: 'Beta',
      lastUsedAt: null,
      sessionCount: 0,
      available: true,
    }
    const old = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
    const fresh = session('fresh', async () => idleTimeline('fresh', { route: 'local', id: 'model-a' }))
    const create = vi.fn(async () => fresh)
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      approval: { decide: vi.fn(async () => undefined) },
      workspace: { list: vi.fn(async () => ({ items: [alpha, beta] })) },
      session: {
        list: vi.fn(async () => ({ items: [{ sessionId: 'old', cwd: alpha.path }] })),
        load: vi.fn(async () => old),
        new: create,
      },
    })
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))

    await import('../src/app.js')
    const createInBeta = await vi.waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-workspace-new-session="/workspace/beta"]',
      )
      expect(button).toBeTruthy()
      expect(button?.disabled).toBe(false)
      return button as HTMLButtonElement
    })
    createInBeta.click()

    await vi.waitFor(() => expect(document.querySelector('[data-workspace-label]')?.textContent).toBe('Beta'))
    expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(false)
    expect(create).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect((document.getElementById('prompt') as HTMLTextAreaElement).disabled).toBe(false),
    )

    submit('create in beta')
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(create).toHaveBeenCalledWith({ cwd: beta.path, sessionKey: expect.any(String) })
    await vi.waitFor(() =>
      expect(fresh.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'create in beta' }], {
        titleLocale: 'zh-CN',
      }),
    )
  })

  it('keeps controls usable after a pending model update and refreshes both old and new drafts', async () => {
    installPublicFixture()
    let models = [{ route: 'local', id: 'model-a' }]
    const old = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old' }] })), load: vi.fn(async () => old) },
    })
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await import('../src/app.js')
    const control = (id: string) => document.getElementById(id) as HTMLButtonElement
    await vi.waitFor(() => expect(control('model').disabled).toBe(false))
    const snapshot = {
      configured: true,
      effect: 'restart-required',
      provider: { id: 'new', route: 'new', model: 'model-b' },
    } as ConfigSnapshot
    const savedCallback = configurationCallback.saved
    if (!savedCallback) throw new Error('settings callback not bound')
    await savedCallback(snapshot)
    for (const id of ['model', 'composer-workspace', 'composer-permission', 'new', 'prompt'])
      expect(control(id).disabled).toBe(false)
    expect(document.getElementById('notice')?.textContent).toContain('尚未生效')
    models = [...models, { route: 'new', id: 'model-b' }]
    await savedCallback({ ...snapshot, effect: 'new-sessions' })
    control('model').click()
    openModelList()
    expect(modelMenu().textContent).toContain('model-b')
    control('model').click()
    control('new').click()
    await vi.waitFor(() => expect(control('model').disabled).toBe(false))
    for (const id of ['composer-workspace', 'composer-permission', 'prompt'])
      expect(control(id).disabled).toBe(false)
    models = []
    await savedCallback({ ...snapshot, configured: false })
    for (const id of ['composer-workspace', 'composer-permission', 'new', 'prompt'])
      expect(control(id).disabled).toBe(false)
    expect(control('send').disabled).toBe(true)
  })

  it('keeps the model picker flat and applies the selected model settings', async () => {
    installPublicFixture()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const old = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      // Model capability metadata stays available to settings even though the picker is flat.
      apis: vi.fn(async () => ({
        profile: {
          models: [
            {
              route: 'local',
              id: 'model-a',
              reasoning: true,
              thinkingLevelMap: { low: 'low', high: 'high' },
            },
          ],
        },
      })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old' }] })), load: vi.fn(async () => old) },
    })
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await import('../src/app.js')
    const control = (id: string) => document.getElementById(id) as HTMLButtonElement
    await vi.waitFor(() => expect(control('model').disabled).toBe(false))

    const rows = () => Array.from(modelMenu().querySelectorAll<HTMLElement>('[role="option"]'))
    control('model').click()
    openModelList()
    rows()[0]?.click()
    await vi.waitFor(() =>
      expect(old.setModel).toHaveBeenCalledWith({
        slot: 'primary',
        route: 'local',
        model: 'model-a',
        thinking: 'off',
        contextWindow: 128000,
      }),
    )

    // 模型列表仍是扁平的一段；档位与预算只是同面板的另外两段，模型那段不掺进二级菜单。
    await vi.waitFor(() => expect(control('model').disabled).toBe(false))
    control('model').click()
    expect(document.querySelector('.model-picker-entry, #model-submenu-listbox')).toBeNull()
    expect(rows().map((row) => row.textContent?.trim())).toContain('model-a已配置账户')
    control('model').click()
  }, 20_000)

  it.each(['save-first', 'poll-first', 'poll-fails'])(
    'keeps saved model status accurate when %s',
    async (order) => {
      installPublicFixture()
      const old = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
      const apis = vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } }))
      sdk.createClient.mockReturnValue({
        initialize: vi.fn(async () => undefined),
        on: vi.fn(),
        close: vi.fn(async () => undefined),
        apis,
        config: {
          get: vi.fn(async () => ({ configured: true })),
          providers: vi.fn(async () => ({ providers: [] })),
        },
        workspace: { list: vi.fn(async () => ({ items: [] })) },
        session: {
          list: vi.fn(async () => ({ items: [{ sessionId: 'old' }] })),
          load: vi.fn(async () => old),
        },
      })
      binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
      await import('../src/app.js')
      const modelButton = document.getElementById('model') as HTMLButtonElement
      await vi.waitFor(() => expect(modelButton.disabled).toBe(false))
      const saveRead = deferred<Awaited<ReturnType<typeof apis>>>()
      const pollRead = deferred<Awaited<ReturnType<typeof apis>>>()
      apis.mockImplementationOnce(() => saveRead.promise).mockImplementationOnce(() => pollRead.promise)
      const save = configurationCallback.saved
      if (!save) throw new Error('settings callback not bound')
      const saved = save({
        configured: true,
        effect: 'new-sessions',
        provider: { id: 'new', route: 'new', model: 'model-b' },
      } as ConfigSnapshot)
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.waitFor(() => expect(apis).toHaveBeenCalledTimes(3))
      const result = { profile: { models: [{ route: 'new', id: 'model-b' }] } }
      const newer = { profile: { models: [...result.profile.models, { route: 'newer', id: 'model-c' }] } }
      if (order === 'poll-first') {
        pollRead.resolve(newer)
        await Promise.resolve()
      }
      saveRead.resolve(result)
      await saved
      expect(document.getElementById('notice')?.textContent).toContain('模型配置已更新')
      if (order === 'poll-fails') pollRead.reject(new Error('poll unavailable'))
      else pollRead.resolve(result)
      await vi.waitFor(() => expect(modelButton.disabled).toBe(false))
      modelButton.click()
      openModelList()
      expect(modelMenu().textContent).toContain('model-b')
      if (order === 'poll-first') expect(modelMenu().textContent).toContain('model-c')
    },
  )

  it.each(['missing-profile', 'system-error', 'legacy-ledger'])(
    'keeps %s recovery visible and allows retry or a new task',
    async (kind) => {
      installPublicFixture()
      const old = session('old', async () => idleTimeline('old'))
      const error =
        kind === 'legacy-ledger'
          ? Object.assign(new Error('SEMANTIC_REJECTED (-32011)'), {
              data: {
                code: 'LEGACY_LEDGER_FORMAT',
                reason: 'legacy-ledger-format',
                diagnosticId: '00000000-0000-4000-8000-000000000001',
              },
            })
          : Object.assign(new Error('INTERNAL_ERROR (-32603)'), {
              data:
                kind === 'missing-profile'
                  ? { code: 'SESSION_PROFILE_MISSING' }
                  : { diagnosticId: '00000000-0000-4000-8000-000000000001' },
            })
      const create = vi.fn()
      sdk.createClient.mockReturnValue({
        apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
        close: vi.fn(async () => undefined),
        initialize: vi.fn(async () => undefined),
        on: vi.fn(),
        config: {
          get: vi.fn(async () => ({ configured: true })),
          providers: vi.fn(async () => ({ providers: [] })),
        },
        workspace: { list: vi.fn(async () => ({ items: [] })) },
        session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old', title: 'Old' }] })), new: create },
      })
      binding.loadWebSession
        .mockRejectedValueOnce(error)
        .mockResolvedValue({ session: old, offPermission: vi.fn() })
      await import('../src/app.js')
      const notice = document.getElementById('notice') as HTMLElement
      await vi.waitFor(() => expect(notice.dataset.kind).toBe('session-recovery'))
      if (kind === 'legacy-ledger') {
        expect(notice.textContent).toContain('该会话由旧版本创建，当前版本无法打开，请新建会话。')
        expect(notice.textContent).not.toContain('诊断')
        expect(notice.textContent).not.toContain('00000000-0000-4000-8000-000000000001')
      } else
        expect(notice.textContent).toContain(
          kind === 'missing-profile' ? '旧配置文件已缺失' : '00000000-0000-4000-8000-000000000001',
        )
      // The session list renders whatever the failed open was.
      expect(document.querySelector('#sessions')?.textContent).toContain('Old')
      document.body.click()
      document.getElementById('settings')?.click()
      await vi.waitFor(() => expect((document.getElementById('config') as HTMLDialogElement).open).toBe(true))
      expect(notice.dataset.kind).toBe('session-recovery')
      document.getElementById('config-close')?.click()
      notice.querySelector('button')?.click()
      await vi.waitFor(() =>
        expect((document.getElementById('prompt') as HTMLTextAreaElement).disabled).toBe(false),
      )
      expect(notice.textContent).toBe('')
      expect(create).not.toHaveBeenCalled()
      binding.loadWebSession.mockRejectedValueOnce(error)
      // Reload the same historical task explicitly; preserve recovery rather than deleting its row.
      const row = [...document.querySelectorAll<HTMLButtonElement>('#sessions button')].find((button) =>
        button.textContent?.includes('Old'),
      )
      row?.click()
      await vi.waitFor(() => expect(notice.dataset.kind).toBe('session-recovery'))
      const newTask = [...notice.querySelectorAll('button')].find(
        (button) => button.textContent === '新建任务',
      )
      newTask?.click()
      await vi.waitFor(() =>
        expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(true),
      )
      expect(notice.textContent).toBe('')
      expect(create).not.toHaveBeenCalled()
    },
  )

  it.each(['missing-profile', 'system-error'])(
    'preserves %s recovery through disconnects and unrelated refresh failures',
    async (kind) => {
      installPublicFixture()
      const old = session('old', async () => idleTimeline('old'))
      const error = Object.assign(new Error('INTERNAL_ERROR (-32603)'), {
        data:
          kind === 'missing-profile'
            ? { code: 'SESSION_PROFILE_MISSING' }
            : { diagnosticId: '00000000-0000-4000-8000-000000000001' },
      })
      const create = vi.fn()
      sdk.createClient.mockReturnValue({
        apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
        close: vi.fn(async () => undefined),
        initialize: vi.fn(async () => undefined),
        on: vi.fn(),
        config: {
          get: vi.fn(async () => ({ configured: true })),
          providers: vi.fn(async () => ({ providers: [] })),
        },
        workspace: { list: vi.fn(async () => ({ items: [] })) },
        session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old', title: 'Old' }] })), new: create },
      })
      binding.loadWebSession
        .mockRejectedValueOnce(error)
        .mockResolvedValue({ session: old, offPermission: vi.fn() })
      await import('../src/app.js')
      const notice = document.getElementById('notice') as HTMLElement
      await vi.waitFor(() => expect(notice.dataset.kind).toBe('session-recovery'))
      expect(notice.textContent).toContain(
        kind === 'missing-profile' ? '旧配置文件已缺失' : '00000000-0000-4000-8000-000000000001',
      )

      const client = sdk.createClient.mock.results.at(-1)?.value
      const recoveryButtons = [...notice.querySelectorAll<HTMLButtonElement>('button')]
      const [retry, newTask] = recoveryButtons
      expect(retry).toBeDefined()
      expect(newTask).toBeDefined()
      if (!retry || !newTask) throw new Error('missing recovery controls')
      if (kind === 'missing-profile') {
        const pendingLoad = deferred<{ session: SessionDouble; offPermission: ReturnType<typeof vi.fn> }>()
        binding.loadWebSession.mockImplementationOnce(() => pendingLoad.promise)
        const event = (name: string) => client.on.mock.calls.find(([key]: [string]) => key === name)?.[1]()
        event('reconnecting')
        expect((document.getElementById('new') as HTMLButtonElement).disabled).toBe(true)
        for (const control of recoveryButtons) {
          expect(control.disabled).toBe(true)
          // Programmatic dispatch also exercises the handler guard.
          control.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }
        expect(binding.loadWebSession).toHaveBeenCalledTimes(1)
        expect(new URL(location.href).searchParams.get('session')).toBe('old')
        expect(notice.textContent).toContain('旧配置文件已缺失')
        event('reconnected')
        await vi.waitFor(() => expect(retry.disabled).toBe(false))
        expect(newTask.disabled).toBe(false)
        retry.click()
        await vi.waitFor(() => expect(binding.loadWebSession).toHaveBeenCalledTimes(2))
        for (const control of recoveryButtons) expect(control.disabled).toBe(true)
        newTask.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect((document.getElementById('new-session') as HTMLDialogElement).open).toBe(false)
        pendingLoad.resolve({ session: old, offPermission: vi.fn() })
        await vi.waitFor(() => expect(notice.textContent).toBe(''))
      } else {
        retry.focus()
        client.session.list.mockRejectedValueOnce(new Error('review-list-failure'))
        window.dispatchEvent(new Event('focus'))
        await vi.waitFor(() => expect(notice.textContent).toContain('review-list-failure'))
        expect(notice.textContent).toContain('00000000-0000-4000-8000-000000000001')
        expect(notice.querySelector('button')).toBe(retry)
        expect(document.activeElement).toBe(retry)
        window.dispatchEvent(new Event('focus'))
        await vi.waitFor(() => expect(notice.textContent).not.toContain('review-list-failure'))
        expect(notice.dataset.kind).toBe('session-recovery')
        expect(notice.textContent).toContain('历史任务打开失败')
        expect(notice.querySelector('button')).toBe(retry)
        retry.click()
        await vi.waitFor(() => expect(notice.textContent).toBe(''))
      }
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('creates only after confirming a directory and never sends to the old session during creation', async () => {
    installPublicFixture()
    const firstCreation = deferred<SessionDouble>()
    const create = vi.fn<() => Promise<SessionDouble>>(() => firstCreation.promise)
    const newProjection = deferred<UITimeline>()
    const old = session('old', async () => idleTimeline('old'))
    const fresh = session('fresh', () => newProjection.promise)
    let includeFresh = false

    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      workspace: {
        list: vi.fn(async () => {
          throw new Error('workspace list failed')
        }),
        add: vi.fn(async (path: string) => ({
          workspace: { path, name: 'agnes', lastUsedAt: null, sessionCount: 0, available: true },
        })),
      },
      session: {
        list: vi.fn(async () => ({
          items: [
            { sessionId: 'old', title: '现有任务' },
            ...(includeFresh ? [{ sessionId: 'fresh', title: '新任务' }] : []),
          ],
        })),
        load: vi.fn(async (id: string) => (id === 'old' ? old : fresh)),
        new: create,
      },
    })
    binding.loadWebSession.mockImplementation(async (_load: unknown, id: string) => ({
      session: id === 'old' ? old : fresh,
      offPermission: vi.fn(),
    }))
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))

    await import('../src/app.js')
    const newButton = document.getElementById('new') as HTMLButtonElement
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement
    const send = document.getElementById('send') as HTMLButtonElement
    const model = document.getElementById('model') as HTMLButtonElement
    const newSession = document.getElementById('new-session') as HTMLDialogElement
    const newSessionForm = document.getElementById('new-session-form') as HTMLFormElement
    const newSessionCwd = document.getElementById('new-session-cwd') as HTMLInputElement
    const newSessionCancel = document.getElementById('new-session-cancel') as HTMLButtonElement
    const newSessionCreate = document.getElementById('new-session-create') as HTMLButtonElement

    await vi.waitFor(() => expect(prompt.disabled).toBe(false))
    expect(document.getElementById('notice')?.textContent).toContain('无法读取工作区列表')
    expect(send.disabled).toBe(true)
    expect(send.dataset.mode).toBe('idle')
    expect(send.getAttribute('aria-label')).toBe('发送')
    expect(send.title).toBe('发送（Enter）')
    expect(document.getElementById('composer-hint')?.dataset.kind).toBe('shortcut')
    expect(model.tagName).toBe('BUTTON')
    expect(model.querySelector('[data-model-label]')?.textContent).toBe('选择模型')
    expect(model.getAttribute('aria-label')).toBe('选择当前会话模型')
    prompt.value = 'enable the send control'
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
    expect(send.disabled).toBe(false)
    prompt.value = ''
    prompt.dispatchEvent(new Event('input', { bubbles: true }))

    model.click()
    openModelList()
    const option = modelMenu().querySelector<HTMLElement>('[role="option"]')
    option?.click()
    await vi.waitFor(() =>
      expect(old.setModel).toHaveBeenCalledWith({
        slot: 'primary',
        route: 'local',
        model: 'model-a',
        thinking: null,
        contextWindow: null,
      }),
    )
    expect(model.querySelector('[data-model-label]')?.textContent).toBe('model-a')
    expect(model.title).toBe('当前会话模型：model-a')
    expect(model.getAttribute('aria-label')).toBe('当前会话模型：model-a')

    old.detach.mockRejectedValueOnce(new Error('detach cleanup failed'))
    newButton.click()
    expect(newSession.open).toBe(true)
    expect(create).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(document.getElementById('notice')?.textContent).toContain('detach cleanup failed'),
    )
    expect(prompt.disabled).toBe(false)
    newSessionCwd.value = '/cancelled-directory'
    newSessionCancel.click()
    expect(newSession.open).toBe(false)
    expect(create).not.toHaveBeenCalled()

    newButton.click()
    newSessionCwd.value = ' /workspace/agnes '
    await vi.waitFor(() => expect(newSessionCreate.disabled).toBe(false))
    newSessionForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(newSession.open).toBe(false))
    submit('must not cross sessions')

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(prompt.disabled).toBe(true)
    expect(send.disabled).toBe(true)
    expect(model.disabled).toBe(true)
    expect(old.prompt).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith({ cwd: '/workspace/agnes', sessionKey: expect.any(String) })

    firstCreation.resolve(fresh)
    includeFresh = true
    newProjection.resolve(idleTimeline('fresh'))
    await vi.waitFor(() =>
      expect(fresh.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'must not cross sessions' }], {
        titleLocale: 'zh-CN',
      }),
    )
  })

  it('opens directory confirmation before creation and explains an unavailable path', async () => {
    installPublicFixture()
    history.replaceState(null, '', '/#test-launcher-token')
    const create = vi.fn<() => Promise<SessionDouble>>()

    const add = vi.fn(async () => {
      throw Object.assign(new Error('SEMANTIC_REJECTED (-32011)'), {
        data: { code: 'WORKSPACE_INVALID', reason: 'not-found' },
      })
    })
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      workspace: {
        list: vi.fn(async () => ({ items: [] })),
        add,
      },
      session: {
        list: vi.fn(async () => ({ items: [] })),
        load: vi.fn(),
        new: create,
      },
    })
    binding.loadWebSession.mockImplementation(async () => {
      throw new Error('no session should load before creation')
    })
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))

    await import('../src/app.js')
    const newSession = document.getElementById('new-session') as HTMLDialogElement
    const newSessionForm = document.getElementById('new-session-form') as HTMLFormElement
    const newSessionCwd = document.getElementById('new-session-cwd') as HTMLInputElement
    const newSessionCancel = document.getElementById('new-session-cancel') as HTMLButtonElement
    const newSessionCreate = document.getElementById('new-session-create') as HTMLButtonElement

    await vi.waitFor(() => expect(newSession.open).toBe(true))
    expect(create).not.toHaveBeenCalled()
    newSessionCwd.value = '/workspace/not-present'
    newSessionCwd.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(newSessionCreate.disabled).toBe(false))
    newSessionForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.getElementById('new-session-error')?.textContent).toContain(
        '工作目录不存在，请检查路径后重试。',
      ),
    )
    expect(newSession.open).toBe(true)
    expect(add).toHaveBeenCalledWith('/workspace/not-present')
    newSessionCancel.click()
    expect(newSession.open).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it('uses the system picker, treats cancel as a no-op, then validates the selected path through workspace.add', async () => {
    installPublicFixture()
    history.replaceState(null, '', '/#test-launcher-token')
    let pickerCalls = 0
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'GET') return new Response(JSON.stringify({ available: true }), { status: 200 })
      pickerCalls++
      return new Response(
        JSON.stringify(
          pickerCalls === 1 ? { status: 'cancelled' } : { status: 'selected', path: '/workspace/系统选择' },
        ),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetcher)
    const add = vi.fn(async (path: string) => ({
      workspace: { path, name: '系统选择', lastUsedAt: null, sessionCount: 0, available: true },
    }))
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      workspace: { list: vi.fn(async () => ({ items: [] })), add },
      session: { list: vi.fn(async () => ({ items: [] })), load: vi.fn(), new: vi.fn() },
    })

    await import('../src/app.js')
    const dialog = document.getElementById('new-session') as HTMLDialogElement
    const picker = document.getElementById('workspace-pick') as HTMLButtonElement
    await vi.waitFor(() => {
      expect(dialog.open).toBe(true)
      expect(picker.disabled).toBe(false)
    })

    picker.click()
    await vi.waitFor(() => expect(picker.disabled).toBe(false))
    expect(dialog.open).toBe(true)
    expect(add).not.toHaveBeenCalled()

    picker.click()
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(add).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith('/workspace/系统选择')
    expect(fetcher).toHaveBeenLastCalledWith(
      '/api/workspace-picker',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
  })

  it('keeps the native picker available when workspace.add rejects the selected directory', async () => {
    installPublicFixture()
    history.replaceState(null, '', '/#test-launcher-token')
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_input, init) =>
        init?.method === 'GET'
          ? new Response(JSON.stringify({ available: true }), { status: 200 })
          : new Response(JSON.stringify({ status: 'selected', path: '/workspace/removed' }), {
              status: 200,
            }),
      ),
    )
    const add = vi.fn(async () => {
      throw Object.assign(new Error('gone'), { code: 'WORKSPACE_INVALID', data: { reason: 'not-found' } })
    })
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      workspace: { list: vi.fn(async () => ({ items: [] })), add },
      session: { list: vi.fn(async () => ({ items: [] })), load: vi.fn(), new: vi.fn() },
    })

    await import('../src/app.js')
    const picker = document.getElementById('workspace-pick') as HTMLButtonElement
    await vi.waitFor(() => expect(picker.disabled).toBe(false))
    picker.click()
    await vi.waitFor(() =>
      expect(document.getElementById('new-session-error')?.textContent).toContain(
        '工作目录不存在，请检查路径后重试。',
      ),
    )
    expect(add).toHaveBeenCalledWith('/workspace/removed')
    expect(picker.hidden).toBe(false)
    expect(picker.disabled).toBe(false)
  })

  it.each(['slow', 'failed'] as const)(
    'sends the first prompt independently of a %s sidebar refresh',
    async (mode) => {
      installPublicFixture()
      history.replaceState(null, '', '/#test-launcher-token')
      const fresh = session('fresh', async () => idleTimeline('fresh'))
      const listing = deferred<{ items: Array<{ sessionId: string; title: string }> }>()
      let created = false
      const workspace = {
        path: '/workspace/agnes',
        name: 'agnes',
        lastUsedAt: null,
        sessionCount: 0,
        available: true,
      }
      sdk.createClient.mockReturnValue({
        apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
        approval: { decide: vi.fn(async () => undefined) },
        close: vi.fn(async () => undefined),
        config: {
          get: vi.fn(async () => ({ configured: true })),
          providers: vi.fn(async () => ({ providers: [] })),
          save: vi.fn(async () => ({ configured: true })),
          test: vi.fn(async () => ({ verified: true, models: [] })),
        },
        initialize: vi.fn(async () => undefined),
        on: vi.fn(),
        workspace: {
          list: vi.fn(async () => ({ items: [] })),
          add: vi.fn(async () => ({ workspace })),
        },
        session: {
          list: vi.fn(async () => (created ? listing.promise : { items: [] })),
          load: vi.fn(async () => fresh),
          new: vi.fn(async () => {
            created = true
            return fresh
          }),
        },
      })
      binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
        session: selected,
        offPermission: vi.fn(),
      }))
      await import('../src/app.js')
      const dialog = document.getElementById('new-session') as HTMLDialogElement
      await vi.waitFor(() => expect(dialog.open).toBe(true))
      const path = document.getElementById('new-session-cwd') as HTMLInputElement
      path.value = workspace.path
      path.dispatchEvent(new Event('input', { bubbles: true }))
      await vi.waitFor(() =>
        expect((document.getElementById('new-session-create') as HTMLButtonElement).disabled).toBe(false),
      )
      document
        .getElementById('new-session-form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await vi.waitFor(() => expect(dialog.open).toBe(false))
      document.getElementById('model')?.click()
      openModelList()
      modelMenu().querySelector<HTMLElement>('[role="option"]')?.click()
      try {
        submit('first message')
        await vi.waitFor(() =>
          expect(fresh.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'first message' }], {
            titleLocale: 'zh-CN',
          }),
        )
        if (mode === 'failed') {
          listing.reject(new Error('sidebar list failed'))
          await vi.waitFor(() =>
            expect(document.getElementById('notice')?.textContent).toContain('sidebar list failed'),
          )
        }
        expect((document.getElementById('prompt') as HTMLTextAreaElement).value).toBe('')
        expect(fresh.prompt).toHaveBeenCalledTimes(1)
      } finally {
        listing.resolve({ items: [{ sessionId: 'fresh', title: 'fresh' }] })
      }
    },
  )

  it('keeps the first draft and creation key through model and prompt failures', async () => {
    installPublicFixture()
    history.replaceState(null, '', '/#test-launcher-token')
    const fresh = session('fresh', async () => idleTimeline('fresh'))
    fresh.setModel
      .mockRejectedValueOnce(new Error('initial model failed'))
      .mockResolvedValue({ effectiveFromSeq: 1 })
    fresh.prompt
      .mockRejectedValueOnce(
        Object.assign(new Error('INTERNAL_ERROR (-32603)'), {
          data: { code: 'TURN_ERROR', error: { code: 'AUTH' } },
        }),
      )
      .mockResolvedValue(undefined)
    let includeFresh = false
    const create = vi.fn<(options: { cwd: string; sessionKey: string }) => Promise<SessionDouble>>(
      async () => {
        includeFresh = true
        return fresh
      },
    )
    const workspace = {
      path: '/workspace/agnes',
      name: 'agnes',
      lastUsedAt: null,
      sessionCount: 0,
      available: true,
    }

    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      workspace: {
        list: vi.fn(async () => ({ items: [] })),
        add: vi.fn(async () => ({ workspace })),
      },
      session: {
        list: vi.fn(async () => ({
          items: includeFresh ? [{ sessionId: 'fresh', title: '新任务' }] : [],
        })),
        load: vi.fn(async () => fresh),
        new: create,
      },
    })
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))

    await import('../src/app.js')
    const dialog = document.getElementById('new-session') as HTMLDialogElement
    const path = document.getElementById('new-session-cwd') as HTMLInputElement
    const form = document.getElementById('new-session-form') as HTMLFormElement
    const createButton = document.getElementById('new-session-create') as HTMLButtonElement
    const composer = document.getElementById('prompt') as HTMLTextAreaElement

    await vi.waitFor(() => expect(dialog.open).toBe(true))
    path.value = workspace.path
    path.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(createButton.disabled).toBe(false))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    document.getElementById('model')?.click()
    openModelList()
    modelMenu().querySelector<HTMLElement>('[role="option"]')?.click()

    submit('保留这条首轮草稿')
    await vi.waitFor(() =>
      expect(document.getElementById('notice')?.textContent).toContain('initial model failed'),
    )
    expect(composer.value).toBe('保留这条首轮草稿')
    expect(fresh.prompt).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    const firstKey = create.mock.calls[0]?.[0]?.sessionKey
    expect(firstKey).toEqual(expect.any(String))

    submit('保留这条首轮草稿')
    await vi.waitFor(() =>
      expect(document.getElementById('notice')?.textContent).toContain(
        '模型凭据已失效或被上游拒绝，请在设置中重新配置或登录该模型账号。',
      ),
    )
    expect(fresh.setModel).toHaveBeenCalledTimes(2)
    expect(fresh.prompt).toHaveBeenCalledTimes(1)
    expect(composer.value).toBe('保留这条首轮草稿')
    expect(create).toHaveBeenCalledTimes(1)

    submit('保留这条首轮草稿')
    await vi.waitFor(() => expect(fresh.prompt).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(composer.disabled).toBe(false))
    expect(document.querySelector('[data-workspace-label]')?.textContent).toBe('agnes')
    expect(document.getElementById('composer-workspace')?.title).toBe(workspace.path)

    document.querySelector<HTMLInputElement>('input[name="agnes-locale"][value="en"]')?.click()
    composer.value = '成功后的第二条消息'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() =>
      expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false),
    )
    document
      .getElementById('composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(fresh.prompt).toHaveBeenLastCalledWith([{ type: 'text', text: '成功后的第二条消息' }], {
        titleLocale: 'en',
      }),
    )
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0]?.sessionKey).toBe(firstKey)
  })

  it('preserves the running action as a named busy mode with a separate stop control', async () => {
    installPublicFixture()
    let pendingInputs = [
      { itemId: 'B', preview: '第二条提示词' },
      { itemId: 'C', preview: '第三条提示词' },
    ]
    let sequence = 1
    const running = session('old', async () => ({ ...busyTimeline('old'), upto: sequence, pendingInputs }))
    const titleList = vi.fn(async () => ({ items: [{ sessionId: 'old' }] }))
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      workspace: {
        list: vi.fn(async () => ({ items: [] })),
        add: vi.fn(async (path: string) => ({
          workspace: { path, name: 'agnes', lastUsedAt: null, sessionCount: 0, available: true },
        })),
      },
      session: {
        list: titleList,
        load: vi.fn(async () => running),
        new: vi.fn(),
      },
    })
    binding.loadWebSession.mockImplementation(async () => ({ session: running, offPermission: vi.fn() }))
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))

    await import('../src/app.js')
    const send = document.getElementById('send') as HTMLButtonElement
    const cancel = document.getElementById('cancel') as HTMLButtonElement
    const hint = document.getElementById('composer-hint') as HTMLParagraphElement

    await vi.waitFor(() => expect(send.dataset.mode).toBe('busy'))
    expect(send.getAttribute('aria-label')).toBe('加入下一轮')
    expect(send.title).toBe('加入下一轮（Enter）')
    expect(hint.dataset.kind).toBe('state')
    expect(hint.textContent).toBe('可补充下一轮')
    expect(cancel.hidden).toBe(false)
    expect(cancel.textContent).toBe('停止')
    expect(document.querySelector('.composer-queue-count')?.textContent).toBe('待执行 · 2')
    expect(
      Array.from(document.querySelectorAll('.composer-queue-preview'), (node) => node.textContent),
    ).toEqual(['第二条提示词', '第三条提示词'])
    const sendNow = deferred<number>()
    running.sendNow.mockImplementationOnce(() => sendNow.promise)
    const queuedButton = document.querySelector<HTMLButtonElement>('[data-queue-item="C"] button')
    if (!queuedButton) throw new Error('missing queued input action')
    queuedButton.click()
    queuedButton.click()
    expect(running.sendNow).toHaveBeenCalledTimes(1)
    expect(running.sendNow).toHaveBeenCalledWith('C')
    expect(queuedButton.disabled).toBe(true)
    expect(queuedButton.getAttribute('aria-busy')).toBe('true')
    expect(cancel.disabled).toBe(true)
    sendNow.reject(new Error('synthetic send-now refusal'))
    await vi.waitFor(() =>
      expect(document.querySelector('.composer-queue-error')?.textContent).toBe('synthetic send-now refusal'),
    )
    expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(2)
    running.sendNow.mockImplementationOnce(async () => {
      pendingInputs = [{ itemId: 'B', preview: '第二条提示词' }]
      sequence++
      return sequence
    })
    queuedButton.click()
    await vi.waitFor(() => expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(1))
    expect(document.querySelector('.composer-queue-count')?.textContent).toBe('待执行 · 1')
    expect(running.prompt).not.toHaveBeenCalled()
    const reads = titleList.mock.calls.length
    running.followUp.mockImplementation(async (input: { type: string; text?: string }[]) => {
      sequence++
      // 提交内容已是 ContentBlock[]，排队区的 preview 由 daemon 从文本块得出，这里照此模拟。
      const preview = input
        .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
        .join('')
      pendingInputs = [...pendingInputs, { itemId: `queued-${sequence}`, preview }]
      return sequence
    })
    const followUps = ['本轮还没结束，先补充下一轮', '再排一条', '第三条也应立即显示']
    for (const [index, input] of followUps.entries()) {
      submit(input)
      await vi.waitFor(() => expect(running.followUp).toHaveBeenCalledTimes(index + 1))
      await vi.waitFor(() => expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(index + 2))
    }
    expect(
      Array.from(document.querySelectorAll('.composer-queue-preview'), (node) => node.textContent),
    ).toEqual(['第二条提示词', ...followUps])
    expect(titleList).toHaveBeenCalledTimes(reads)
    const composer = document.getElementById('prompt') as HTMLTextAreaElement
    composer.value = '尚未发送的草稿'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    const removeItemId = pendingInputs[1]?.itemId
    const remove = document.querySelector<HTMLButtonElement>(
      '.composer-queue li:nth-child(2) .composer-queue-remove',
    )
    if (!remove) throw new Error('missing queued input deletion')
    expect(remove.type).toBe('button')
    expect(remove.textContent).toBe('删除')
    expect(remove.getAttribute('aria-label')).toBe('删除第 2 条待执行消息')
    expect(cancel.disabled).toBe(false)
    expect(running.cancel).not.toHaveBeenCalled()
    const removing = deferred<number>()
    running.removeQueued.mockImplementationOnce(() => removing.promise)
    remove.click()
    remove.click()
    expect(running.removeQueued).toHaveBeenCalledExactlyOnceWith(removeItemId)
    expect(remove.disabled).toBe(true)
    expect(remove.getAttribute('aria-busy')).toBe('true')
    expect(remove.textContent).toBe('正在删除…')
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('.composer-queue button')).every(
        (button) => button.disabled,
      ),
    ).toBe(true)
    expect(document.activeElement).toBe(composer)
    expect(cancel.disabled).toBe(false)
    const firstCancel = deferred<void>()
    running.cancel.mockImplementationOnce(() => firstCancel.promise)
    cancel.click()
    await vi.waitFor(() => expect(running.cancel).toHaveBeenCalledTimes(1))
    expect(cancel.disabled).toBe(true)
    cancel.click()
    expect(running.cancel).toHaveBeenCalledTimes(1)
    removing.reject(new Error('synthetic removal refusal'))
    await vi.waitFor(() =>
      expect(document.querySelector('.composer-queue-error')?.textContent).toBe('synthetic removal refusal'),
    )
    expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(4)
    // Deletion settling must not unlock the composer while stopping is still pending.
    expect(cancel.disabled).toBe(true)
    expect(remove.disabled).toBe(true)
    expect(composer.disabled).toBe(true)
    firstCancel.reject(new Error('cancel temporarily unavailable'))
    await vi.waitFor(() => expect(cancel.disabled).toBe(false))
    expect(remove.disabled).toBe(false)
    expect(composer.disabled).toBe(false)
    running.removeQueued.mockImplementationOnce(async (itemId: string) => {
      pendingInputs = pendingInputs.filter((item) => item.itemId !== itemId)
      return ++sequence
    })
    remove.click()
    await vi.waitFor(() => expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(3))
    expect(document.querySelector('.composer-queue-count')?.textContent).toBe('待执行 · 3')
    expect(
      Array.from(document.querySelectorAll('.composer-queue-preview'), (node) => node.textContent),
    ).toEqual(['第二条提示词', ...followUps.slice(1)])
    expect(composer.value).toBe('尚未发送的草稿')
    expect(running.cancel).toHaveBeenCalledTimes(1)
    expect(running.sendNow).toHaveBeenCalledTimes(2)
    expect(document.querySelector('.composer-queue-error')).toBeNull()

    running.removeQueued.mockImplementationOnce(async (itemId: string) => {
      pendingInputs = pendingInputs.filter((item) => item.itemId !== itemId)
      sequence++
      throw { data: { code: 'QUEUED_INPUT_GONE' } }
    })
    document
      .querySelector<HTMLButtonElement>('.composer-queue li:nth-child(2) .composer-queue-remove')
      ?.click()
    await vi.waitFor(() => expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(2))
    expect(document.querySelector('.composer-queue-error')?.textContent).toBe(
      '这条消息已开始执行或已不在队列中，列表会刷新。',
    )
    running.removeQueued.mockImplementation(async (itemId: string) => {
      pendingInputs = pendingInputs.filter((item) => item.itemId !== itemId)
      return ++sequence
    })
    for (const count of [1, 0]) {
      document.querySelector<HTMLButtonElement>('.composer-queue-remove')?.click()
      await vi.waitFor(() => expect(document.querySelectorAll('[data-queue-item]')).toHaveLength(count))
    }
    expect(document.querySelector('.composer-queue')).toBeNull()
    expect(composer.value).toBe('尚未发送的草稿')
    cancel.click()
    await vi.waitFor(() => expect(running.cancel).toHaveBeenCalledTimes(2))
    expect(running.prompt).not.toHaveBeenCalled()
  })
})

describe('queued input deletion', () => {
  it.each(['success', 'failure'] as const)(
    'allows deletion without a usable model and ignores a late old-session %s',
    async (outcome) => {
      installPublicFixture()
      const old = session('old', async () => ({
        ...idleTimeline('old', { route: 'removed', id: 'missing-model' }),
        pendingInputs: [{ itemId: 'shared-id', preview: 'old input' }],
      }))
      let nextQueue = [{ itemId: 'shared-id', preview: 'next input' }]
      let seq = 0
      const next = session('next', async () => ({
        ...idleTimeline('next'),
        upto: seq,
        pendingInputs: nextQueue,
      }))
      const oldRemoval = deferred<number>()
      const nextRemoval = deferred<number>()
      old.removeQueued.mockImplementation(() => oldRemoval.promise)
      next.removeQueued.mockImplementation(() => nextRemoval.promise)
      sdk.createClient.mockReturnValue({
        apis: vi.fn(async () => ({ profile: { models: [] } })),
        approval: { decide: vi.fn(async () => undefined) },
        close: vi.fn(async () => undefined),
        config: {
          get: vi.fn(async () => ({ configured: outcome === 'failure' })),
          providers: vi.fn(async () => ({ providers: [] })),
        },
        initialize: vi.fn(async () => undefined),
        on: vi.fn(),
        workspace: { list: vi.fn(async () => ({ items: [] })) },
        session: {
          list: vi.fn(async () => ({ items: [{ sessionId: 'old' }, { sessionId: 'next' }] })),
          load: vi.fn(async (id: string) => (id === 'old' ? old : next)),
        },
      })
      binding.loadWebSession.mockImplementation(async (_load: unknown, id: string) => ({
        session: id === 'old' ? old : next,
        offPermission: vi.fn(),
      }))
      binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
        session: selected,
        offPermission: vi.fn(),
      }))
      await import('../src/app.js')
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLButtonElement>('.composer-queue-remove')?.disabled).toBe(false),
      )
      expect(document.querySelector<HTMLButtonElement>('.composer-queue-send')?.disabled).toBe(true)
      document.querySelector<HTMLButtonElement>('.composer-queue-remove')?.click()
      expect(old.removeQueued).toHaveBeenCalledExactlyOnceWith('shared-id')
      document.querySelector<HTMLButtonElement>('[data-session="next"]')?.click()
      await vi.waitFor(() =>
        expect(document.querySelector('.composer-queue-preview')?.textContent).toBe('next input'),
      )
      document.querySelector<HTMLButtonElement>('.composer-queue-remove')?.click()
      expect(next.removeQueued).toHaveBeenCalledExactlyOnceWith('shared-id')
      if (outcome === 'success') oldRemoval.resolve(1)
      else oldRemoval.reject(new Error('late old-session refusal'))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const remove = document.querySelector<HTMLButtonElement>('.composer-queue-remove')
      expect(remove?.disabled).toBe(true)
      expect(remove?.getAttribute('aria-busy')).toBe('true')
      expect(document.querySelector('.composer-queue-preview')?.textContent).toBe('next input')
      expect(document.querySelector('.composer-queue-error')).toBeNull()
      nextQueue = []
      nextRemoval.resolve(++seq)
      await vi.waitFor(() => expect(document.querySelector('.composer-queue')).toBeNull())
      expect(old.cancel).not.toHaveBeenCalled()
      expect(next.cancel).not.toHaveBeenCalled()
    },
  )
})

describe('composer draft persistence', () => {
  it('keeps a draft after a failed send but never revives a sent prompt when the page unloads mid-run', async () => {
    installPublicFixture()
    const old = session('old', async () => idleTimeline('old'))
    const inFlight = deferred<undefined>()
    const unloading = deferred<undefined>()
    old.prompt
      .mockRejectedValueOnce(new Error('prompt rejected'))
      .mockImplementationOnce(() => inFlight.promise)
      .mockImplementationOnce(() => unloading.promise)
    const client = {
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      approval: { decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: { list: vi.fn(async () => ({ items: [{ sessionId: 'old' }] })), load: vi.fn(async () => old) },
    }
    sdk.createClient.mockReturnValue(client)
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))
    await import('../src/app.js')
    const composer = document.getElementById('prompt') as HTMLTextAreaElement
    const draftKey = 'agnes-web-composer-draft'
    const type = (text: string) => {
      composer.value = text
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await vi.waitFor(() => expect(composer.disabled).toBe(false))

    // A rejected send is a failure the user can retry: the draft comes back and stays stored.
    type('一段较长的任务提示词')
    document
      .getElementById('composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(old.prompt).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(composer.value).toBe('一段较长的任务提示词'))
    expect(sessionStorage.getItem(draftKey)).toBe('一段较长的任务提示词')

    // Preserve a later draft if the in-flight message is rejected.
    document
      .getElementById('composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(old.prompt).toHaveBeenCalledTimes(2))
    expect(composer.value).toBe('')
    expect(sessionStorage.getItem(draftKey)).toBeNull()
    type('下一条草稿')
    inFlight.reject(new Error('provider rejected image input'))
    await vi.waitFor(() => expect(composer.value).toBe('一段较长的任务提示词\n下一条草稿'))
    expect(sessionStorage.getItem(draftKey)).toBe('一段较长的任务提示词\n下一条草稿')

    // The third prompt was accepted and is in flight. Unloading is not a failed send and must not
    // revive its contents.
    document
      .getElementById('composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(old.prompt).toHaveBeenCalledTimes(3))
    expect(composer.value).toBe('')
    expect(sessionStorage.getItem(draftKey)).toBeNull()
    window.dispatchEvent(new Event('pagehide'))
    unloading.reject(new Error('transport closed'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(composer.value).toBe('')
    expect(sessionStorage.getItem(draftKey)).toBeNull()
  })
})

describe('image composer submissions', () => {
  const imagePngData =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const imagePngBytes = Uint8Array.from(atob(imagePngData), (character) => character.charCodeAt(0))

  async function start(
    sessionValue: SessionDouble,
    busy = false,
    inputModes: readonly ('text' | 'image')[] = ['text', 'image'],
  ): Promise<void> {
    installPublicFixture()
    const imageUrl = `blob:${sessionValue.id}-image`
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => imageUrl) })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({
        profile: { models: [{ route: 'local', id: 'model-a', input: inputModes }] },
      })),
      approval: { decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: {
        list: vi.fn(async () => ({ items: [{ sessionId: sessionValue.id }] })),
        load: vi.fn(async () => sessionValue),
      },
    })
    binding.loadWebSession.mockResolvedValue({ session: sessionValue, offPermission: vi.fn() })
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))
    await import('../src/app.js')
    const send = document.getElementById('send') as HTMLButtonElement
    await vi.waitFor(() =>
      expect((document.getElementById('prompt') as HTMLTextAreaElement).disabled).toBe(false),
    )
    if (busy) await vi.waitFor(() => expect(send.dataset.mode).toBe('busy'))
  }

  async function attachPng(
    accepted = true,
    file = new File([imagePngBytes], 'one.png', { type: 'image/png' }),
  ): Promise<void> {
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')
    expect(prompt).not.toBeNull()
    if (!prompt) throw new Error('composer input is missing')
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [file],
        items: [],
        getData: () => '',
      },
    })
    prompt.dispatchEvent(event)
    if (accepted)
      await vi.waitFor(() => expect(document.querySelector('.composer-image-preview img')).not.toBeNull())
  }

  it.each(['PNG', '10 MiB JPEG'])(
    'enables and sends a %s without text through session.prompt',
    async (format) => {
      const active = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
      await start(active)
      let bytes = imagePngBytes
      let mimeType = 'image/png'
      if (format === '10 MiB JPEG') {
        bytes = new Uint8Array(10 * 1024 * 1024)
        bytes.set([
          0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0,
        ])
        bytes.set([0xff, 0xd9], bytes.length - 2)
        mimeType = 'image/jpeg'
      }
      await attachPng(true, new File([bytes], 'image', { type: mimeType }))

      const send = document.getElementById('send') as HTMLButtonElement
      expect(send.disabled).toBe(false)
      submit('')

      await vi.waitFor(() => expect(active.prompt).toHaveBeenCalledTimes(1))
      expect(active.prompt).toHaveBeenCalledWith(
        [{ type: 'image', mimeType, data: Buffer.from(bytes).toString('base64') }],
        { titleLocale: 'zh-CN' },
      )
    },
  )

  it('sends mixed text and images through session.followUp and restores both on failure', async () => {
    const active = session('old', async () => busyTimeline('old', { route: 'local', id: 'model-a' }))
    active.followUp.mockRejectedValueOnce(new Error('follow-up rejected'))
    await start(active, true)
    await attachPng()
    const draft = document.getElementById('prompt') as HTMLTextAreaElement
    draft.value = '请解释这张图'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    submit('请解释这张图')

    await vi.waitFor(() => expect(active.followUp).toHaveBeenCalledTimes(1))
    expect(active.followUp).toHaveBeenCalledWith([
      { type: 'text', text: '请解释这张图' },
      { type: 'image', mimeType: 'image/png', data: imagePngData },
    ])
    await vi.waitFor(() => expect(draft.value).toBe('请解释这张图'))
    expect(document.querySelector('.composer-image-preview img')).not.toBeNull()
    expect(document.getElementById('notice')?.textContent).toContain('follow-up rejected')
  })

  it('accepts an image as a file attachment when the selected model has only text input', async () => {
    const active = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
    await start(active, false, ['text'])
    await attachPng(false)
    await vi.waitFor(() => expect(document.querySelector('.composer-file-preview')).not.toBeNull())

    expect((document.getElementById('send') as HTMLButtonElement).disabled).toBe(false)
    expect(document.querySelector('.composer-image-preview img')).toBeNull()
    expect(document.getElementById('composer-attach')?.getAttribute('aria-disabled')).toBe('false')
    submit('')
    await vi.waitFor(() =>
      expect(active.prompt).toHaveBeenCalledWith(
        [{ type: 'file', name: 'one.png', mimeType: 'image/png', data: imagePngData }],
        { titleLocale: 'zh-CN' },
      ),
    )
  })

  it('keeps text and attachments when batch validation fails before sending', async () => {
    const active = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
    await start(active)
    await attachPng()
    const protocol = await import('@agnes/protocol')
    const validation = vi.spyOn(protocol, 'decodeSafeImages').mockImplementationOnce(() => {
      throw new Error('images exceed aggregate pixel limit')
    })
    submit('保留文字和图片')
    expect(active.prompt).not.toHaveBeenCalled()
    expect((document.getElementById('prompt') as HTMLTextAreaElement).value).toBe('保留文字和图片')
    expect(document.querySelector('.composer-image-preview img')).not.toBeNull()
    expect(document.getElementById('notice')?.textContent).toContain('aggregate pixel limit')
    validation.mockRestore()
    submit('保留文字和图片')
    await vi.waitFor(() => expect(active.prompt).toHaveBeenCalledTimes(1))
  })

  it('names an attachment refusal in the interface language instead of the validator’s English', async () => {
    const active = session('old', async () => idleTimeline('old', { route: 'local', id: 'model-a' }))
    await start(active)
    await attachPng()
    const protocol = await import('@agnes/protocol')
    // 同一个「附件过多」有两处报出：输入框侧取词条，提交侧此前只能原样转发英文。用真实校验器造一个
    // 带 code 的实例，断言就不必依赖 protocol-validation 的内部类。
    const tooMany = raisedBy(() =>
      protocol.validateUserAttachments(
        Array.from({ length: protocol.USER_MESSAGE_ATTACHMENT_LIMITS.maxCount + 1 }, () => ({
          type: 'file',
          name: 'a.txt',
          mimeType: 'text/plain',
          data: 'eA==',
        })),
      ),
    )
    const validation = vi.spyOn(protocol, 'validateUserAttachments').mockImplementationOnce(() => {
      throw tooMany
    })
    submit('带附件发送')

    expect(active.prompt).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(document.getElementById('notice')?.textContent).toContain('一条消息最多添加 50 个附件。'),
    )
    expect(document.getElementById('notice')?.textContent).not.toContain(
      'A message can hold at most 50 attachments.',
    )
    validation.mockRestore()
  })

  it('keeps an image draft and refuses a WebSocket frame that exceeds the transport limit', async () => {
    const active = session('old', async () => busyTimeline('old', { route: 'local', id: 'model-a' }))
    await start(active, true)
    await attachPng()
    const longText = 'x'.repeat(MAX_FRAME_BYTES)
    submit(longText)

    expect(active.followUp).not.toHaveBeenCalled()
    expect((document.getElementById('prompt') as HTMLTextAreaElement).value).toBe(longText)
    expect(document.querySelector('.composer-image-preview img')).not.toBeNull()
    expect(document.getElementById('notice')?.textContent).toContain('144 MiB 限制')
  })
})

describe('web model confirmation', () => {
  it('preserves the confirmed model after a failed switch and ignores an old session response', async () => {
    installPublicFixture()
    const old = session('old', async () =>
      idleTimeline('old', { route: 'account-acct-private', id: 'model-a' }),
    )
    const next = session('next', async () => idleTimeline('next'))
    const oldResponse = deferred<{ effectiveFromSeq: number }>()
    old.setModel
      .mockImplementationOnce(async () => {
        throw new Error('model switch failed')
      })
      .mockImplementationOnce(() => oldResponse.promise)
    sdk.createClient.mockReturnValue({
      apis: vi.fn(async () => ({
        profile: {
          models: [
            { route: 'local', id: 'model-a' },
            { route: 'local', id: 'model-b' },
          ],
        },
      })),
      approval: { decide: vi.fn(async () => undefined) },
      close: vi.fn(async () => undefined),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
        save: vi.fn(async () => ({ configured: true })),
        test: vi.fn(async () => ({ verified: true, models: [] })),
      },
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      workspace: {
        list: vi.fn(async () => ({ items: [] })),
        add: vi.fn(async (path: string) => ({
          workspace: { path, name: 'agnes', lastUsedAt: null, sessionCount: 0, available: true },
        })),
      },
      session: {
        list: vi.fn(async () => ({
          items: [
            { sessionId: 'old', title: '现有任务' },
            { sessionId: 'next', title: '新任务' },
          ],
        })),
        load: vi.fn(async (id: string) => (id === 'old' ? old : next)),
        new: vi.fn(),
      },
    })
    binding.loadWebSession.mockImplementation(async (_load: unknown, id: string) => ({
      session: id === 'old' ? old : next,
      offPermission: vi.fn(),
    }))
    binding.bindWebSession.mockImplementation((selected: SessionDouble) => ({
      session: selected,
      offPermission: vi.fn(),
    }))

    await import('../src/app.js')
    const model = document.getElementById('model') as HTMLButtonElement
    await vi.waitFor(() => expect(model.disabled).toBe(false))
    expect(model.querySelector('[data-model-label]')?.textContent).toBe('model-a')
    expect(model.getAttribute('aria-label')).toBe('当前会话模型：model-a')

    model.click()
    openModelList()
    modelMenu().querySelectorAll<HTMLElement>('[role="option"]')[1]?.click()
    await vi.waitFor(() => expect(old.setModel).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(document.getElementById('notice')?.dataset.kind).toBe('error'))
    expect(model.querySelector('[data-model-label]')?.textContent).toBe('model-a')
    expect(model.getAttribute('aria-label')).not.toContain('account-acct-private')

    modelMenu().querySelectorAll<HTMLElement>('[role="option"]')[1]?.click()
    await vi.waitFor(() => expect(old.setModel).toHaveBeenCalledTimes(2))
    expect(model.disabled).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-session="next"]')?.click()
    await vi.waitFor(() => expect(next.projectUIOpening).toHaveBeenCalled())
    oldResponse.resolve({ effectiveFromSeq: 9 })

    await vi.waitFor(() => expect(model.disabled).toBe(false))
    expect(model.querySelector('[data-model-label]')?.textContent).toBe('选择模型')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(old.setModel).toHaveBeenCalledTimes(2)
  })
})

describe('session action review regressions', () => {
  /** 菜单项只在展开后存在（面板挂在 body 上），可访问名来自可见文字，所以按角色 + 文字定位。 */
  const menuItem = (label: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent === label,
    )

  async function boot(paged: { value: boolean }, narrow = false) {
    installPublicFixture()
    if (narrow)
      vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({
          matches: query.includes('max-width'),
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      )
    const on = vi.fn()
    let title = '改名前'
    const old = session('old', async () => idleTimeline('old'))
    const rename = vi.fn(async (_id: string, value: string) => {
      title = value
      paged.value = true
      return { title, archived: false }
    })
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(async () => undefined),
      on,
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: {
        rename,
        load: vi.fn(async () => old),
        list: vi.fn(async (query: { q?: unknown }) =>
          paged.value && !query.q
            ? {
                items: Array.from({ length: 100 }, (_, i) => ({
                  sessionId: `recent-${i}`,
                  title: `近期 ${i}`,
                })),
                next: 'page2',
              }
            : { items: [{ sessionId: 'old', title }] },
        ),
      },
    })
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await import('../src/app.js')
    await vi.waitFor(() => expect(document.getElementById('task-title')?.textContent).toBe('改名前'))
    return { old, rename, on }
  }

  it('retains a renamed paged-out current session through the next transcript render', async () => {
    const { rename, old, on } = await boot({ value: false })
    // 菜单项只在展开后存在（面板挂在 body 上），所以先点开触发按钮。
    document.querySelector<HTMLButtonElement>('[data-session-action-id="old"]')?.click()
    menuItem('重命名')?.click()
    const dialog = document.querySelector('.session-rename-dialog') as HTMLDialogElement
    ;(dialog.querySelector('input') as HTMLInputElement).value = '改名后'
    dialog.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(rename).toHaveBeenCalledOnce()
    expect(document.getElementById('task-title')?.textContent).toBe('改名后')
    const prior = old.projectUIOpening.mock.calls.length
    on.mock.calls.find(([event]) => event === 'gap')?.[1]({ sessionId: 'old', earliestSeq: 1 })
    // A gap reopens the bounded window; it no longer reads the whole projection.
    await vi.waitFor(() => expect(old.projectUIOpening.mock.calls.length).toBeGreaterThan(prior))
    await vi.waitFor(() => expect(document.getElementById('task-title')?.textContent).toBe('改名后'))
    expect(document.querySelector('[data-session="old"]')?.textContent).toBe('改名后')
  })

  it('reveals sidebar failures to narrow-screen users and restores keyboard focus', async () => {
    await boot({ value: false }, true)
    document.getElementById('sidebar-toggle')?.click()
    expect(document.querySelector('main')?.inert).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-session-action-id="old"]')?.click()
    menuItem('分叉会话')?.click()
    await vi.waitFor(() => expect(document.getElementById('notice')?.textContent).toContain('没有可分叉'))
    expect(document.body.classList.contains('sidebar-open')).toBe(false)
    expect(document.querySelector('main')?.inert).toBe(false)
    expect(document.activeElement).toBe(document.getElementById('sidebar-toggle'))
  })
})

describe('sidebar recency', () => {
  it('re-lists after a user message so the chatted session moves up', async () => {
    installPublicFixture()
    const old = session('old', async () => idleTimeline('old'))
    const arrival = deferred<IteratorResult<unknown>>()
    let pulls = 0
    old.events.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: () => (pulls++ === 0 ? arrival.promise : new Promise(() => undefined)),
        return: async () => ({ done: true, value: undefined }),
      }),
    })
    let chatted = false
    const list = vi.fn(async () => ({
      items: chatted
        ? [
            { sessionId: 'old', title: '旧任务' },
            { sessionId: 'other', title: '别的任务' },
          ]
        : [
            { sessionId: 'other', title: '别的任务' },
            { sessionId: 'old', title: '旧任务' },
          ],
    }))
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(async () => undefined),
      on: vi.fn(),
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: { list, load: vi.fn(async () => old) },
    })
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await import('../src/app.js')
    const order = () =>
      [...document.querySelectorAll<HTMLElement>('#sessions [data-session]')].map((b) => b.dataset.session)
    await vi.waitFor(() => expect(document.getElementById('task-title')?.textContent).toBe('旧任务'))
    expect(order()).toEqual(['other', 'old'])
    const before = list.mock.calls.length
    chatted = true
    arrival.resolve({ done: false, value: { type: 'user/message', seq: 9, data: {} } })
    await vi.waitFor(() => expect(order()).toEqual(['old', 'other']))
    expect(list.mock.calls.length).toBe(before + 1)
  })
})

describe('incremental opening', () => {
  async function bootWith(
    opening: () => Promise<UITimeline>,
    titled = true,
    configure?: (old: SessionDouble) => void,
    clientOverrides: Record<string, unknown> = {},
  ) {
    installPublicFixture()
    const on = vi.fn()
    const old = session('old', opening)
    configure?.(old)
    const list = vi.fn(async (_query?: { q?: { prefix?: string } }) => ({
      items: [{ sessionId: 'old', ...(titled ? { title: '旧任务' } : {}) }],
    }))
    sdk.createClient.mockReturnValue({
      initialize: vi.fn(async () => undefined),
      on,
      close: vi.fn(async () => undefined),
      apis: vi.fn(async () => ({ profile: { models: [{ route: 'local', id: 'model-a' }] } })),
      config: {
        get: vi.fn(async () => ({ configured: true })),
        providers: vi.fn(async () => ({ providers: [] })),
      },
      workspace: { list: vi.fn(async () => ({ items: [] })) },
      session: { list, load: vi.fn(async () => old) },
      ...clientOverrides,
    })
    binding.loadWebSession.mockResolvedValue({ session: old, offPermission: vi.fn() })
    await import('../src/app.js')
    const emit = (event: string, payload: unknown) =>
      on.mock.calls.find(([name]) => name === event)?.[1](payload)
    return { old, list, emit }
  }

  const finishedTurn: UITimeline['turns'][number] = {
    id: 'turn:1',
    turn: 1,
    startSeq: 1,
    endSeq: 4,
    startedAt: '2026-09-24T00:00:00.000Z',
    status: 'completed',
    reason: 'completed',
    nodeIds: [],
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: false,
      calls: [],
    },
    inherited: false,
    forkable: true,
  }

  it('opens with one bounded opening and no full projection, and seeds the run receipt from the last turn', async () => {
    const { old } = await bootWith(async () => ({ ...idleTimeline('old'), upto: 4, turns: [finishedTurn] }))
    await vi.waitFor(() => expect(document.getElementById('status')?.textContent).toBe('已完成'))
    expect(old.projectUIOpening).toHaveBeenCalledTimes(1)
    expect(old.projectUI).not.toHaveBeenCalled()
    expect(old.events).toHaveBeenCalledWith({ preview: true, cursor: { fromSeq: 4, generation: 1 } })
  })

  it('asks for a title once when the seeded last turn completed and the session has none', async () => {
    const { list } = await bootWith(
      async () => ({ ...idleTimeline('old'), upto: 4, turns: [finishedTurn] }),
      false,
    )
    await vi.waitFor(() => expect(list.mock.calls.some(([query]) => query?.q !== undefined)).toBe(true))
    const lookups = () => list.mock.calls.filter(([query]) => query?.q?.prefix === 'old').length
    const first = lookups()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lookups()).toBe(first)
  })

  it('shows session recovery when the first opening is refused', async () => {
    await bootWith(async () => {
      throw Object.assign(new Error('too large'), { data: { code: 'UI_PROJECTION_NODE_TOO_LARGE' } })
    })
    const notice = document.getElementById('notice') as HTMLElement
    await vi.waitFor(() => expect(notice.dataset.kind).toBe('session-recovery'))
  })

  it('points to a pending approval before the loaded window without offering a verdict', async () => {
    await bootWith(async () => ({
      ...idleTimeline('old'),
      upto: 9,
      opState: {
        turn: 1,
        step: 1,
        phase: 'tools',
        parked: { ticket: 't-1', expiresAt: '2026-09-25T00:00:00Z' },
      },
    }))
    const approval = document.getElementById('approval') as HTMLElement
    await vi.waitFor(() => expect(approval.textContent).toContain('有一项审批等待处理'))
    const buttons = [...approval.querySelectorAll('button')].map((button) => button.textContent)
    expect(buttons).toEqual(['定位审批'])
  })

  const parkedTimeline = (): UITimeline => ({
    ...idleTimeline('old'),
    upto: 9,
    opState: {
      turn: 1,
      step: 1,
      phase: 'tools',
      parked: { ticket: 't-1', expiresAt: '2026-09-25T00:00:00Z' },
    },
  })

  it('says it is looking while it loads earlier pages for a pending approval', async () => {
    await bootWith(
      async () => parkedTimeline(),
      true,
      (old) => {
        old.projectUIOpening.mockImplementation(async () => ({
          timeline: parkedTimeline(),
          history: { hasEarlier: true, startIndex: 3, totalNodes: 3, cursor: 'c' },
        }))
        old.projectUIHistory.mockImplementation(() => new Promise(() => undefined))
      },
    )
    const approval = document.getElementById('approval') as HTMLElement
    await vi.waitFor(() => expect(approval.textContent).toContain('正在查找'))
    expect(approval.querySelectorAll('button')).toHaveLength(0)
  })

  describe('recovery after the connection is gone', () => {
    // The fixture page carries the unreplaced marker as its daemon address.
    const page = (ws: string) => new Response(`<meta id="agnes-config" data-ws="${ws}" />`, { status: 200 })
    const samePage = () => page('__AGNES_WS_URL__')
    const newPage = () => page('ws://127.0.0.1:1/')
    const probes = (fetcher: { mock: { calls: unknown[][] } }) =>
      fetcher.mock.calls.filter(([input]) => input === '/').length
    let reload: { mockRestore(): void; mock: { calls: unknown[][] } }
    beforeEach(() => {
      reload = vi.spyOn(location, 'reload').mockImplementation(() => undefined)
    })
    afterEach(() => {
      vi.useRealTimers()
      reload.mockRestore()
    })

    it('reloads once the Web page serves a new daemon address, never into the old one', async () => {
      const { emit } = await bootWith(async () => idleTimeline('old'))
      const connection = document.getElementById('connection') as HTMLElement
      await vi.waitFor(() => expect(connection.dataset.state).toBe('connected'))
      const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 502 }))
      vi.stubGlobal('fetch', fetcher)
      emit('closed', { reason: 'closed' })
      // Two probes land at 0.5 s and 1.5 s; the server is still down, so the page must stay put.
      await new Promise((resolve) => setTimeout(resolve, 1700))
      expect(reload.mock.calls.length).toBe(0)
      expect(probes(fetcher)).toBe(2)
      const status = document.getElementById('reconnect-notice') as HTMLElement
      const notice = document.getElementById('notice') as HTMLElement
      expect(status.hidden).toBe(false)
      expect(connection.dataset.state).toBe('reconnecting')
      // The notice states the fact without contradicting the automatic recovery.
      expect(notice.textContent).not.toContain('重新运行')
      // A Web process that outlived the daemon still serves the old address: no reload into it.
      fetcher.mockImplementation(async () => samePage())
      await vi.waitFor(() => expect(probes(fetcher)).toBe(3), { timeout: 4000 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(reload.mock.calls.length).toBe(0)
      fetcher.mockImplementation(async () => newPage())
      await vi.waitFor(() => expect(reload.mock.calls.length).toBe(1), { timeout: 5000 })
      expect(status.textContent).toContain('正在重新载入')
    }, 20_000)

    it('starts recovering when the first connection fails', async () => {
      const fetcher = vi.fn<typeof fetch>(async () => newPage())
      await bootWith(async () => idleTimeline('old'), true, undefined, {
        initialize: vi.fn(async () => {
          throw new Error('connect failed')
        }),
      })
      vi.stubGlobal('fetch', fetcher)
      const status = document.getElementById('reconnect-notice') as HTMLElement
      await vi.waitFor(() => expect(status.hidden).toBe(false))
      await vi.waitFor(() => expect(reload.mock.calls.length).toBe(1), { timeout: 4000 })
    }, 15_000)

    it('keeps a retry control through later errors, retries by hand, and resumes when shown again', async () => {
      const { emit } = await bootWith(async () => idleTimeline('old'))
      const connection = document.getElementById('connection') as HTMLElement
      await vi.waitFor(() => expect(connection.dataset.state).toBe('connected'))
      const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 502 }))
      vi.stubGlobal('fetch', fetcher)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      emit('closed', { reason: 'closed' })
      await vi.advanceTimersByTimeAsync(65_000)
      const status = document.getElementById('reconnect-notice') as HTMLElement
      const retry = status.querySelector('button')
      expect(retry?.textContent).toBe('重试连接')
      expect(connection.dataset.state).toBe('closed')
      // A later message rewrites the notice, not the recovery status.
      emit('gap', { sessionId: 'old', earliestSeq: 1 })
      const notice = document.getElementById('notice') as HTMLElement
      expect(notice.textContent).toContain('部分历史事件')
      expect(status.querySelector('button')).toBe(retry)
      // Showing the tab again resumes automatic probing, which still refuses the old address.
      fetcher.mockImplementation(async () => samePage())
      const before = probes(fetcher)
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
      expect(probes(fetcher)).toBe(before + 1)
      expect(reload.mock.calls.length).toBe(0)
      await vi.advanceTimersByTimeAsync(65_000)
      // The retry button accepts any served page, for a restart that reused the same address.
      status.querySelector('button')?.click()
      await vi.advanceTimersByTimeAsync(0)
      expect(reload.mock.calls.length).toBe(1)
    }, 15_000)
  })

  it('looks for the approval again after a reopen, and ignores gaps of other sessions', async () => {
    const { old, emit } = await bootWith(async () => parkedTimeline())
    const approval = document.getElementById('approval') as HTMLElement
    await vi.waitFor(() => expect(approval.textContent).toContain('有一项审批等待处理'))
    const openings = old.projectUIOpening.mock.calls.length
    emit('gap', { sessionId: 'other', earliestSeq: 1 })
    emit('generationChanged', { sessionId: 'other', generation: 2 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(old.projectUIOpening.mock.calls.length).toBe(openings)
    // The reopened window may reach further back, so the search starts over.
    old.projectUIOpening.mockImplementation(async () => ({
      timeline: parkedTimeline(),
      history: { hasEarlier: true, startIndex: 3, totalNodes: 3, cursor: 'c' },
    }))
    old.projectUIHistory.mockImplementation(() => new Promise(() => undefined))
    emit('gap', { sessionId: 'old', earliestSeq: 1 })
    await vi.waitFor(() => expect(old.projectUIOpening.mock.calls.length).toBe(openings + 1))
    await vi.waitFor(() => expect(approval.textContent).toContain('正在查找'))
  })
})

it('renders Computer Use in the application and retires its late operation reply on pagehide', async () => {
  installPublicFixture()
  history.replaceState(null, '', '/#test-launcher-token')
  let finish!: (value: unknown) => void
  const pending = new Promise<unknown>((resolvePromise) => {
    finish = resolvePromise
  })
  const call = vi.fn(async (method: string) => {
    if (method.endsWith('operation.start')) return pending
    if (method.endsWith('operation.status')) return { status: 'not-found' }
    if (method.endsWith('permissions.status')) return { status: 'granted' }
    return {
      status: 'ready',
      driver: { platform: 'darwin', version: 'fixture' },
      runtime: { state: 'idle', startAttempted: false },
    }
  })
  sdk.createClient.mockReturnValue({
    call,
    initialize: vi.fn(async () => undefined),
    on: vi.fn(),
    close: vi.fn(async () => undefined),
    apis: vi.fn(async () => ({ profile: { models: [] } })),
    config: {
      get: vi.fn(async () => ({ configured: true })),
      providers: vi.fn(async () => ({ providers: [] })),
    },
    workspace: { list: vi.fn(async () => ({ items: [] })) },
    session: { list: vi.fn(async () => ({ items: [] })) },
  })
  await import('../src/app.js')
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLButtonElement>('#computer-use-update')?.disabled).toBe(false),
  )
  document.querySelector<HTMLButtonElement>('#computer-use-management')?.click()
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLElement>('#computer-use-settings-pane')?.hidden).toBe(false),
  )
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLButtonElement>('#computer-use-update')?.disabled).toBe(false),
  )
  document.querySelector<HTMLButtonElement>('#computer-use-update')?.click()
  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith('_agnes/v1/computerUse.operation.start', { kind: 'update' }),
  )
  window.dispatchEvent(new Event('pagehide'))
  const pane = document.getElementById('computer-use-settings-pane')
  const before = pane?.innerHTML
  const requests = call.mock.calls.length
  finish({ status: 'found', operationId: 'retired', kind: 'update', state: 'running', phase: 'installing' })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  expect(pane?.innerHTML).toBe(before)
  expect(call.mock.calls).toHaveLength(requests)
  expect(call.mock.calls.some(([method]) => method.endsWith('operation.cancel'))).toBe(false)
})
