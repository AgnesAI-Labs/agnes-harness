// DBH CONC-001 verification. Production entry: main([], io, boot) on a dual TTY -> bin.ts:660-717.
// Real Host, real local endpoint, real signal ladder. The ONLY thing mocked is the dynamically
// imported `./commands/resources.js` module, whose load is exactly the `await` at bin.ts:701 that
// runs before `settled = run` at bin.ts:717; holding that import open turns a real-but-narrow
// startup window into a deterministic one. Asserts the CORRECT behaviour, so a failure here
// reproduces the defect.
//
// Oracle, independent of the line at fault: bin.ts:715-716's own comment on the next statement --
// "Assigned before the first await, so a signal arriving in the same tick already has something to
// wait for rather than closing on an empty promise." In the TUI branch that sentence is false:
// ECMAScript evaluates the argument object (including the awaited dynamic import at :701) before
// `runTui(...)` is called and long before `settled = run` executes. The ladder's close() (bin.ts:665-668)
// therefore reads `settled === Promise.resolve()` and tears the transport down under a run that has
// not started, which bin.ts:44-48 then reports as
// 'DAEMON_CONNECTION_CLOSED: local Daemon connection closed; retry the command.' -- an operational
// diagnostic telling the operator to retry, for a Ctrl-C they pressed themselves.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalBootDeps } from '../src/boot/local.js'
import { say, TEST_LOCK } from './boot-host.js'

const gate = vi.hoisted(() => {
  let enter: () => void = () => undefined
  let open: () => void = () => undefined
  const reached = new Promise<void>((resolve) => {
    enter = resolve
  })
  const held = new Promise<void>((resolve) => {
    open = resolve
  })
  return { reached, held, enter: () => enter(), open: () => open() }
})

// Held open on first import, which is the dynamic import at bin.ts:701.
vi.mock('../src/commands/resources.js', async () => {
  gate.enter()
  await gate.held
  return { createResourceController: () => undefined }
})

const { main } = await import('../src/bin.js')

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

const ALIVE = Symbol('tui still running')

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'dbh-conc-001-'))
  tmp.push(dir)
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 })
  stdout.resume()
  const stderr = Object.assign(new PassThrough(), { isTTY: false })
  let err = ''
  stderr.on('data', (b: Buffer) => {
    err += String(b)
  })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} })
  const signals = new EventEmitter()
  const exits: number[] = []
  const io = {
    env: { AGH_HOME: dir, NO_COLOR: '1' },
    stdin,
    stdout,
    stderr,
    cwd: dir,
    agnesVersion: '9.9.9',
    exit: (code: number) => exits.push(code),
    signals,
  }
  const boot: Partial<LocalBootDeps> = {
    lock: TEST_LOCK,
    createHostImpl: async () => (await createTestHost({ dataDir: dir, script: [say('hi')] })).host,
  }
  return { io, boot, signals, exits, err: () => err }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('DBH CONC-001: Ctrl-C during TUI startup must not report a daemon disconnect', () => {
  it('SIGINT while the startup import is still loading', async () => {
    const h = harness()
    const run = main([], h.io, h.boot) as Promise<number>
    await Promise.race([gate.reached, delay(20_000)])
    h.signals.emit('SIGINT')
    // Let the ladder's cancel + close run to completion before the startup await resolves.
    await delay(400)
    gate.open()
    const outcome = await Promise.race([run, delay(8_000).then(() => ALIVE)])
    if (outcome === ALIVE) {
      h.signals.emit('SIGINT')
      await Promise.race([run, delay(5_000)]).catch(() => undefined)
    }
    expect(
      {
        disconnectReported: /DAEMON_CONNECTION_CLOSED/.test(h.err()),
        returnedError: outcome === 1,
      },
      `returned=${String(outcome === ALIVE ? 'still running' : outcome)} exits=${JSON.stringify(h.exits)} stderr=${JSON.stringify(h.err())}`,
    ).toEqual({ disconnectReported: false, returnedError: false })
  }, 60_000)
})
