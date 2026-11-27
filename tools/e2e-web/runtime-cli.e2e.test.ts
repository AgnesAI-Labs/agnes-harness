import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { isolatedRuntime } from './runtime.js'

async function listen(server: Server, port: number): Promise<void> {
  const ready = once(server, 'listening')
  server.listen(port, '127.0.0.1')
  await ready
}

it('rejects a colliding workbench response and disposes while the foreign listener stays live', async () => {
  const runtime = await isolatedRuntime()
  const html = '<meta id="agnes-config" data-ws="ws://127.0.0.1:9/rpc">'
  const other = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(html)
  })
  try {
    try {
      await listen(other, Number(new URL(runtime.url).port))
      await expect.soft(runtime.start()).rejects.toThrow('serve exited:')
      expect.soft(runtime.starts()).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
    expect(runtime.logs()).toContain('The Web port is already in use')
    const response = await fetch(runtime.url, { signal: AbortSignal.timeout(1_000) })
    expect(await response.text()).toBe(html)
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()))
  }
}, 60_000)

it('removes the isolated root when another listener takes the port during disposal', async () => {
  const runtime = await isolatedRuntime()
  const port = Number(new URL(runtime.url).port)
  const replacement = createServer((_request, response) => response.end('Replacement listener'))
  let disposal: Promise<boolean> | undefined
  try {
    await runtime.start()
    let rebound = false
    // Start trying while serve is still running so the replacement can bind as soon as the port opens.
    const listening = vi
      .waitFor(() => listen(replacement, port), { timeout: 10_000, interval: 20 })
      .then(() => {
        rebound = true
      })
    disposal = runtime.dispose().then(() => rebound)
    await Promise.allSettled([listening, disposal])
    await expect(listening).resolves.toBeUndefined()
    await expect(disposal).resolves.toBe(true)
    await expect(access(dirname(runtime.home))).rejects.toHaveProperty('code', 'ENOENT')
    const response = await fetch(runtime.url, { signal: AbortSignal.timeout(1_000) })
    expect(await response.text()).toBe('Replacement listener')
  } finally {
    await new Promise<void>((resolve) => replacement.close(() => resolve()))
    if (!disposal) await runtime.dispose()
  }
}, 170_000)

it('lets daemon stop finish a legitimate drain within its existing inner deadline', async () => {
  const runtime = await isolatedRuntime()
  const require = createRequire(import.meta.url)
  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(require.resolve('tsx')).href,
      fileURLToPath(new URL('./test/slow-shutdown.ts', import.meta.url)),
      runtime.home,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let log = ''
  child.stderr.on('data', (chunk) => {
    log += chunk
  })
  const exited = new Promise<number | null>((done) => child.once('exit', done))
  const safety = setTimeout(() => child.kill('SIGKILL'), 45_000)
  try {
    await new Promise<void>((done, reject) => {
      child.stdout.on('data', (chunk) => {
        log += chunk
        if (log.includes('READY\n')) done()
      })
      child.once('exit', () => reject(new Error(`Shutdown fixture exited before ready: ${log}`)))
      child.once('error', reject)
    })
    let stop: string | undefined
    let error: unknown
    const started = Date.now()
    try {
      stop = await runtime.cli(['daemon', 'stop'])
    } catch (cause) {
      error = cause
    }
    // The daemon keeps its valid drain even if a too-short CLI watchdog already killed its waiter.
    expect(await exited, log).toBe(0)
    const drainStart = Number(await readFile(join(runtime.home, 'drain-start'), 'utf8'))
    const drainEnd = Number(await readFile(join(runtime.home, 'drain-complete'), 'utf8'))
    expect(drainEnd - drainStart).toBeGreaterThanOrEqual(21_000)
    expect(
      await access(join(runtime.home, 'daemon/owner.json')).then(
        () => false,
        () => true,
      ),
    ).toBe(true)
    console.log(
      JSON.stringify({
        cliElapsedMs: Date.now() - started,
        drainMs: drainEnd - drainStart,
        stop,
        error: String(error),
      }),
    )
    expect(error).toBeUndefined()
    expect(stop).toBe('stopped\n')
  } finally {
    clearTimeout(safety)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    await runtime.dispose()
  }
}, 50_000)
