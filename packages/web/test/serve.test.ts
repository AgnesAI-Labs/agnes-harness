import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Window } from 'happy-dom'
import { expect, it, vi } from 'vitest'
import { createWebServer, HTML_VIEWER_PATH } from '../src/serve.js'

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
    await writeFile(
      join(root, 'admin.html'),
      '<meta name="agnes-csp-nonce" content="__AGNES_CSP_NONCE__"><title>Plugin admin</title>',
    )
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

it('issues a fresh CSP style nonce for each served HTML document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-csp-nonce-'))
  const port = await availablePort()
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4320',
    port,
    origin: `http://127.0.0.1:${port}`,
  })
  try {
    const nonceMarker = '<meta name="agnes-csp-nonce" content="__AGNES_CSP_NONCE__">'
    await writeFile(join(root, 'index.html'), `${nonceMarker}<meta data-ws="__AGNES_WS_URL__">`)
    await writeFile(join(root, 'admin.html'), nonceMarker)
    await writeFile(join(root, 'resources.html'), nonceMarker)

    const documents = await Promise.all([
      fetch(`${server.url}/`),
      fetch(`${server.url}/admin/plugins`),
      fetch(`${server.url}/admin/resources`),
      fetch(`${server.url}/`),
    ])
    const nonces: string[] = []
    for (const document of documents) {
      expect(document.status).toBe(200)
      const body = await document.text()
      const nonce = body.match(/name="agnes-csp-nonce" content="([^"]+)"/)?.[1]
      expect(nonce).toBeTruthy()
      expect(body).not.toContain('__AGNES_CSP_NONCE__')
      const policy = document.headers.get('content-security-policy') ?? ''
      expect(policy).toContain(`'nonce-${nonce}'`)
      const directives = Object.fromEntries(
        policy.split(';').map((part) => {
          const [name, ...values] = part.trim().split(/\s+/)
          return [name, values]
        }),
      )
      if (new URL(document.url).pathname === '/') {
        expect(directives['img-src']).toEqual(["'self'", 'blob:'])
        expect(directives['frame-src']).toEqual(["'self'", 'blob:'])
      } else {
        expect(directives['img-src']).toBeUndefined()
        expect(directives['frame-src']).toBeUndefined()
        expect(policy).not.toContain('blob:')
      }
      expect(directives['default-src']).toEqual(["'self'"])
      expect(directives['script-src']).toEqual(["'self'"])
      expect(directives['style-src']).toEqual(["'self'", `'nonce-${nonce}'`])

      expect(policy).not.toContain("'unsafe-inline'")
      nonces.push(nonce as string)
    }
    expect(new Set(nonces).size).toBe(nonces.length)
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
      error: {
        code: 'ADMIN_UNAVAILABLE',
        message: 'The plugin admin service is temporarily unavailable.',
      },
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
    await writeFile(
      join(root, 'resources.html'),
      '<meta name="agnes-csp-nonce" content="__AGNES_CSP_NONCE__"><title>Resources</title>',
    )
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
    await writeFile(join(root, 'chunk-ABCDEF12.css'), '.shared { color: red; }\n')
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
    const cssChunk = await fetch(`${server.url}/chunk-ABCDEF12.css`)
    expect(cssChunk.status).toBe(200)
    expect(cssChunk.headers.get('content-type')).toContain('text/css')
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
      'antd',
      'assistant-ui',
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

it('serves the static Ant Design stylesheet from the build output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-antd-css-'))
  const port = await availablePort()
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4319',
    port,
    origin: `http://127.0.0.1:${port}`,
  })
  try {
    await writeFile(join(root, 'antd.css'), '.ant-btn { color: var(--ant-color-primary); }\n')
    await writeFile(join(root, 'tokens.css'), ':root { --ant-color-primary: var(--agnes-brand-primary); }\n')
    const response = await fetch(`${server.url}/antd.css`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await response.text()).toContain('--ant-color-primary')
    const tokens = await fetch(`${server.url}/tokens.css`)
    expect(tokens.status).toBe(200)
    expect(tokens.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await tokens.text()).toContain('--agnes-brand-primary')
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
    // The duplicate is only a duplicate once the first request holds the picker. One timer tick
    // does not guarantee that on a loaded runner, so wait for the picker to be called.
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 5_000 })
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
    expect(served.headers.get('content-security-policy')).not.toContain("'nonce-")
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

const viewerPolicy = (script: string) =>
  `sandbox allow-scripts; default-src 'none'; script-src ${script}; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`

async function withViewerServer(run: (url: string, mountProxy: ReturnType<typeof vi.fn>) => Promise<void>) {
  // An empty root: the viewer document is a constant and needs no build output.
  const root = await mkdtemp(join(tmpdir(), 'agnes-web-viewer-'))
  const port = await availablePort()
  const mountProxy = vi.fn(() => false)
  const server = await createWebServer({
    root,
    wsUrl: 'ws://127.0.0.1:4321',
    port,
    origin: `http://127.0.0.1:${port}`,
    developmentReload: true,
    mountProxy,
  })
  try {
    await run(`${server.url}${HTML_VIEWER_PATH}`, mountProxy)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

function viewerScript(document: string): string {
  const match =
    /^<!doctype html><html><head><meta charset="utf-8"><title><\/title><\/head><body><script>([\s\S]*)<\/script><\/body><\/html>$/.exec(
      document,
    )
  if (!match?.[1]) throw new Error('viewer document has no bootstrap')
  return match[1]
}

it('serves the sandboxed HTML viewer with its own policy for each script variant', async () => {
  await withViewerServer(async (url, mountProxy) => {
    expect(HTML_VIEWER_PATH).toBe('/__agnes/viewer/html')
    const scriptless = await fetch(`${url}?scripts=0`)
    expect(scriptless.status).toBe(200)
    const body = await scriptless.text()
    const hash = createHash('sha256').update(viewerScript(body), 'utf8').digest('base64')
    const headers = (variant: Response) =>
      Object.fromEntries(
        [
          'content-type',
          'cache-control',
          'content-security-policy',
          'referrer-policy',
          'x-content-type-options',
          'x-dns-prefetch-control',
          'permissions-policy',
        ].map((name) => [name, variant.headers.get(name)]),
      )
    const expected = (script: string) => ({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': viewerPolicy(script),
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-dns-prefetch-control': 'off',
      'permissions-policy':
        'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), clipboard-read=()',
    })
    expect(headers(scriptless)).toEqual(expected(`'sha256-${hash}'`))
    // The development reload client is never injected into the viewer.
    expect(body).not.toContain('reload.js')

    // A hash would make browsers ignore 'unsafe-inline', and 'self' would let content load page code.
    const scripted = await fetch(`${url}?scripts=1`)
    expect(headers(scripted)).toEqual(expected("'unsafe-inline'"))
    expect(await scripted.text()).toBe(body)

    for (const query of ['', '?scripts=true', '?scripts=01', '?scripts=1x', '?scripts', '?script=1']) {
      const other = await fetch(`${url}${query}`)
      expect(other.headers.get('content-security-policy'), query).toBe(viewerPolicy(`'sha256-${hash}'`))
    }
    const head = await fetch(`${url}?scripts=1`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-security-policy')).toBe(viewerPolicy("'unsafe-inline'"))
    expect(await head.text()).toBe('')
    const post = await fetch(url, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET, HEAD')
    // A mounted Surface is consulted only after this route, so it can never claim the viewer.
    expect(mountProxy).not.toHaveBeenCalled()
  })
})

// The bootstrap is browser code; happy-dom runs it here with the frame's globals. Sandbox, CSP and
// opaque origins are not modelled, so this pins only the bootstrap's own checks. Evaluation is on so
// that an inert content script is a real result; the only code it runs is this file's fixture.
function bootViewer(script: string, url: string, embedded = true) {
  const frame = new Window({
    url,
    settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
  })
  const page = { name: 'page' }
  if (embedded) Object.defineProperty(frame, 'parent', { configurable: true, value: page })
  new Function('window', 'document', 'location', 'DOMParser', script)(
    frame,
    frame.document,
    frame.location,
    frame.DOMParser,
  )
  const send = (data: unknown, from: { source?: unknown; origin?: string } = {}) =>
    frame.dispatchEvent(
      new frame.MessageEvent('message', {
        data,
        origin: from.origin ?? new URL(url).origin,
        source: (from.source ?? page) as never,
      }),
    )
  return { frame, page, send }
}

const viewerMessage = (overrides: Record<string, unknown> = {}) => ({
  kind: 'agnes.html-viewer/v1',
  html: '<html><head><base href="https://example.test/"><meta http-equiv="refresh" content="0;url=https://example.test/"><link rel="dns-prefetch" href="https://example.test/"></head><body><p id="content">chart</p><a id="away" href="https://example.test/">away</a><a id="fragment" href="#content">top</a><script>document.body.dataset.ran = "yes"</script></body></html>',
  lang: 'zh-CN',
  colorScheme: 'dark',
  tokens: { '--agnes-text-primary': '#111' },
  ...overrides,
})

it('the viewer bootstrap accepts only the first well-formed message from its embedding page', async () => {
  await withViewerServer(async (url) => {
    const script = viewerScript(await (await fetch(`${url}?scripts=0`)).text())
    const viewer = `${url}?scripts=0`

    // Opened as a top-level page, the bootstrap does nothing.
    const top = bootViewer(script, viewer, false)
    top.send(viewerMessage(), { source: top.frame })
    expect(top.frame.document.getElementById('content')).toBeNull()

    const { frame, page, send } = bootViewer(script, viewer)
    const untouched = () => expect(frame.document.getElementById('content')).toBeNull()
    send(viewerMessage(), { source: { name: 'another window' } })
    untouched()
    send(viewerMessage(), { origin: 'http://127.0.0.1:1' })
    untouched()
    for (const bad of [
      { kind: 'agnes.html-viewer/v2' },
      { html: 42 },
      { colorScheme: 'sepia' },
      { lang: 'zh_CN' },
      { tokens: null },
      { tokens: { '--other-token': 'red' } },
      { tokens: { '--agnes-text-primary': 'red; }' } },
      { tokens: { '--agnes-text-primary': 'a'.repeat(257) } },
    ]) {
      send(viewerMessage(bad))
      untouched()
    }

    send(viewerMessage(), { source: page })
    const document = frame.document
    expect(document.getElementById('content')?.textContent).toBe('chart')
    expect(document.querySelector('base, meta[http-equiv], link')).toBeNull()
    expect(document.documentElement.getAttribute('lang')).toBe('zh-CN')
    expect(document.documentElement.style.getPropertyValue('--agnes-text-primary')).toBe('#111')
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('dark')
    // The scriptless variant leaves the content's scripts inert.
    expect(document.body.dataset.ran).toBeUndefined()

    // Only the first accepted message counts.
    send(viewerMessage({ html: '<p id="content">replaced</p>' }))
    expect(document.getElementById('content')?.textContent).toBe('chart')

    // Only same-document fragment links may follow.
    const click = (id: string) => {
      const event = new frame.MouseEvent('click', { bubbles: true, cancelable: true })
      document.getElementById(id)?.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(click('away')).toBe(true)
    expect(click('fragment')).toBe(false)
    await frame.happyDOM.close()
    await top.frame.happyDOM.close()
  })
})

it('the viewer bootstrap runs content scripts only in the scripted variant', async () => {
  await withViewerServer(async (url) => {
    const script = viewerScript(await (await fetch(`${url}?scripts=1`)).text())
    const { frame, send } = bootViewer(script, `${url}?scripts=1`)
    send(viewerMessage())
    expect(frame.document.body.dataset.ran).toBe('yes')
    await frame.happyDOM.close()
  })
})
