import { EventEmitter } from 'node:events'
import { validateAgainst } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'

// The distributed plugin is plain ESM and is tested through its public runtime behavior.
const { BrowserRuntime } = await import(
  new URL('../bundled-plugins/browser/src/runtime.mjs', import.meta.url).href
)
const { browserUrl, browserInstructions, failure } = await import(
  new URL('../bundled-plugins/browser/src/policy.mjs', import.meta.url).href
)
const { showPage, showView, selectView, showPages, acceptInput } = await import(
  new URL('../bundled-plugins/browser/src/streams.mjs', import.meta.url).href
)
const pinnedStreams = new URL('../bundled-plugins/browser/src/streams.mjs', import.meta.url)
pinnedStreams.search = '?session-composition'
const { selectView: selectPinnedView } = await import(pinnedStreams.href)
const { parameters } = await import(
  new URL('../bundled-plugins/browser/src/contracts.mjs', import.meta.url).href
)
const { main } = await import(new URL('../bundled-plugins/browser/index.mjs', import.meta.url).href)
const { interact } = await import(
  new URL('../bundled-plugins/browser/src/interaction.mjs', import.meta.url).href
)

it('prepares interaction without takeover, rejects foreign/stale input and preserves control across lease renewal', async () => {
  const { runtime, session, pages } = fixture()
  const page = await runtime.act(session, { action: 'open', url: 'http://localhost/' })
  const foreign = fixture()
  const other = await foreign.runtime.act(
    { key: 'other', lane: 'main' },
    { action: 'open', url: 'http://localhost/' },
  )
  const open = (grantId = 'grant') => {
    const abort = new AbortController()
    let receive!: (frame: unknown) => void
    const responses: Record<string, any>[] = []
    interact(
      runtime,
      {},
      {
        scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
        actor: { id: 'viewer' },
        control: { grantId, expiresAt: Date.now() + 30_000 },
        signal: abort.signal,
        stream: {
          onFrame(fn: typeof receive) {
            receive = fn
          },
          onDisconnect() {},
          send(frame: Record<string, any>) {
            responses.push(frame)
          },
        },
      },
    )
    let id = 0
    return {
      abort,
      async send(frame: object) {
        const requestId = ++id
        receive({ ...frame, id: requestId })
        await vi.waitFor(() => expect(responses.some((r) => r.id === requestId)).toBe(true))
        return responses.find((r) => r.id === requestId)!
      },
    }
  }
  const first = open()
  try {
    expect(runtime.get(session, page.pageId).mode).toBe('agent')
    expect(
      (await first.send({ type: 'control', pageId: other.pageId, pageEpoch: 0, mode: 'human' })).status,
    ).toBe('error')
    expect(
      (await first.send({ type: 'control', pageId: page.pageId, pageEpoch: 5, mode: 'human' })).code,
    ).toBe('STALE_INPUT')
    const result = (await first.send({ type: 'control', pageId: page.pageId, pageEpoch: 0, mode: 'human' }))
      .result
    const input = { type: 'text', text: '中文', pageEpoch: 0, controlEpoch: result.controlEpoch, seq: 0 }
    expect((await first.send({ type: 'input', pageId: page.pageId, input })).status).toBe('ok')
    const next = open()
    first.abort.abort()
    expect(runtime.get(session, page.pageId).mode).toBe('human')
    expect(
      (await next.send({ type: 'input', pageId: page.pageId, input: { ...input, seq: 1 } })).status,
    ).toBe('ok')
    expect(pages[0]!.keyboard.insertText).toHaveBeenCalledWith('中文')
    expect(
      (await next.send({ type: 'input', pageId: page.pageId, input: { ...input, seq: 2, pageEpoch: 99 } }))
        .code,
    ).toBe('STALE_INPUT')
    expect(
      (await next.send({ type: 'pause', pageId: page.pageId, controlEpoch: result.controlEpoch })).status,
    ).toBe('ok')
    expect(runtime.get(session, page.pageId).mode).toBe('agent')
    await expect(
      runtime.act(session, { action: 'key', pageId: page.pageId, pageEpoch: 0, key: 'Enter' }),
    ).rejects.toMatchObject({ code: 'STALE_TARGET' })
    Object.assign(pages[0]!, { screenshot: async () => new Uint8Array([1]) })
    await runtime.act(session, { action: 'screenshot', pageId: page.pageId })
    await runtime.act(session, { action: 'key', pageId: page.pageId, pageEpoch: 0, key: 'Enter' })
    expect(pages[0]!.keyboard.press).toHaveBeenCalledWith('Enter')
    next.abort.abort()
    expect(runtime.get(session, page.pageId).mode).toBe('agent')
    await runtime.closePage(session, page.pageId)
    expect(runtime.sessions.has(session.key)).toBe(false)
    expect(foreign.runtime.sessions.has('other')).toBe(true)
  } finally {
    first.abort.abort()
    await runtime.close()
    await foreign.runtime.close()
  }
})

it('coordinates native human input per page without a manual return and rejects stale observations', async () => {
  const { runtime, session, pages } = fixture()
  let now = 1000
  runtime.now = () => now
  const first = await runtime.act(session, { action: 'open', url: 'http://localhost/one' })
  const other = await runtime.act(session, { action: 'open', url: 'http://localhost/two' })
  const actor = { id: 'viewer' }
  const grant = await runtime.control(session, { pageId: first.pageId, mode: 'human' }, actor, {
    grantId: 'native',
    expiresAt: 100_000,
  })
  Object.assign(pages[0]!, { screenshot: async () => new Uint8Array([1]) })
  try {
    await runtime.humanInput(session, { ...grant, seq: 0, type: 'text', text: 'typing' }, actor)
    // A different page remains usable while the human is actively typing.
    await runtime.act(session, { action: 'key', pageId: other.pageId, pageEpoch: 0, key: 'Escape' })
    expect(pages[1]!.keyboard.press).toHaveBeenCalledWith('Escape')
    const abort = new AbortController()
    const waiting = runtime.act(
      session,
      { action: 'key', pageId: first.pageId, pageEpoch: 0, key: 'Enter' },
      abort.signal,
    )
    const cancelled = expect(waiting).rejects.toThrow()
    abort.abort()
    await cancelled
    now += 1000
    await expect(
      runtime.act(session, { action: 'key', pageId: first.pageId, pageEpoch: 0, key: 'Enter' }),
    ).rejects.toMatchObject({ code: 'STALE_TARGET' })
    const observed = await runtime.act(session, { action: 'screenshot', pageId: first.pageId })
    await runtime.act(session, { action: 'key', pageId: first.pageId, pageEpoch: 0, key: 'Enter' })
    expect(pages[0]!.keyboard.press).toHaveBeenCalledWith('Enter')
    // The human grant survives; only a gesture captured before the agent action is refused.
    await expect(
      runtime.humanInput(
        session,
        {
          ...grant,
          agentRevision: observed.agentRevision,
          seq: 1,
          type: 'click',
          x: 10,
          y: 10,
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'STALE_INPUT' })
    const current = runtime.describe(runtime.get(session, first.pageId))
    await runtime.humanInput(
      session,
      {
        ...grant,
        agentRevision: current.agentRevision,
        seq: 2,
        type: 'text',
        text: 'continue',
      },
      actor,
    )
    expect(pages[0]!.keyboard.insertText).toHaveBeenLastCalledWith('continue')
  } finally {
    await runtime.close()
  }
})

function pageFixture(context: object) {
  const main = {}
  const page = Object.assign(new EventEmitter(), {
    url: (): string => 'http://127.0.0.1:5173/',
    isClosed: () => false,
    goto: vi.fn(async () => {}),
    context: () => context,
    mainFrame: () => main,
    close: vi.fn(async (): Promise<void> => {
      page.emit('close')
    }),
    keyboard: { insertText: vi.fn(async () => {}), press: vi.fn(async () => {}), up: vi.fn(async () => {}) },
    mouse: { click: vi.fn(async () => {}), up: vi.fn(async () => {}), wheel: vi.fn(async () => {}) },
  })
  return page
}

function fixture() {
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => undefined),
    detach: vi.fn(async () => {}),
  })
  const context = Object.assign(new EventEmitter(), {
    route: vi.fn(async () => {}),
    routeWebSocket: vi.fn(async () => {}),
    close: vi.fn(async () => {
      for (const page of pages) await page.close()
    }),
    newCDPSession: vi.fn(async () => cdp),
    newPage: vi.fn(async (): Promise<ReturnType<typeof pageFixture>> => {
      const page = pageFixture(context)
      pages.push(page)
      context.emit('page', page)
      return page
    }),
  })
  const pages: ReturnType<typeof pageFixture>[] = []
  const browser = Object.assign(new EventEmitter(), {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {}),
  })
  const store = new Map<string, unknown>([['browser.enabled', false]])
  const runtime = new BrowserRuntime({
    launch: async () => browser,
    store: {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    },
  })
  const session = { key: 'one', lane: 'main' }
  return { runtime, browser, pages, cdp, context, session }
}

it('retargets an owned view without another stream, ignores stale selections and releases hidden capture', async () => {
  const { runtime, session, cdp } = fixture()
  const first = await runtime.act(session, { action: 'open', url: 'http://localhost/one' })
  const second = await runtime.act(session, { action: 'open', url: 'http://localhost/two' })
  const otherSession = { key: 'other', lane: 'main' }
  const otherPage = await runtime.act(otherSession, { action: 'open', url: 'http://localhost/other' })
  const abort = new AbortController()
  const listeners = new Set<() => void>()
  const frames: Buffer[] = []
  const stream = {
    send(frame: Buffer) {
      frames.push(frame)
      return 'accepted'
    },
    onDisconnect(fn: () => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    close() {
      for (const fn of [...listeners]) fn()
    },
  }
  const context = { session, actor: { id: 'viewer', org: 'one' } }
  const input = { viewId: 'view', pageId: second.pageId, sequence: 2 }
  try {
    await showView(
      runtime,
      { viewId: 'view', pageId: first.pageId },
      {
        scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
        actor: context.actor,
        signal: abort.signal,
        stream,
      },
    )
    await expect(selectView(runtime, input, { ...context, actor: { id: 'other' } })).rejects.toMatchObject({
      code: 'DENIED',
    })
    await expect(
      selectView(runtime, input, { ...context, actor: { id: 'viewer', org: 'other' } }),
    ).rejects.toMatchObject({ code: 'DENIED' })
    await expect(
      selectView(runtime, { ...input, pageId: otherPage.pageId }, { ...context, session: otherSession }),
    ).rejects.toMatchObject({ code: 'DENIED' })
    // Session composition may import a separate copy while sharing the managed resource.
    await selectPinnedView(runtime, input, context)
    await selectView(runtime, { ...input, pageId: first.pageId, sequence: 1 }, context)
    expect(runtime.get(session, first.pageId).capture).toBeUndefined()
    expect(runtime.get(session, first.pageId).viewers.size).toBe(0)
    cdp.emit('Page.screencastFrame', { sessionId: 1, data: Buffer.from('second-page').toString('base64') })
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      const size = frame.readUInt32BE(0)
      expect(JSON.parse(frame.subarray(4, 4 + size).toString()).pageId).toBe(second.pageId)
    }
    // Rapid selections settle on the latest page and retain one capture only.
    await Promise.all([
      selectView(runtime, { ...input, pageId: first.pageId, sequence: 3 }, context),
      selectView(runtime, { ...input, sequence: 4 }, context),
    ])
    expect(runtime.get(session, first.pageId).capture).toBeUndefined()
    expect(runtime.get(session, second.pageId).viewers.size).toBe(1)
    abort.abort()
    await vi.waitFor(() => expect(runtime.get(session, second.pageId).capture).toBeUndefined())
    expect(listeners.size).toBe(0)
    await expect(selectView(runtime, { ...input, sequence: 5 }, context)).rejects.toMatchObject({
      code: 'DENIED',
    })
  } finally {
    abort.abort()
    await runtime.close()
  }
})

it('returns known open refusals as terminal results while preserving uncertain or operating-system failures', async () => {
  const { runtime, session } = fixture()
  const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>()
  main.apply({
    profileRuntime: { register: () => ({ get: async () => runtime }), streams: { register() {} } },
    services: {
      register: (service: {
        name: string
        handler: (input: unknown, context: unknown) => Promise<unknown>
      }) => handlers.set(service.name, service.handler),
    },
    hooks: { register() {} },
    tools: { register() {} },
  })
  runtime.protectedOrigins.add('http://localhost:4180')
  const open = handlers.get('browser.open')!
  const context = { session, signal: new AbortController().signal }
  await expect(open({ url: 'http://localhost:4180/' }, context)).resolves.toEqual({
    status: 'refused',
    code: 'PROTECTED_TARGET',
  })
  expect(runtime.list(session)).toEqual([])
  const control = handlers.get('browser.control')!
  await expect(
    control(
      { pageId: 'closed-page', mode: 'human' },
      {
        ...context,
        actor: { id: 'synthetic' },
        controlGrant: { grantId: 'native-grant', expiresAt: Date.now() + 30_000 },
      },
    ),
  ).resolves.toEqual({ status: 'refused', code: 'PAGE_UNAVAILABLE' })
  await expect(open({ url: 'http://localhost:5173/' }, context)).resolves.toMatchObject({
    pageId: expect.any(String),
  })
  for (const error of [
    failure('UNCERTAIN', 'Inspect before retrying'),
    Object.assign(new Error('Pipe closed'), { code: 'EPIPE' }),
    Object.assign(new Error('Untrusted refusal-shaped failure'), { code: 'PROTECTED_TARGET' }),
  ]) {
    vi.spyOn(runtime, 'act').mockRejectedValueOnce(error)
    await expect(open({ url: 'http://localhost:5173/' }, context)).rejects.toBe(error)
  }
  vi.restoreAllMocks()
})

it('uses one exact Page for navigation, display frames and human input; rejects other sessions and replay', async () => {
  const { runtime, pages, cdp, context, session } = fixture()
  expect(runtime.status().enabled).toBe(true)
  runtime.state = 'preparing'
  await expect(runtime.act(session, { action: 'open', url: 'http://127.0.0.1:5173/' })).rejects.toMatchObject(
    { code: 'PREPARING' },
  )
  expect(runtime.status()).toMatchObject({ enabled: true, state: 'preparing', error: null })
  runtime.state = 'ready'
  const updates: { pages: { pageId: string }[] }[] = []
  const otherUpdates: { pages: { pageId: string }[] }[] = []
  const watch = (sessionId: string, send: (value: { pages: { pageId: string }[] }) => void) =>
    showPages(
      runtime,
      {},
      {
        scope: { kind: 'session', sessionId, laneId: 'main' },
        origin: 'http://127.0.0.1:4180',
        signal: new AbortController().signal,
        stream: { send, close: vi.fn(), onDisconnect: vi.fn() },
      },
    )
  watch(session.key, (value) => updates.push(value))
  watch('other', (value) => otherUpdates.push(value))
  for (const host of ['localhost', '127.0.0.1', '[::1]'])
    await expect(
      runtime.act(session, { action: 'open', url: `http://${host}:4180/admin/plugins` }),
    ).rejects.toMatchObject({ code: 'PROTECTED_TARGET' })
  const opened = await runtime.act(session, { action: 'open', url: 'http://127.0.0.1:5173/' })
  expect(updates.at(-1)!.pages[0]!.pageId).toBe(opened.pageId)
  expect(otherUpdates.every((value) => value.pages.length === 0)).toBe(true)
  const original = pages[0]!
  const sent: Uint8Array[] = []
  const stream = {
    send: (frame: Uint8Array) => {
      sent.push(frame)
      return 'accepted'
    },
    close: vi.fn(),
    onDisconnect: vi.fn(),
  }
  await showPage(
    runtime,
    { pageId: opened.pageId },
    {
      scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
      stream,
      signal: new AbortController().signal,
    },
  )
  expect(context.newCDPSession).toHaveBeenCalledWith(original)
  cdp.emit('Page.screencastFrame', { sessionId: 1, data: Buffer.from('same-page-pixels').toString('base64') })
  expect(sent).toHaveLength(1)
  const frame = Buffer.from(sent[0]!),
    size = frame.readUInt32BE()
  expect(JSON.parse(frame.subarray(4, size + 4).toString()).pageId).toBe(opened.pageId)
  expect(frame.subarray(size + 4).toString()).toBe('same-page-pixels')
  const otherTab = await runtime.act(session, { action: 'open', url: 'http://127.0.0.1:5173/second' })
  let listed = runtime.list(session)
  expect(listed.find((page: { pageId: string }) => page.pageId === otherTab.pageId).activity).toBeGreaterThan(
    listed[0].activity,
  )
  await runtime.act(session, { action: 'key', pageId: opened.pageId, pageEpoch: 0, key: 'Escape' })
  listed = runtime.list(session)
  expect(listed[0].activity).toBeGreaterThan(listed[1].activity)
  expect(() => runtime.get({ key: 'other', lane: 'main' }, opened.pageId)).toThrow()
  const actor = { id: 'local-user' }
  const control = await runtime.control(session, { pageId: opened.pageId, mode: 'human' }, actor)
  let disconnectInput: (() => void) | undefined
  const inputStream = {
    send: vi.fn(),
    onFrame: vi.fn(),
    onDisconnect(fn: () => void) {
      disconnectInput = fn
    },
    close: vi.fn(() => disconnectInput?.()),
  }
  runtime.get(session, opened.pageId).control.nativeId = 'admitted-control'
  acceptInput(
    runtime,
    { pageId: opened.pageId, mode: 'human' },
    {
      scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
      actor,
      control: { grantId: 'admitted-control' },
      stream: inputStream,
      signal: new AbortController().signal,
    },
  )
  const input = { ...control, seq: 1, type: 'text', text: '同一个页面' }
  await runtime.humanInput(session, input, actor)
  expect(original.keyboard.insertText).toHaveBeenCalledWith('同一个页面')
  for (let i = 0; i < 20; i++)
    original.emit('console', { type: () => 'error', text: () => '\0'.repeat(2000) })
  const errors = await runtime.act(session, { action: 'events', pageId: opened.pageId })
  expect(Buffer.byteLength(JSON.stringify(errors))).toBeLessThanOrEqual(65536)
  await expect(runtime.humanInput(session, input, actor)).rejects.toMatchObject({ code: 'STALE_INPUT' })
  runtime.now = () => Date.now() + 1000
  await expect(
    runtime.act(session, { action: 'key', pageId: opened.pageId, pageEpoch: 0, key: 'Enter' }),
  ).rejects.toMatchObject({ code: 'STALE_TARGET' })
  const beforeNavigation = sent.length
  original.emit('framenavigated', original.mainFrame())
  expect(sent).toHaveLength(beforeNavigation)
  await expect(runtime.humanInput(session, { ...input, seq: 2 }, actor)).rejects.toMatchObject({
    code: 'STALE_INPUT',
  })
  await runtime.close()
  expect(stream.close).toHaveBeenCalled()
  expect(inputStream.close).toHaveBeenCalled()
  await expect(runtime.humanInput(session, { ...input, seq: 2 }, actor)).rejects.toMatchObject({
    code: 'DISABLED',
  })
  expect(runtime.sessions.size).toBe(0)
})

it('revokes queued operations before shutdown and rejects old navigation epochs', async () => {
  const { runtime, pages, session } = fixture()
  const opened = await runtime.act(session, { action: 'open', url: 'http://127.0.0.1:5173/' })
  await expect(
    runtime.act(session, { action: 'key', pageId: opened.pageId, pageEpoch: 9, key: 'Enter' }),
  ).rejects.toMatchObject({ code: 'STALE_TARGET' })
  let release!: () => void
  const item = runtime.get(session, opened.pageId)
  item.queue = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = runtime.act(session, { action: 'key', pageId: opened.pageId, pageEpoch: 0, key: 'Enter' })
  const assertion = expect(pending).rejects.toMatchObject({ code: 'DISABLED' })
  await runtime.close()
  release()
  await assertion
  expect(pages[0]!.keyboard.press).not.toHaveBeenCalled()
})

it('rechecks queued human input and handovers after navigation, newer control requests and session closure', async () => {
  const { runtime, pages, session } = fixture()
  const opened = await runtime.act(session, { action: 'open', url: 'http://127.0.0.1:5173/' })
  const item = runtime.get(session, opened.pageId)
  const actor = { id: 'local-user' }
  const block = () => {
    let release!: () => void
    item.queue = new Promise<void>((resolve) => {
      release = resolve
    })
    return () => release()
  }
  const control = await runtime.control(session, { pageId: opened.pageId, mode: 'human' }, actor)
  let release = block()
  const input = runtime.humanInput(session, { ...control, seq: 0, type: 'click', x: 20, y: 30 }, actor)
  const stale = expect(input).rejects.toMatchObject({ code: 'STALE_INPUT' })
  pages[0]!.emit('framenavigated', pages[0]!.mainFrame())
  release()
  await stale
  expect(pages[0]!.mouse.click).not.toHaveBeenCalled()

  release = block()
  const first = runtime.control(session, { pageId: opened.pageId, mode: 'human' }, actor)
  const superseded = expect(first).rejects.toMatchObject({ code: 'CONTROL_CHANGED' })
  const latest = runtime.control(session, { pageId: opened.pageId, mode: 'agent' }, actor)
  release()
  await superseded
  expect(await latest).toMatchObject({ mode: 'agent' })

  release = block()
  const abort = new AbortController()
  const cancelled = runtime.control(
    session,
    { pageId: opened.pageId, mode: 'human' },
    actor,
    undefined,
    abort.signal,
  )
  const aborted = expect(cancelled).rejects.toThrow('aborted')
  abort.abort()
  release()
  await aborted
  expect(item.control).toBeUndefined()

  release = block()
  const closing = runtime.control(session, { pageId: opened.pageId, mode: 'human' }, actor)
  const revoked = expect(closing).rejects.toMatchObject({ code: 'PAGE_UNAVAILABLE' })
  await runtime.closeSession(session.key)
  release()
  await revoked
  expect(item.control).toBeUndefined()
  expect(runtime.list(session)).toEqual([])
})

it('keeps tab capacity and session closure effective while new pages are being created', async () => {
  const { runtime, context, pages, session } = fixture()
  await runtime.session(session)
  const create = context.newPage.getMockImplementation()!
  let release!: () => void,
    started!: () => void,
    count = 0
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  context.newPage.mockImplementation(async () => {
    if (++count === 3) started()
    await gate
    return create()
  })
  const requests = Array.from({ length: 4 }, () =>
    runtime.act(session, { action: 'open', url: 'http://127.0.0.1:5173/' }),
  )
  const results = Promise.allSettled(requests)
  await entered
  release()
  const settled = await results
  expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(3)
  expect(settled.filter((result) => result.status === 'rejected')).toMatchObject([
    { reason: { code: 'CAPACITY' } },
  ])
  expect(runtime.list(session)).toHaveLength(3)

  await runtime.closeSession(session.key)
  await runtime.session(session)
  const closingGate = new Promise<void>((resolve) => {
    release = resolve
  })
  const creating = new Promise<void>((resolve) => {
    started = resolve
  })
  context.newPage.mockImplementation(async () => {
    started()
    await closingGate
    return create()
  })
  const opening = runtime.act(session, { action: 'open', url: 'http://127.0.0.1:5173/' })
  const closed = expect(opening).rejects.toMatchObject({ code: 'CLOSED' })
  await creating
  await runtime.closeSession(session.key)
  release()
  await closed
  expect(runtime.list(session)).toEqual([])
  expect(pages.at(-1)!.close).toHaveBeenCalled()
  // Closing the last tab frees its conversation's slot, without evicting a live conversation.
  for (const cancelled of [false, true]) {
    const fresh = fixture()
    fresh.browser.newContext.mockImplementation(async () => fixture().context)
    try {
      for (const key of ['first', 'second', 'third']) {
        const identity = { key, lane: 'main' }
        const page = await fresh.runtime.act(identity, { action: 'open', url: 'http://localhost/' })
        const abort = new AbortController()
        if (cancelled) fresh.runtime.get(identity, page.pageId).page.once('close', () => abort.abort())
        const closing = fresh.runtime.act(
          identity,
          { action: 'close', pageId: page.pageId, pageEpoch: page.pageEpoch },
          abort.signal,
        )
        if (cancelled) await expect(closing).rejects.toMatchObject({ code: 'UNCERTAIN' })
        else await closing
        expect(fresh.runtime.list(identity)).toEqual([])
      }
    } finally {
      await fresh.runtime.close()
    }
  }
})

it('displays the final frame of a burst and cancels delayed frames when the viewer leaves', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const { runtime, cdp, session, pages } = fixture()
  const abort = new AbortController()
  try {
    const opened = await runtime.act(session, { action: 'open', url: 'http://127.0.0.1:5173/' })
    const frames: Uint8Array[] = []
    await showPage(
      runtime,
      { pageId: opened.pageId, displayVersion: 2 },
      {
        scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
        signal: abort.signal,
        stream: { send: (frame: Uint8Array) => frames.push(frame), close: vi.fn(), onDisconnect: vi.fn() },
      },
    )
    const sampling = cdp.send.mock.calls.find(([method]) => method === 'Page.startScreencast')?.[1] as
      | { everyNthFrame?: number }
      | undefined
    let paints = 0
    const emit = (data: string) => {
      // Model CDP's sampling: the last paint of a static page has no successor.
      if (++paints % (sampling?.everyNthFrame ?? 1) === 0)
        cdp.emit('Page.screencastFrame', { sessionId: 1, data: Buffer.from(data).toString('base64') })
    }
    emit('first')
    emit('middle')
    emit('final')
    expect(frames).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    const latest = Buffer.from(frames.at(-1)!)
    expect(latest.subarray(latest.readUInt32BE() + 4).toString()).toBe('final')
    let firstCapture = true
    Object.assign(pages[0]!, {
      screenshot: async (options: { type: string }) => {
        if (firstCapture) {
          firstCapture = false
          throw new Error('Transient frame unavailable')
        }
        cdp.emit('Page.screencastFrame', {
          sessionId: 1,
          data: Buffer.from('screenshot-repaint').toString('base64'),
        })
        return options.type === 'png' ? Buffer.alloc(1_000_001) : Buffer.from('sharp-jpeg-fallback')
      },
    })
    emit('before-sharpening')
    await vi.advanceTimersByTimeAsync(900)
    const sharp = Buffer.from(frames.at(-1)!)
    const headerSize = sharp.readUInt32BE()
    expect(JSON.parse(sharp.subarray(4, headerSize + 4).toString()).frameMime).toBe('image/jpeg')
    expect(sharp.subarray(headerSize + 4).toString()).toBe('sharp-jpeg-fallback')
    const observedRevision = JSON.parse(sharp.subarray(4, headerSize + 4).toString()).agentRevision
    runtime.get(session, opened.pageId).agentRevision++
    runtime.notify()
    const cached = Buffer.from(frames.at(-1)!)
    expect(JSON.parse(cached.subarray(4, cached.readUInt32BE() + 4).toString()).agentRevision).toBe(
      observedRevision,
    )

    // A screenshot's temporary raster and exact restoration must retain the
    // sharp image; a real asynchronous scene change still publishes normally.
    emit('temporary-screenshot-raster')
    await vi.advanceTimersByTimeAsync(10)
    emit('screenshot-repaint')
    await vi.advanceTimersByTimeAsync(70)
    expect(Buffer.from(frames.at(-1)!)).toEqual(cached)
    emit('asynchronous-scene-change')
    await vi.advanceTimersByTimeAsync(70)
    const changed = Buffer.from(frames.at(-1)!)
    expect(changed.subarray(changed.readUInt32BE() + 4).toString()).toBe('asynchronous-scene-change')

    cdp.emit('Page.screencastFrame', { sessionId: 1, data: Buffer.alloc(1_000_001).toString('base64') })
    await vi.advanceTimersByTimeAsync(0)
    expect(cdp.send).toHaveBeenCalledWith(
      'Page.startScreencast',
      expect.objectContaining({ maxWidth: 1920, quality: 65 }),
    )
    emit('after-close')
    const count = frames.length
    abort.abort()
    await vi.advanceTimersByTimeAsync(100)
    expect(frames).toHaveLength(count)
  } finally {
    abort.abort()
    vi.useRealTimers()
  }
})

it('releases audio capture if the display fails to start', async () => {
  const { runtime, cdp, session, pages } = fixture()
  const opened = await runtime.act(session, { action: 'open', url: 'http://localhost/' })
  let audioEnabled = false
  const page = pages[0]!
  Object.assign(page, {
    exposeBinding: async () => {},
    evaluate: async (_fn: unknown, input: { enabled: boolean }) => {
      audioEnabled = input.enabled
    },
  })
  cdp.send.mockImplementation(async (method) => {
    if (method === 'Page.startScreencast') throw new Error('Display unavailable')
  })
  const abort = new AbortController()
  try {
    await expect(
      showPage(
        runtime,
        { pageId: opened.pageId, displayVersion: 2 },
        {
          scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
          signal: abort.signal,
          stream: { send() {}, close() {}, onDisconnect() {} },
        },
      ),
    ).rejects.toThrow('Display unavailable')
    expect(audioEnabled).toBe(false)
    page.emit('domcontentloaded')
    await Promise.resolve()
    expect(audioEnabled).toBe(false)
  } finally {
    abort.abort()
    await runtime.close()
  }
})

it('keeps long addresses intact and retries the latest static pixels after backpressure', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const { runtime, pages, cdp, session } = fixture()
  const abort = new AbortController()
  try {
    const opened = await runtime.act(session, { action: 'open', url: 'http://localhost/' })
    const url = 'http://localhost/' + 'x'.repeat(6000)
    pages[0]!.url = () => url
    const notifications: unknown[] = []
    const received: Uint8Array[] = []
    showPages(
      runtime,
      {},
      {
        scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
        signal: abort.signal,
        stream: { send: (value: unknown) => notifications.push(value), close() {}, onDisconnect() {} },
      },
    )
    expect(notifications).toEqual([expect.objectContaining({ changed: true })])
    expect(runtime.list(session)[0].url).toBe(url)
    let overloaded = true
    await showPage(
      runtime,
      { pageId: opened.pageId },
      {
        scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
        signal: abort.signal,
        stream: {
          send(frame: Uint8Array) {
            if (overloaded) {
              overloaded = false
              return 'dropped'
            }
            received.push(frame)
            return 'accepted'
          },
          close() {},
          onDisconnect() {},
        },
      },
    )
    cdp.emit('Page.screencastFrame', { sessionId: 1, data: Buffer.from('static-pixels').toString('base64') })
    expect(received).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    const frame = Buffer.from(received[0]!)
    const size = frame.readUInt32BE()
    expect(size).toBeLessThan(4096)
    expect(frame.subarray(size + 4).toString()).toBe('static-pixels')
    abort.abort()
    await vi.advanceTimersByTimeAsync(1000)
    expect(received).toHaveLength(1)
  } finally {
    abort.abort()
    vi.useRealTimers()
  }
})

it('does not publish an idle image captured before newer input', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const { runtime, cdp, session } = fixture()
  const abort = new AbortController()
  let release!: (value: Buffer) => void
  const screenshot = new Promise<Buffer>((resolve) => {
    release = resolve
  })
  cdp.send.mockImplementation(async (method) =>
    method === 'Page.getLayoutMetrics' ? { visualViewport: { pageX: 0, pageY: 0, scale: 1 } } : undefined,
  )
  try {
    const opened = await runtime.act(session, { action: 'open', url: 'http://localhost/' })
    const page = runtime.get(session, opened.pageId).page
    Object.assign(page, { screenshot: async () => screenshot })
    const received: Uint8Array[] = []
    await showPage(
      runtime,
      { pageId: opened.pageId },
      {
        scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
        signal: abort.signal,
        stream: { send: (frame: Uint8Array) => received.push(frame), close() {}, onDisconnect() {} },
      },
    )
    await vi.advanceTimersByTimeAsync(0)
    cdp.emit('Page.screencastFrame', { sessionId: 1, data: Buffer.from('before-input').toString('base64') })
    const actor = { id: 'synthetic' }
    const control = await runtime.control(session, { pageId: opened.pageId, mode: 'human' }, actor)
    await runtime.humanInput(session, { ...control, seq: 0, type: 'scroll', x: 0, y: 100 }, actor)
    release(Buffer.from('stale-idle-image'))
    await vi.advanceTimersByTimeAsync(0)
    const pixels = received.map((bytes) => {
      const frame = Buffer.from(bytes)
      return frame.subarray(frame.readUInt32BE() + 4).toString()
    })
    expect(pixels).not.toContain('stale-idle-image')
    // Drain the prior paint's idle timer before restoring history without a new paint.
    await vi.advanceTimersByTimeAsync(300)
    cdp.send.mockImplementation(async (method) =>
      method === 'Page.getLayoutMetrics' ? { visualViewport: { pageX: 0, pageY: 0, scale: 1 } } : undefined,
    )
    Object.assign(page, { screenshot: async () => Buffer.from('restored-history-pixels') })
    page.emit('framenavigated', page.mainFrame())
    await vi.advanceTimersByTimeAsync(0)
    const restored = Buffer.from(received.at(-1)!)
    const restoredSize = restored.readUInt32BE()
    const restoredMeta = JSON.parse(restored.subarray(4, restoredSize + 4).toString())
    expect(restoredMeta.pageEpoch).toBe(1)
    expect(restored.subarray(restoredSize + 4).toString()).toBe('restored-history-pixels')
    await expect(
      runtime.humanInput(
        session,
        { ...control, seq: 1, pageEpoch: restoredMeta.pageEpoch, type: 'key', key: 'Enter' },
        actor,
      ),
    ).resolves.toMatchObject({ pageEpoch: 1 })
  } finally {
    abort.abort()
    vi.useRealTimers()
  }
})

it('stops further input when a dispatched operation fails with an operating-system error code', async () => {
  const { runtime, pages, session } = fixture()
  const opened = await runtime.act(session, { action: 'open', url: 'http://127.0.0.1:5173/' })
  pages[0]!.keyboard.press.mockRejectedValueOnce(
    Object.assign(new Error('Browser pipe closed'), { code: 'EPIPE' }),
  )
  const input = { action: 'key', pageId: opened.pageId, pageEpoch: 0, key: 'Enter' }
  await expect(runtime.act(session, input)).rejects.toMatchObject({ code: 'EPIPE' })
  expect(runtime.list(session)[0]).toMatchObject({ uncertain: true })
  await expect(runtime.act(session, input)).rejects.toMatchObject({ code: 'UNCERTAIN' })
})

it('rejects unsafe schemes, credentials and protected endpoints without blocking local development', () => {
  expect(validateAgainst(parameters, { action: 'open', url: 'http://localhost:5173/' }).ok).toBe(true)
  expect(validateAgainst(parameters, { action: 'status' }).ok).toBe(true)
  expect(validateAgainst(parameters, { action: 'unknown' }).ok).toBe(false)
  expect(validateAgainst(parameters, { action: 'open', url: 123 }).ok).toBe(false)
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@example.com/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::ffff:169.254.1.1]/latest/meta-data',
    'http://[::ffff:100.100.100.200]/latest/meta-data',
    'http://metadata.google.internal./computeMetadata/v1/',
    'http://localhost:3000/_agnes/plugin-stream',
  ])
    expect(() => browserUrl(url)).toThrow()
  expect(browserInstructions({ enabled: false })).toContain("consistent with the user's specified tool")
  expect(browserInstructions({ enabled: true, state: 'ready' })).toContain(
    "always respect the user's explicitly specified browser/tool",
  )
  expect(browserInstructions({ enabled: true, state: 'ready' })).not.toContain('Prefer browser')
  expect(browserInstructions({ enabled: true, state: 'failed' })).toContain('Do not silently replay')
  expect(browserUrl('http://localhost:5173/')).toBe('http://localhost:5173/')
  const protectedOrigins = new Set(['http://localhost:3000'])
  for (const host of ['localhost', 'localhost.', '127.0.0.2', '[::1]', '[::ffff:127.0.0.1]']) {
    expect(() => browserUrl(`http://${host}:3000/`, protectedOrigins)).toThrow()
    expect(browserUrl(`http://${host}:5173/`, protectedOrigins)).toContain(':5173/')
  }
})
