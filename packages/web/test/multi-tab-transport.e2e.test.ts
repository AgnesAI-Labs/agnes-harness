import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { createWebServer } from '../src/serve.js'

it('reproduces six persistent streams stalling HTTP/1.1 and keeps eight polling tabs responsive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-tabs-'))
  let emit: ((event: { packageId: string; revision: string }) => void) | undefined
  await writeFile(
    join(root, 'legacy.html'),
    '<html><body>Legacy<script src="/legacy.js"></script></body></html>',
  )
  await writeFile(
    join(root, 'legacy.js'),
    `const source = new EventSource('/legacy-events'); source.addEventListener('graph', () => document.body.dataset.ready = 'yes');`,
  )
  await writeFile(
    join(root, 'index.html'),
    '<html><body>Current<script type="module" src="/client.js"></script><script type="module" src="/__agnes/dev/reload.js"></script></body></html>',
  )
  const bundle = await build({
    stdin: {
      contents: `import { startPluginHotReload } from './packages/web/src/client-modules/hot-reload.ts';
      startPluginHotReload({ intervalMs: 100, reconciler: { reload: async (id, rev) => { document.body.dataset.rev = rev } } });
      let count = 0; async function board() { await fetch('/api/board'); document.body.dataset.polls = String(++count); setTimeout(board, 100) }; void board();`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  })
  await writeFile(join(root, 'client.js'), bundle.outputFiles[0]!.contents)
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  const port = address.port
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const assets = new Map(
    await Promise.all(
      ['legacy.html', 'legacy.js', 'index.html', 'client.js'].map(
        async (name) => ['/' + name, await readFile(join(root, name))] as const,
      ),
    ),
  )
  const server = await createWebServer({
    root,
    port,
    origin: `http://127.0.0.1:${port}`,
    wsUrl: 'ws://127.0.0.1:1',
    token: 'synthetic',
    developmentReload: true,
    mountProxy: (request, response) => {
      // Reproduce the previous permanent-stream transport without weakening the fixed endpoint.
      if (request.url === '/legacy-events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
        response.write('event: graph\ndata: {}\n\n')
        return true
      }
      const body = assets.get(request.url ?? '')
      if (!body) return false
      response
        .writeHead(200, {
          'Content-Type': request.url?.endsWith('.js') ? 'text/javascript' : 'text/html',
          'Cache-Control': 'no-store',
        })
        .end(body)
      return true
    },
    subscribePluginEvents: (listener) => {
      emit = listener
      return () => {}
    },
    handleAdmin: async (request, response) => {
      if (request.url !== '/api/board') return false
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
      return true
    },
  })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.AGH_CHROMIUM_PATH ? { executablePath: process.env.AGH_CHROMIUM_PATH } : {}),
  })
  try {
    const legacy = await browser.newContext()
    try {
      for (let i = 0; i < 6; i++) {
        const page = await legacy.newPage()
        await page.goto(`${server.url}/legacy.html`)
        await page.waitForFunction(() => document.body.dataset.ready === 'yes')
      }
      const seventh = await legacy.newPage()
      await expect(seventh.goto(`${server.url}/index.html`, { timeout: 1500 })).rejects.toThrow(/Timeout/)
    } finally {
      await legacy.close()
    }
    const compatibility = await fetch(`${server.url}/plugins/events`, { signal: AbortSignal.timeout(2000) })
    expect(await compatibility.text()).toContain('event: graph')
    const current = await browser.newContext()
    try {
      const pages = await Promise.all(Array.from({ length: 8 }, () => current.newPage()))
      await Promise.all(
        pages.map(async (page) => {
          await page.goto(`${server.url}/index.html`, { timeout: 10000 })
          await page.waitForFunction(() => Number(document.body.dataset.polls) >= 2)
        }),
      )
      emit?.({ packageId: 'synthetic', revision: 'eight-tabs' })
      await Promise.all(
        pages.map((page) =>
          page.waitForFunction(() => document.body.dataset.rev === 'eight-tabs', undefined, {
            timeout: 5000,
          }),
        ),
      )
      expect(
        await Promise.all(pages.map((page) => page.evaluate(() => Number(document.body.dataset.polls)))),
      ).toEqual(expect.arrayContaining([expect.any(Number)]))
    } finally {
      await current.close()
    }
  } finally {
    await browser.close()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}, 45000)
