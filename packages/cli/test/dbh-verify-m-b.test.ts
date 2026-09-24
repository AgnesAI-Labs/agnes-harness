// DBH M-B verification. Production entry: main(['install', ...], io, boot) -> bin.ts:550-562 ->
// confirmPackageInstall (bin.ts:749-759). Only `./commands/package.js` is mocked, so the readline
// prompt, the MainIO streams and bin.ts's own control flow are the real ones.
// Asserts the CORRECT behaviour, so a failure here reproduces the defect.
//
// Oracle, independent of bin.ts: readline's own documented contract. `rl.question(query, cb)` only
// invokes `cb` on a submitted line; on EOF the interface emits 'close' and the callback is never
// called, and Ctrl-C with no interface-level 'SIGINT' listener closes the interface the same way.
// confirmPackageInstall resolves its Promise only from inside that callback -- no 'close' fallback,
// no AbortSignal, no timeout -- so the promise never settles. bin.ts:550-562 awaits
// runPackageCommand inside a `try` whose `finally { await booted.close() }` therefore never runs:
// the daemon connection and the whole CLI hang with the user's terminal in raw mode.
// Contrast: every other interactive CLI surface in this repo gives the user a way out of a prompt.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalBootDeps } from '../src/boot/local.js'
import { say, TEST_LOCK } from './boot-host.js'

let confirmed: boolean | undefined
let prompted: (() => void) | undefined

vi.mock('../src/commands/package.js', () => ({
  runPackageCommand: async (
    _p: unknown,
    _client: unknown,
    io: { confirm(preview: { id: string; version: string; integrity: string }): Promise<boolean> },
  ) => {
    const answer = io.confirm({ id: 'example', version: '1.0.0', integrity: `sha256-${'a'.repeat(64)}` })
    prompted?.()
    confirmed = await answer
  },
}))

const { main } = await import('../src/bin.js')

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
  confirmed = undefined
  prompted = undefined
})

const HUNG = Symbol('main never returned')

function harness(ttyStdin = true) {
  const dir = mkdtempSync(join(tmpdir(), 'dbh-m-b-'))
  tmp.push(dir)
  let out = ''
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 })
  stdout.on('data', (b: Buffer) => {
    out += String(b)
  })
  const stderr = Object.assign(new PassThrough(), { isTTY: false })
  stderr.resume()
  const stdin = Object.assign(new PassThrough(), { isTTY: ttyStdin, setRawMode() {} })
  const io = {
    env: { AGH_HOME: dir, NO_COLOR: '1' },
    stdin,
    stdout,
    stderr,
    cwd: dir,
    agnesVersion: '9.9.9',
    exit: () => undefined,
    signals: new EventEmitter(),
  }
  const boot: Partial<LocalBootDeps> = {
    lock: TEST_LOCK,
    createHostImpl: async () => (await createTestHost({ dataDir: dir, script: [say('hi')] })).host,
  }
  return { io, boot, stdin, out: () => out }
}

/** Runs `agnes install`, waits until the real prompt is on screen, then sends `keys`. */
async function install(keys: string) {
  const h = harness()
  const reached = new Promise<void>((resolve) => {
    prompted = resolve
  })
  const run = main(['install', 'npm:example@1.0.0'], h.io, h.boot) as Promise<number>
  await Promise.race([reached, new Promise((r) => setTimeout(r, 20_000))])
  for (const deadline = performance.now() + 5_000; !h.out().includes('Install example'); ) {
    if (performance.now() > deadline) throw new Error(`prompt never rendered; stdout=${h.out()}`)
    await new Promise((r) => setTimeout(r, 5))
  }
  if (keys === '') h.stdin.end()
  else h.stdin.write(keys)
  const outcome = await Promise.race([run, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), 2_000))])
  return { outcome, confirmed, stdout: h.out() }
}

/** INV-33: without a TTY the command previews and declines. It must never prompt, never guess. */
async function installNonTty() {
  const h = harness(false)
  const outcome = await Promise.race([
    main(['install', 'npm:example@1.0.0'], h.io, h.boot) as Promise<number>,
    new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), 2_000)),
  ])
  return { outcome, confirmed, stdout: h.out() }
}

describe('DBH M-B: the install prompt must settle when the user declines to answer', () => {
  it('[control] answering "y" resolves the prompt and the command exits 0', async () => {
    const r = await install('y\r')
    expect({ outcome: r.outcome, confirmed: r.confirmed }).toEqual({ outcome: 0, confirmed: true })
  }, 60_000)

  // Preservation: the fix reorders resolve/close and adds a 'close' settlement, so the two
  // previously-correct paths through the same prompt have to be pinned down before it lands.
  it('[preserve] answering "n" resolves the prompt as "no" and the command exits 0', async () => {
    const r = await install('n\r')
    expect({ outcome: r.outcome === HUNG ? 'hung' : r.outcome, confirmed: r.confirmed }).toEqual({
      outcome: 0,
      confirmed: false,
    })
  }, 60_000)

  it('[preserve] a non-TTY stdin declines without ever rendering a prompt (INV-33)', async () => {
    const r = await installNonTty()
    expect({
      outcome: r.outcome === HUNG ? 'hung' : r.outcome,
      confirmed: r.confirmed,
      prompted: r.stdout.includes('Install example'),
    }).toEqual({ outcome: 0, confirmed: false, prompted: false })
  }, 60_000)

  it('stdin EOF settles the prompt as "no" instead of hanging the CLI', async () => {
    const r = await install('')
    expect({ outcome: r.outcome === HUNG ? 'hung' : r.outcome, confirmed: r.confirmed }).toEqual({
      outcome: 0,
      confirmed: false,
    })
  }, 60_000)

  it('Ctrl-C settles the prompt instead of hanging the CLI', async () => {
    const r = await install('\x03')
    expect({ outcome: r.outcome === HUNG ? 'hung' : r.outcome, confirmed: r.confirmed }).toEqual({
      outcome: 0,
      confirmed: false,
    })
  }, 60_000)
})
