import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { createWebServer } from '../src/serve.js'

const source = fileURLToPath(new URL('../src/serve.ts', import.meta.url))

// A PNG signature: enough to prove byte transparency without embedding a real image.
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function availablePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test listener did not bind')
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

it('keeps the packaged Web server module side-effect free when bundled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-serve-'))
  try {
    const entry = join(root, 'entry.ts')
    const output = join(root, 'entry.mjs')
    await writeFile(
      entry,
      `import { DEFAULT_WEB_PORT } from ${JSON.stringify(source)}\nprocess.stdout.write(String(DEFAULT_WEB_PORT))\n`,
    )
    await build({
      entryPoints: [entry],
      outfile: output,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: ['node22'],
      logLevel: 'silent',
    })
    const result = spawnSync(process.execPath, [output], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('4177')
    expect(await readFile(output, 'utf8')).toContain('4177')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('fans daemon rebuild hints to the same-origin plugin SSE stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-plugin-events-'))
  const port = await availablePort()
  let emit: ((event: { packageId: string; revision: string }) => void) | undefined
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4312',
    token: 'lifecycle-token',
    port,
    origin: `http://127.0.0.1:${port}`,
    subscribePluginEvents: (listener) => {
      emit = listener
      return () => undefined
    },
  })
  const controller = new AbortController()
  try {
    const response = await fetch(`${server.url}/plugins/events`, { signal: controller.signal })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    if (!reader) throw new Error('SSE response has no body')
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('event: graph')
    emit?.({ packageId: 'example/clock', revision: 'sha256-next' })
    const second = new TextDecoder().decode((await reader.read()).value)
    expect(second).toContain('event: rebuilt')
    expect(second).toContain('"id":"example/clock"')
    expect(second).toContain('"rev":"sha256-next"')
  } finally {
    controller.abort()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('polls served plugin build files by stat, hashes only on mtime changes, and supports same-revision rebuilds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-plugin-watch-'))
  const plugin = join(root, 'panel.js')
  const revision = `sha256-${'a'.repeat(64)}`
  const pathname = `/plugins/example/clock/${revision}/panel.js`
  await writeFile(plugin, 'export const value = "one"\n')
  const port = await availablePort()
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4312',
    token: 'lifecycle-token',
    port,
    origin: `http://127.0.0.1:${port}`,
    pluginBuildPollMs: 10,
    clientModuleAsset: (path) => (path === pathname ? plugin : null),
  })
  const controller = new AbortController()
  try {
    const events = await fetch(`${server.url}/plugins/events`, { signal: controller.signal })
    const reader = events.body?.getReader()
    expect(reader).toBeDefined()
    if (!reader) throw new Error('SSE response has no body')
    await reader.read() // graph
    expect((await fetch(`${server.url}${pathname}`)).status).toBe(200)

    // A build tool may touch mtime without changing bytes. The watcher must not broadcast that.
    await utimes(plugin, new Date(Date.now() + 1000), new Date(Date.now() + 1000))
    const quiet = await Promise.race([
      reader.read().then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 35)),
    ])
    expect(quiet).toBe(true)
    await reader.cancel()

    const next = await fetch(`${server.url}/plugins/events`, { signal: controller.signal })
    const nextReader = next.body?.getReader()
    expect(nextReader).toBeDefined()
    if (!nextReader) throw new Error('second SSE response has no body')
    await nextReader.read() // graph
    await writeFile(plugin, 'export const value = "two"\n')
    const rebuilt = new TextDecoder().decode((await nextReader.read()).value)
    expect(rebuilt).toContain('event: rebuilt')
    expect(rebuilt).toContain('"id":"example/clock"')
    expect(rebuilt).toContain(`"rev":"${revision}"`)
  } finally {
    controller.abort()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('serves the fixed admin page and gives its BFF priority over static routing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-admin-'))
  const port = await availablePort()
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4312',
    token: 'lifecycle-token',
    port,
    origin: `http://127.0.0.1:${port}`,
    handleAdmin: async (request, response) => {
      if (request.url !== '/admin/plugins/api/context') return false
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"handled":true}')
      return true
    },
  }).catch(async (error) => {
    await rm(root, { recursive: true, force: true })
    throw error
  })
  try {
    await writeFile(join(root, 'admin.html'), '<title>Plugin admin</title>')
    const page = await fetch(`${server.url}/admin/plugins`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Plugin admin')
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'")

    const api = await fetch(`${server.url}/admin/plugins/api/context`)
    expect(api.status).toBe(200)
    expect(await api.json()).toEqual({ handled: true })
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('fails closed when an admin API handler is not installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-admin-missing-'))
  const port = await availablePort()
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4313',
    token: 'lifecycle-token',
    port,
    origin: `http://127.0.0.1:${port}`,
  }).catch(async (error) => {
    await rm(root, { recursive: true, force: true })
    throw error
  })
  try {
    const response = await fetch(`${server.url}/admin/plugins/api/list`, { method: 'POST' })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'ADMIN_UNAVAILABLE', message: '插件管理后台暂时不可用。' },
    })
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('serves the fixed resource management page and fails its BFF closed without a handler', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-resource-admin-'))
  const port = await availablePort()
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4314',
    token: 'lifecycle-token',
    port,
    origin: `http://127.0.0.1:${port}`,
  })
  try {
    await writeFile(join(root, 'resources.html'), '<title>Resources</title>')
    expect(await (await fetch(`${server.url}/admin/resources`)).text()).toContain('Resources')
    const api = await fetch(`${server.url}/admin/resources/api/skills/list`, { method: 'POST' })
    expect(api.status).toBe(503)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('serves esbuild shared chunks and still rejects arbitrary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-chunk-'))
  const port = await availablePort()
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4316',
    token: 'lifecycle-token',
    port,
    origin: `http://127.0.0.1:${port}`,
  })
  try {
    await writeFile(join(root, 'chunk-ABCDEF12.js'), 'export const shared = 1\n')
    await writeFile(join(root, 'chunk-ABCDEF12.js.map'), '{}\n')
    await writeFile(join(root, 'secret.txt'), 'do not serve\n')
    // 侧栏品牌位与过程行头像用的位图：它必须被放行并以 image/png 提供，
    // 否则 /brand-mark.png 会静默 404，mask 拿不到图，logo 与头像就是空的。
    await writeFile(join(root, 'brand-mark.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(join(root, 'secret.png'), 'not an allowlisted asset\n')
    // Code splitting emits hashed chunks that every lazy pane imports at runtime; a 404 here would
    // break the admin panels only once the user opened them, so pin the route.
    const chunk = await fetch(`${server.url}/chunk-ABCDEF12.js`)
    expect(chunk.status).toBe(200)
    expect(await chunk.text()).toContain('shared')
    // The allowlist stays closed for everything that is not a known entry or a chunk.
    expect((await fetch(`${server.url}/secret.txt`)).status).toBe(404)
    expect((await fetch(`${server.url}/chunk-ABCDEF12.txt`)).status).toBe(404)
    expect((await fetch(`${server.url}/chunk-ABCDEF12.js.map`)).status).toBe(200)
    const mark = await fetch(`${server.url}/brand-mark.png`)
    expect(mark.status).toBe(200)
    expect(mark.headers.get('content-type')).toBe('image/png; charset=utf-8')
    // 白名单仍逐文件生效：同样后缀但未登记的文件不放行。
    expect((await fetch(`${server.url}/secret.png`)).status).toBe(404)
    // URL separators must stay portable even when disk paths use Windows backslashes.
    await mkdir(join(root, 'vendor'))
    for (const name of [
      'react',
      'react-jsx-runtime',
      'react-dom',
      'react-dom-client',
      'cordis',
      'web-client',
      'chunk-ABCDEF12',
    ]) {
      for (const suffix of ['.js', '.js.map']) {
        const file = `${name}${suffix}`
        const body = suffix === '.js' ? 'export const vendor = 1\n' : '{}\n'
        await writeFile(join(root, 'vendor', file), body)
        const response = await fetch(`${server.url}/vendor/${file}?v=1`)
        expect(response.status, file).toBe(200)
        expect(await response.text()).toBe(body)
        expect(response.headers.get('content-type')).toContain(
          suffix === '.js' ? 'text/javascript' : 'application/json',
        )
      }
    }
    const head = await fetch(`${server.url}/vendor/react.js`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    await writeFile(join(root, 'vendor', 'secret.js'), 'do not serve\n')
    for (const path of [
      '/vendor/secret.js',
      '/vendor/react.txt',
      '/vendor/nested/react.js',
      '/vendor/../secret.txt',
      '/vendor/%2e%2e/secret.txt',
      '/vendor/..%5csecret.txt',
      '/vendor/%2e%2e%2fsecret.txt',
    ]) {
      expect((await fetch(`${server.url}${path}`)).status, path).toBe(404)
    }
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps the native workspace picker exact-origin and single-flight without a credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-picker-'))
  const port = await availablePort()
  let finish: ((value: { status: 'selected'; path: string }) => void) | undefined
  let calls = 0
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4315',
    port,
    origin: `http://127.0.0.1:${port}`,
    workspacePicker: {
      available: async () => true,
      pick: () => {
        calls++
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    },
  })
  try {
    const capability = await fetch(`${server.url}/api/workspace-picker`)
    expect(capability.status).toBe(200)
    await expect(capability.json()).resolves.toEqual({ available: true })
    expect(capability.headers.get('cache-control')).toBe('no-store')
    expect(capability.headers.get('content-security-policy')).toContain("default-src 'none'")

    expect((await fetch(`${server.url}/api/workspace-picker?path=/tmp`, {})).status).toBe(403)
    expect(
      (
        await fetch(`${server.url}/api/workspace-picker`, {
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
    ).toBe(403)

    expect(
      (
        await fetch(`${server.url}/api/workspace-picker`, {
          method: 'POST',
          headers: { Origin: 'http://127.0.0.1:9' },
        })
      ).status,
    ).toBe(403)

    const first = fetch(`${server.url}/api/workspace-picker`, {
      method: 'POST',
      headers: { Origin: server.url },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const duplicate = await fetch(`${server.url}/api/workspace-picker`, {
      method: 'POST',
      headers: { Origin: server.url },
    })
    expect(duplicate.status).toBe(409)
    expect(calls).toBe(1)
    finish?.({ status: 'selected', path: '/tmp/selected workspace' })
    const selected = await first
    expect(selected.status).toBe(200)
    await expect(selected.json()).resolves.toEqual({
      status: 'selected',
      path: '/tmp/selected workspace',
    })
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('reports workspace picker cancellation and unavailable hosts without exposing diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-picker-states-'))
  const port = await availablePort()
  let result: { status: 'cancelled' } | { status: 'unavailable' } = { status: 'cancelled' }
  let available = true
  const lifecycleCredential = ['picker', 'state', 'credential'].join('-')
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4316',
    token: lifecycleCredential,
    port,
    origin: `http://127.0.0.1:${port}`,
    workspacePicker: {
      available: async () => available,
      pick: async () => result,
    },
  })
  const headers = { Authorization: `Bearer ${lifecycleCredential}`, Origin: server.url }
  try {
    const cancelled = await fetch(`${server.url}/api/workspace-picker`, { method: 'POST', headers })
    expect(cancelled.status).toBe(200)
    await expect(cancelled.json()).resolves.toEqual({ status: 'cancelled' })

    available = false
    result = { status: 'unavailable' }
    const unavailable = await fetch(`${server.url}/api/workspace-picker`, { method: 'POST', headers })
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toEqual({ status: 'unavailable' })

    const bodyRejected = await fetch(`${server.url}/api/workspace-picker`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(bodyRejected.status).toBe(400)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('claims the workspace picker single-flight before awaiting capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-picker-capability-race-'))
  const port = await availablePort()
  let availabilityDidStart: (() => void) | undefined
  const availabilityStarted = new Promise<void>((resolve) => {
    availabilityDidStart = resolve
  })
  let releaseAvailability: ((value: boolean) => void) | undefined
  const delayedAvailability = new Promise<boolean>((resolve) => {
    releaseAvailability = resolve
  })
  let pickCalls = 0
  const lifecycleCredential = ['picker', 'race', 'credential'].join('-')
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4318',
    token: lifecycleCredential,
    port,
    origin: `http://127.0.0.1:${port}`,
    workspacePicker: {
      available: async () => {
        availabilityDidStart?.()
        return delayedAvailability
      },
      pick: async () => {
        pickCalls++
        return { status: 'cancelled' }
      },
    },
  })
  const headers = { Authorization: `Bearer ${lifecycleCredential}`, Origin: server.url }
  try {
    const first = fetch(`${server.url}/api/workspace-picker`, { method: 'POST', headers })
    await availabilityStarted
    const duplicate = await fetch(`${server.url}/api/workspace-picker`, { method: 'POST', headers })
    expect(duplicate.status).toBe(409)
    releaseAvailability?.(true)
    expect((await first).status).toBe(200)
    expect(pickCalls).toBe(1)
  } finally {
    releaseAvailability?.(true)
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('aborts an in-flight workspace picker when the Web server closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-picker-abort-'))
  const port = await availablePort()
  let observedAbort = false
  let started: (() => void) | undefined
  const pickerStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const lifecycleCredential = ['picker', 'abort', 'credential'].join('-')
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4317',
    token: lifecycleCredential,
    port,
    origin: `http://127.0.0.1:${port}`,
    workspacePicker: {
      available: async () => true,
      pick: (signal) =>
        new Promise((resolve) => {
          started?.()
          signal.addEventListener(
            'abort',
            () => {
              observedAbort = true
              resolve({ status: 'unavailable' })
            },
            { once: true },
          )
        }),
    },
  })
  try {
    void fetch(`${server.url}/api/workspace-picker`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lifecycleCredential}`, Origin: server.url },
    }).catch(() => undefined)
    await pickerStarted
    await server.close()
    expect(observedAbort).toBe(true)
  } finally {
    await server.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

// The skin route is the only new network input this feature adds. Its path authority is pinned in
// package-manager's own suite; this case pins the HTTP half: the resolver decides what exists, and
// the server only applies method, MIME allowlist and the shared page headers.
it('serves skin assets through the injected resolver and 404s everything it refuses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-skin-'))
  const stylesheet = join(root, 'skin.css')
  await writeFile(stylesheet, '.sidebar { background: #000; }\n')
  // A file the resolver is willing to hand over but the MIME allowlist does not recognise: the
  // server must refuse it rather than fall back to a sniffable content type.
  const notes = join(root, 'notes.txt')
  await writeFile(notes, 'not a skin asset\n')
  const port = await availablePort()
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4312',
    token: 'lifecycle-token',
    port,
    origin: `http://127.0.0.1:${port}`,
    // Three answer shapes share this option: a file path, the bytes themselves, and an async
    // answer. Bytes arrive when the launcher asked another process for them (design §22), and that
    // request is inherently asynchronous, so the shape has to carry both.
    skinAsset: (pathname) => {
      if (pathname === '/skins/midnight/skin.css') return stylesheet
      if (pathname === '/skins/midnight/notes.txt') return notes
      if (pathname === '/skins/aurora/assets/aurora.png') return PNG_MAGIC
      if (pathname === '/skins/paper/skin.css') return Promise.resolve(stylesheet)
      return null
    },
  })
  try {
    const served = await fetch(`http://127.0.0.1:${port}/skins/midnight/skin.css`)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('text/css')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(served.headers.get('cache-control')).toBe('no-store')
    expect(served.headers.get('content-security-policy')).toContain("style-src 'self'")
    expect(await served.text()).toContain('background')
    // A resolver answer the MIME allowlist does not recognise is refused, not sniffed.
    expect((await fetch(`http://127.0.0.1:${port}/skins/midnight/notes.txt`)).status).toBe(404)
    // A path the resolver declines never reaches the static-file branch.
    expect((await fetch(`http://127.0.0.1:${port}/skins/other/skin.css`)).status).toBe(404)
    // Bytes carry no path of their own, so the request path names their type.
    const bytes = await fetch(`http://127.0.0.1:${port}/skins/aurora/assets/aurora.png`)
    expect(bytes.status).toBe(200)
    expect(bytes.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(PNG_MAGIC)
    // An async answer is awaited before the MIME decision, not treated as a miss.
    const awaited = await fetch(`http://127.0.0.1:${port}/skins/paper/skin.css`)
    expect(awaited.status).toBe(200)
    expect(awaited.headers.get('content-type')).toBe('text/css')
    // The route is read-only.
    expect((await fetch(`http://127.0.0.1:${port}/skins/midnight/skin.css`, { method: 'POST' })).status).toBe(
      405,
    )
  } finally {
    await server.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

// The client module route (design WC3) mirrors the skin route's contract with a narrower MIME
// allowlist (`.js`/`.mjs`/`.css`/`.map` only). Its path authority is pinned in the daemon's own
// suite; this case pins the HTTP half: the resolver decides what exists, and the server only
// applies method, MIME allowlist and the shared page headers.
it('serves client module assets through the injected resolver and 404s everything it refuses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-plugins-'))
  const entry = join(root, 'panel.js')
  await writeFile(entry, 'export const panel = true\n')
  const styles = join(root, 'panel.css')
  await writeFile(styles, '.panel { color: #000; }\n')
  const sourcemap = join(root, 'panel.js.map')
  await writeFile(sourcemap, '{"version":3}\n')
  // A file the resolver is willing to hand over but the MIME allowlist does not recognise: the
  // server must refuse it rather than fall back to a sniffable content type.
  const notes = join(root, 'notes.txt')
  await writeFile(notes, 'not a client module asset\n')
  const MODULE_BYTES = new Uint8Array([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74])
  const port = await availablePort()
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4312',
    token: 'lifecycle-token',
    port,
    origin: `http://127.0.0.1:${port}`,
    // Three answer shapes share this option: a file path, the bytes themselves, and an async
    // answer. Bytes arrive when the launcher asked the daemon for them over its private connection
    // (design WC3), and that request is inherently asynchronous, so the shape has to carry both.
    clientModuleAsset: (pathname) => {
      if (pathname === '/plugins/demo/panel.js') return entry
      if (pathname === '/plugins/demo/panel.mjs') return entry
      if (pathname === '/plugins/demo/panel.css') return styles
      if (pathname === '/plugins/demo/panel.js.map') return sourcemap
      if (pathname === '/plugins/demo/notes.txt') return notes
      if (pathname === '/plugins/demo/bytes.js') return MODULE_BYTES
      if (pathname === '/plugins/demo/async.js') return Promise.resolve(entry)
      return null
    },
  })
  try {
    const served = await fetch(`http://127.0.0.1:${port}/plugins/demo/panel.js`)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('text/javascript')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(served.headers.get('cache-control')).toBe('no-store')
    expect(served.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(await served.text()).toContain('export const panel')
    // The three allowlisted extensions each map to their fixed content type.
    expect((await fetch(`http://127.0.0.1:${port}/plugins/demo/panel.mjs`)).headers.get('content-type')).toBe(
      'text/javascript',
    )
    expect((await fetch(`http://127.0.0.1:${port}/plugins/demo/panel.css`)).headers.get('content-type')).toBe(
      'text/css',
    )
    expect(
      (await fetch(`http://127.0.0.1:${port}/plugins/demo/panel.js.map`)).headers.get('content-type'),
    ).toBe('application/json')
    // A resolver answer the MIME allowlist does not recognise is refused, not sniffed -- and it is
    // the same 404 a resolver miss produces, with the same no-store caching stance.
    const refused = await fetch(`http://127.0.0.1:${port}/plugins/demo/notes.txt`)
    expect(refused.status).toBe(404)
    expect(refused.headers.get('cache-control')).toBe('no-store')
    const miss = await fetch(`http://127.0.0.1:${port}/plugins/other/panel.js`)
    expect(miss.status).toBe(404)
    expect(miss.headers.get('cache-control')).toBe('no-store')
    // A path that climbs out of the prefix never reaches the resolver: URL normalization removes the
    // `/plugins/` prefix, so the request falls through to the static whitelist and misses there.
    const traversal = await fetch(`http://127.0.0.1:${port}/plugins/../../etc/passwd`)
    expect(traversal.status).toBe(404)
    // Bytes carry no path of their own, so the request path names their type.
    const bytes = await fetch(`http://127.0.0.1:${port}/plugins/demo/bytes.js`)
    expect(bytes.status).toBe(200)
    expect(bytes.headers.get('content-type')).toBe('text/javascript')
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(MODULE_BYTES)
    // An async answer is awaited before the MIME decision, not treated as a miss.
    const awaited = await fetch(`http://127.0.0.1:${port}/plugins/demo/async.js`)
    expect(awaited.status).toBe(200)
    expect(awaited.headers.get('content-type')).toBe('text/javascript')
    // The route is read-only.
    expect((await fetch(`http://127.0.0.1:${port}/plugins/demo/panel.js`, { method: 'POST' })).status).toBe(
      405,
    )
  } finally {
    await server.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
