// DBH INV-004 verification. Production path: main(['/help'], io, boot) -> args.ts:103 (`/help` is
// not in COMMANDS, so it stays a positional) -> args.ts:176-189 resolveMode -> 'tui' on a dual TTY
// -> bin.ts:692-704 -> runTui -> modes/tui.ts:97-98 `await tui.submit(...)`, which has no try/catch
// and no `.catch`. Real Host (createTestHost), real local endpoint, real TuiApp.
// Asserts the CORRECT behaviour, so a failure here reproduces the defect.
//
// Oracle, independent of modes/tui.ts:
//   - packages/cli-tui/src/app.ts:239-241 -- the editor's own submit path wraps the identical call
//     in `void task.catch((error) => this.showError(error))`, and routes a leading `/` to
//     `this.command(text)` instead of `submit()`.
//   - packages/cli-tui/src/app.ts:652-655 -- the function comment for `command()` states failures
//     "reach the caller through the same `.catch(...)` the editor's `onSubmit` already wraps
//     `submit()` in". modes/tui.ts:98 is the second caller of submit() and is not inside that catch.
//   - packages/cli-tui/src/app.ts:760 -- `if (text.startsWith('/')) throw new Error('Command
//     unavailable')`, so this entry point is a deterministic throw, not a rare failure.
// A TUI that cannot run a slash command from argv should say so in its own UI; it must not die with
// a raw Node stack (bin.ts:738-743) on the user's terminal.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { type MainIO, main } from '../src/bin.js'
import type { LocalBootDeps } from '../src/boot/local.js'
import { say, TEST_LOCK } from './boot-host.js'

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

const ALIVE = Symbol('tui still running')

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'dbh-inv-004-'))
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
  const io: MainIO = {
    env: { AGH_HOME: dir, NO_COLOR: '1' },
    stdin,
    stdout,
    stderr,
    cwd: dir,
    agnesVersion: '9.9.9',
    exit: (code) => exits.push(code),
    signals,
  }
  const boot: Partial<LocalBootDeps> = {
    lock: TEST_LOCK,
    createHostImpl: async () => (await createTestHost({ dataDir: dir, script: [say('hi')] })).host,
  }
  return { io, boot, signals, exits, err: () => err }
}

/** Runs main() until it returns or the TUI proves it is still alive, then shuts the TUI down. */
async function runUntilSettled(argv: string[], budgetMs: number) {
  const h = harness()
  const run = main(argv, h.io, h.boot)
  const outcome = await Promise.race([
    run,
    new Promise<typeof ALIVE>((resolve) => setTimeout(() => resolve(ALIVE), budgetMs)),
  ])
  if (outcome === ALIVE) {
    h.signals.emit('SIGTERM')
    await Promise.race([run, new Promise((r) => setTimeout(r, 5_000))]).catch(() => undefined)
  }
  return { outcome, stderr: h.err(), exits: h.exits }
}

const STACK_LINE = /\n\s+at\s/

describe('DBH INV-004: a slash command passed on argv must not crash the TUI with a raw stack', () => {
  it('[control] a plain argv prompt leaves the TUI running and prints no stack', async () => {
    const r = await runUntilSettled(['hi'], 5_000)
    expect({ alive: r.outcome === ALIVE, stack: STACK_LINE.test(r.stderr) }, r.stderr).toEqual({
      alive: true,
      stack: false,
    })
  }, 40_000)

  it('`agnes "/help"` resolves to tui mode with /help as a positional', () => {
    const p = parseArgs(['/help'])
    expect({ command: p.command, positional: p.positional }).toEqual({
      command: undefined,
      positional: ['/help'],
    })
  })

  it('`agnes "/help"` does not exit 1 with a raw stack on stderr', async () => {
    const r = await runUntilSettled(['/help'], 5_000)
    expect(
      { exited: r.outcome === ALIVE ? 'still running' : r.outcome, stack: STACK_LINE.test(r.stderr) },
      r.stderr,
    ).toEqual({ exited: 'still running', stack: false })
  }, 40_000)
})
