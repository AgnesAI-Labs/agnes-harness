import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { isolatedRuntime } from './runtime.js'

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
