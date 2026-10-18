import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'

const { BrowserRuntime } = await import(
  new URL('../bundled-plugins/browser-runtime/src/runtime.mjs', import.meta.url).href
)
const { commandFor, request } = await import(
  new URL('../bundled-plugins/browser-runtime/src/protocol.mjs', import.meta.url).href
)
const { privateEnvironment, binaryName, BrowserEngine } = await import(
  new URL('../bundled-plugins/browser-runtime/src/engine.mjs', import.meta.url).href
)
const { browserPlatform, browserPayload, browserVersion } = await import(
  new URL('../bundled-plugins/browser-runtime/src/install.mjs', import.meta.url).href
)
const context = (key = 'one', lane = 'main') => ({
  session: { key, lane },
  signal: new AbortController().signal,
})

it('keeps process launches in the authorized workspace and cleans staging on refused startup', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'agh-install-test-'))
  let marker: string | undefined
  const engine = new BrowserEngine()
  engine.cache = cache
  const openProcess = vi.fn(async (options: { cwd: string; argv: string[] }) => {
    expect(options.cwd).toBe(process.cwd())
    expect(options.argv.at(-1)).toBe(browserPayload(cache).url)
    if (!marker) throw new Error('Missing installation marker')
    expect(JSON.parse(await readFile(marker, 'utf8')).version).toBe(browserVersion)
    throw new Error('workspace policy refused startup')
  })
  const ctx = { ...context(), cwd: process.cwd(), sandbox: { openProcess } }
  try {
    const create = vi.fn()
    await expect(
      engine.install({ ...ctx, signal: AbortSignal.abort(new Error('cancelled')), fs: { create } }),
    ).rejects.toThrow('cancelled')
    expect(create).not.toHaveBeenCalled()
    await expect(
      engine.install({
        ...ctx,
        fs: {
          create: async () => {
            throw new Error('cache denied')
          },
        },
      }),
    ).rejects.toThrow('cache denied')
    expect(openProcess).not.toHaveBeenCalled()
    await expect(
      engine.install({
        ...ctx,
        fs: {
          create: async (path: string, bytes: Uint8Array) => {
            marker = path
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, bytes, { flag: 'wx' })
          },
        },
      }),
    ).rejects.toThrow('workspace policy refused startup')
    expect(openProcess).toHaveBeenCalledOnce()
    if (!marker) throw new Error('Missing installation marker')
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let endInstallation: (error: Error) => void = () => {}
    const installation = new Promise<void>((_resolve, reject) => {
      endInstallation = reject
    })
    engine.install = () => {
      markStarted()
      return installation
    }
    const owner = engine.ensureChrome(ctx).catch(() => {})
    await started
    const waiting = new AbortController()
    let ownerSettled = false
    void owner.then(() => {
      ownerSettled = true
    })
    try {
      const second = engine.ensureChrome({ ...ctx, signal: waiting.signal })
      waiting.abort(new Error('cancel waiting session'))
      await expect(second).rejects.toThrow('cancel waiting session')
      expect(ownerSettled).toBe(false)
    } finally {
      endInstallation(new Error('fixture download finished'))
      await owner
    }
  } finally {
    await rm(cache, { recursive: true, force: true })
  }
})

it('reports native startup failures without suggesting an unsandboxed retry or leaking private paths', async () => {
  const close = vi.fn(async () => {})
  const off = vi.fn()
  const engine = new BrowserEngine({ binary: process.execPath })
  engine.ensureChrome = async () => process.execPath
  await expect(
    engine.start({
      ...context(),
      cwd: process.cwd(),
      sandbox: {
        openProcess: async () => ({
          onOutput: (listener: (value: { text: string }) => void) => {
            listener({
              text: `Chrome exited early (exit code: 3) at ${engine.cache}\nHint: use --no-sandbox\n`,
            })
            return off
          },
          exited: Promise.resolve({ code: 1 }),
          close,
        }),
      },
    }),
  ).rejects.toThrow('Chrome exited early (exit code: 3) at <browser-cache>')
  expect(close).toHaveBeenCalledOnce()
  expect(off).toHaveBeenCalledOnce()
})

it('preserves split UTF-8 responses and never replays a dispatched action after connection loss', async () => {
  let commands = 0
  const server = createServer((socket) => {
    let text = ''
    socket.on('data', (chunk) => {
      text += chunk.toString()
      if (!text.includes('\n')) return
      const command = JSON.parse(text.trim())
      commands++
      if (command.action === 'click') return socket.end()
      const response = Buffer.from(
        `${JSON.stringify({ id: command.id, success: true, data: { title: '中文' } })}\n`,
      )
      const split = response.indexOf(Buffer.from('中')) + 1
      socket.write(response.subarray(0, split))
      setImmediate(() => socket.end(response.subarray(split)))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local protocol endpoint')
  const endpoint = { host: '127.0.0.1', port: address.port }
  try {
    await expect(request(endpoint, { action: 'snapshot' })).resolves.toEqual({ title: '中文' })
    await expect(request(endpoint, { action: 'click', selector: '@e1' })).rejects.toThrow(
      'BROWSER_OUTCOME_UNKNOWN',
    )
    expect(commands).toBe(2)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('allows only owned-page commands and keeps option-looking input as data', () => {
  expect(commandFor({ action: 'fill', ref: '@e2', text: '--cdp 9222 --profile personal' })).toEqual({
    action: 'fill',
    selector: '@e2',
    value: '--cdp 9222 --profile personal',
  })
  for (const action of ['attach', 'connect', 'launch', 'evaluate', 'profiles', 'mouse'])
    expect(() => commandFor({ action })).toThrow()
  for (const url of ['file:///private', 'javascript:alert(1)', 'chrome://settings', 'http://user:pass@host/'])
    expect(() => commandFor({ action: 'open', url })).toThrow()
  expect(() => commandFor({ action: 'click', ref: '--auto-connect' })).toThrow()
  const env = privateEnvironment('/private-owned', '/private-cache')
  expect(env.AGENT_BROWSER_PROFILE).toContain('private-owned')
  expect(env).not.toHaveProperty('AGENT_BROWSER_CDP')
  expect(env).not.toHaveProperty('AGENT_BROWSER_AUTO_CONNECT')
  expect(env.AGENT_BROWSER_HEADED).toBe('false')
  expect(binaryName('darwin', 'arm64')).toBe('agent-browser-darwin-arm64')
  expect(binaryName('darwin', 'x64')).toBe('agent-browser-darwin-x64')
  expect(binaryName('win32', 'x64')).toBe('agent-browser-win32-x64.exe')
  for (const [os, arch, platform] of [
    ['darwin', 'arm64', 'mac-arm64'],
    ['darwin', 'x64', 'mac-x64'],
    ['win32', 'x64', 'win64'],
    ['win32', 'arm64', 'win64'],
  ]) {
    expect(browserPlatform(os, arch)).toBe(platform)
    expect(browserPayload('/cache', platform).url).toContain(
      `/${browserVersion}/${platform}/chrome-headless-shell-${platform}.zip`,
    )
  }
  expect(() => browserPlatform('darwin', 'ia32')).toThrow('Unsupported')
})

it('is lazy, isolates sessions and lanes, and never launches through a viewer query', async () => {
  const instances: Array<{ call: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = []
  const engine = {
    start: vi.fn(async () => {
      const browser = {
        call: vi.fn(async () => ({ ok: true })),
        close: vi.fn(async () => {}),
        exited: new Promise(() => {}),
        port: 1234,
      }
      instances.push(browser)
      return browser
    }),
  }
  const runtime = new BrowserRuntime(engine)
  expect(runtime.observe('one', { kind: 'human' })).toEqual({ state: 'idle' })
  expect(engine.start).not.toHaveBeenCalled()
  for (const when of ['before', 'queued']) {
    const abort = new AbortController()
    const ctx = { ...context(`cancelled-${when}`), signal: abort.signal }
    if (when === 'before') abort.abort()
    const cancelled = runtime.execute({ action: 'open', url: 'https://example.com' }, ctx)
    abort.abort()
    await expect(cancelled).rejects.toThrow()
    expect(runtime.observe(ctx.session.key, { kind: 'human' })).toEqual({ state: 'idle' })
  }
  expect(engine.start).not.toHaveBeenCalled()
  await expect(runtime.execute({ action: 'snapshot' }, context())).rejects.toThrow('Open a URL')
  await runtime.execute({ action: 'open', url: 'https://example.com' }, context())
  await runtime.execute({ action: 'open', url: 'https://example.org' }, context('two'))
  await runtime.execute({ action: 'open', url: 'http://localhost:5173' }, context('one', 'child'))
  expect(instances).toHaveLength(3)
  await runtime.execute({ action: 'fill', ref: '@e1', text: 'hello' }, context())
  expect(instances[0]!.call).toHaveBeenLastCalledWith(
    { action: 'fill', selector: '@e1', value: 'hello' },
    expect.any(AbortSignal),
    30000,
  )
  await runtime.closeSession(context().session)
  expect(instances[0]!.close).toHaveBeenCalledOnce()
  expect(instances[1]!.close).not.toHaveBeenCalled()
  expect(runtime.observe('one', { kind: 'human' })).toEqual({ state: 'idle' })
  await runtime.dispose()
  expect(instances[1]!.close).toHaveBeenCalledOnce()
  expect(instances[2]!.close).toHaveBeenCalledOnce()
})

it('revokes expired, wrong-actor, reused and closed-session viewer tickets', async () => {
  let now = 0
  const runtime = new BrowserRuntime(
    {
      start: async () => ({
        call: async () => ({}),
        close: async () => {},
        exited: new Promise(() => {}),
        port: 1234,
      }),
    },
    () => now,
  )
  const actor = { kind: 'human', id: 'owner' }
  await runtime.execute({ action: 'open', url: 'https://example.com' }, context())
  const ticket = runtime.observe('one', actor).ticket
  expect(() => runtime.watch(ticket, { actor: { kind: 'human', id: 'other' } })).toThrow('invalid or expired')
  expect(() => runtime.watch(ticket, { actor })).toThrow('invalid or expired')
  const expired = runtime.observe('one', actor).ticket
  now = 30001
  expect(() => runtime.watch(expired, { actor })).toThrow('invalid or expired')
  const closed = runtime.observe('one', actor).ticket
  await runtime.closeSession(context().session)
  expect(() => runtime.watch(closed, { actor })).toThrow('invalid or expired')
  await runtime.dispose()
})

it('closes a browser when shutdown races startup and prevents later operations', async () => {
  let complete!: (value: unknown) => void
  const close = vi.fn(async () => {})
  const runtime = new BrowserRuntime({
    start: () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  })
  const opening = runtime.execute({ action: 'open', url: 'https://example.com' }, context())
  await Promise.resolve()
  const closing = runtime.dispose()
  complete({ close, call: async () => ({}), exited: new Promise(() => {}) })
  await expect(opening).rejects.toThrow()
  await closing
  expect(close).toHaveBeenCalled()
  await expect(runtime.execute({ action: 'open', url: 'https://example.com' }, context())).rejects.toThrow(
    'closed',
  )
})

it('checks authenticated session reads before issuing a viewer ticket', async () => {
  const { browserRuntime } = await import(
    new URL('../bundled-plugins/browser-runtime/index.mjs', import.meta.url).href
  )
  const observe = vi.fn(() => ({ state: 'idle' }))
  let query: { handler: (input: unknown, context: unknown) => Promise<unknown> } | undefined
  browserRuntime.apply({
    tools: { register() {} },
    hooks: { register() {} },
    profileRuntime: { register: () => ({ get: async () => ({ observe }) }), streams: { register() {} } },
    services: {
      register: (service: typeof query) => {
        query = service
      },
    },
  })
  await expect(
    query!.handler(
      { sessionId: 'victim' },
      {
        sessionAccess: {
          requireRead: async () => {
            throw new Error('denied')
          },
        },
      },
    ),
  ).rejects.toThrow('denied')
  expect(observe).not.toHaveBeenCalled()
  const requireRead = vi.fn(async () => {})
  await query!.handler({ sessionId: 'one' }, { sessionAccess: { requireRead }, actor: { kind: 'human' } })
  expect(requireRead).toHaveBeenCalledWith('one')
  expect(observe).toHaveBeenCalledWith('one', { kind: 'human' })
  const descriptor = JSON.parse(
    await readFile(new URL('../bundled-plugins/browser-runtime/package.json', import.meta.url), 'utf8'),
  )
  expect(descriptor.agnes.plugins[0].capabilities.streams[0].directions).toEqual(['outbound'])
})
