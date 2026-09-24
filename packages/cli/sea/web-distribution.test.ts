import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, rename, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const entry = process.env.AGNES_SEA_BIN ?? process.env.AGNES_LOCAL_CLI
const local = !process.env.AGNES_SEA_BIN
it.skipIf(!entry)(
  'serves the delivered Web pages and their assets, and exposes missing critical files',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-web-delivery-'))
    let web: ReturnType<typeof spawn> | undefined
    let run: ((args: string[]) => Promise<unknown>) | undefined
    try {
      const distribution = join(root, 'distribution')
      await cp(dirname(resolve(entry as string)), distribution, { recursive: true })
      const executable = join(distribution, basename(entry as string))
      const binary = local ? process.execPath : executable
      const prefix = local ? [executable] : []
      const reservation = createServer()
      await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done))
      const address = reservation.address()
      if (!address || typeof address === 'string') throw new Error('missing reserved port')
      const port = address.port
      await new Promise<void>((done, reject) =>
        reservation.close((error) => (error ? reject(error) : done())),
      )
      const origin = `http://127.0.0.1:${port}`
      const env = { ...process.env, AGH_HOME: join(root, 'home'), AGNES_WEB_ORIGIN: origin }
      run = (args) =>
        promisify(execFile)(binary, [...prefix, ...args], {
          env,
          cwd: root,
          windowsHide: true,
          timeout: 15000,
        })
      web = spawn(binary, [...prefix, 'serve', '--port', String(port)], {
        env,
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let startupError: Error | undefined
      web.once('error', (error) => {
        startupError = error
      })
      web.stdout?.resume()
      web.stderr?.resume()
      const request = (path: string) => fetch(new URL(path, origin), { signal: AbortSignal.timeout(3000) })
      await expect
        .poll(
          async () => {
            if (startupError) throw startupError
            if (web?.exitCode !== null) throw new Error('Web process exited before readiness')
            try {
              const response = await request('/')
              await response.arrayBuffer()
              return response.status
            } catch {
              return 0
            }
          },
          { timeout: 30000 },
        )
        .toBe(200)
      for (const page of ['/', '/admin.html', '/resources.html']) {
        const response = await request(page)
        expect(response.status, page).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/html')
        const html = await response.text()
        const assets = [...html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)].map(
          (match) => match[1] as string,
        )
        expect(assets.length, page).toBeGreaterThan(0)
        for (const asset of assets) {
          const url = new URL(asset, new URL(page, origin))
          expect(url.origin).toBe(origin)
          const result = await request(url.pathname)
          expect(result.status, asset).toBe(200)
          expect(result.headers.get('content-type')).toMatch(
            asset.endsWith('.css') ? /text\/css/ : /javascript/,
          )
          expect((await result.text()).length, asset).toBeGreaterThan(0)
        }
      }
      for (const [file, path] of [
        ['app.js', '/app.js'],
        ['style.css', '/style.css'],
        ['index.html', '/'],
      ]) {
        const original = join(distribution, 'web', file as string)
        const hidden = `${original}.missing`
        await rename(original, hidden)
        try {
          const response = await request(path as string)
          expect(response.status).toBe(500)
          expect(await response.text()).toBe('web assets unavailable')
        } finally {
          await rename(hidden, original)
        }
        const restored = await request(path as string)
        expect(restored.status).toBe(200)
        await restored.arrayBuffer()
      }
    } finally {
      try {
        await run?.(['daemon', 'stop'])
      } finally {
        if (web && web.exitCode === null && web.signalCode === null) {
          const exited = once(web, 'exit')
          web.kill('SIGKILL')
          await exited
        }
        await rm(root, { recursive: true, force: true })
      }
    }
  },
  90000,
)
