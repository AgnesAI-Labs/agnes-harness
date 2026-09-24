// Deep Bug Hunt M-03 (adversarial-tester, group A). Test-only; asserts the CORRECT behaviour, so a
// failure reproduces the defect. Production path: main() -> installSignalLadder -> runPrint ->
// readPromptInput (non-TTY stdin) -> openSession -> session.prompt, with a real Host and endpoint.
// Oracle: boot/signals.ts:18 "the first signal asks the turn to stop"; cli-package design :126
// (signal => cancel, exit 130/143/129); sibling runTui (modes/tui.ts:79-81) does not send its initial
// prompt once a signal has arrived. Assembly copied from signal-turn.test.ts (not modified).
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createTestHost } from '@agnes/host/testkit'
import { createClient, memoryJournal } from '@agnes/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { type MainIO, main } from '../src/bin.js'
import type { LocalBootDeps } from '../src/boot/local.js'
import type { SignalName } from '../src/errors.js'
import { runPrint } from '../src/modes/print.js'
import type { Booted } from '../src/types.js'
import { slowProvider, TEST_LOCK } from './boot-host.js'
import { FAKE_SESSION_ID, scriptedEndpoint } from './fake-endpoint.js'

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'dbh-m03-'))
  tmp.push(d)
  return d
}

function harness(dir: string, delayMs: number) {
  const stdout = Object.assign(new PassThrough(), { isTTY: false })
  const stderr = Object.assign(new PassThrough(), { isTTY: false })
  const stdin = Object.assign(new PassThrough(), { isTTY: false })
  let out = ''
  let err = ''
  stdout.on('data', (b: Buffer) => {
    out += String(b)
  })
  stderr.on('data', (b: Buffer) => {
    err += String(b)
  })
  const signals = new EventEmitter()
  const exits: number[] = []
  let inferCalls = 0
  const io: MainIO = {
    env: { AGH_HOME: dir },
    stdin,
    stdout,
    stderr,
    cwd: dir,
    agnesVersion: '9.9.9',
    exit: (c) => exits.push(c),
    signals,
  }
  const boot: Partial<LocalBootDeps> = {
    lock: TEST_LOCK,
    createHostImpl: async () =>
      (
        await createTestHost({
          dataDir: dir,
          provider: slowProvider(delayMs, () => {
            inferCalls++
          }),
        })
      ).host,
  }
  return { io, boot, stdin, signals, exits, inferCalls: () => inferCalls, out: () => out, err: () => err }
}

describe('DBH M-03: print mode, signal before the prompt is sent', () => {
  it('control: no signal, piped stdin reaches the model and exits 0', async () => {
    const h = harness(scratch(), 1)
    const run = main(['-p', 'x'], h.io, h.boot)
    await vi.waitFor(() => expect(h.signals.listenerCount('SIGINT')).toBeGreaterThan(0), { timeout: 10_000 })
    h.stdin.end('piped')
    expect(await run).toBe(0)
    expect(h.inferCalls()).toBe(1)
    expect(h.exits).toEqual([])
  }, 20_000)

  it('SIGINT while waiting for piped stdin: no prompt reaches the model, exit 130', async () => {
    const h = harness(scratch(), 1_000)
    const run = main(['-p', 'x'], h.io, h.boot)
    // Barrier: the ladder is installed only after boot, immediately before runPrint starts reading stdin.
    await vi.waitFor(() => expect(h.signals.listenerCount('SIGINT')).toBeGreaterThan(0), { timeout: 10_000 })
    h.signals.emit('SIGINT')
    h.stdin.end('piped')
    const code = await run
    await new Promise((r) => setTimeout(r, 50))
    expect(
      { inferCalls: h.inferCalls(), code, exits: h.exits },
      `stdout=${JSON.stringify(h.out())} stderr=${JSON.stringify(h.err())}`,
    ).toEqual({ inferCalls: 0, code: 130, exits: [130] })
  }, 20_000)
})

// Deterministic windows through runPrint itself: the signal accessor is the one bin.ts hands it, and
// the endpoint records whether a session was opened or a prompt sent.
describe('DBH M-03: runPrint checks for a signal before each step that commits to a turn', () => {
  async function scenario(o: { signalDuringStdin?: SignalName; signalDuringOpen?: SignalName }) {
    let current: SignalName | undefined
    const endpoint = scriptedEndpoint().on('session/new', () => {
      if (o.signalDuringOpen) current = o.signalDuringOpen
      return { sessionId: FAKE_SESSION_ID }
    })
    const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
    const booted: Booted = {
      client,
      profileName: 'local-dev',
      resolvedProfileHash: 'h',
      bootMs: 1,
      form: 'local',
      close: () => client.close(),
    }
    const stdin = Object.assign(new PassThrough(), { isTTY: false })
    const stderr = new PassThrough()
    let err = ''
    stderr.on('data', (b: Buffer) => {
      err += String(b)
    })
    try {
      const run = runPrint(booted, parseArgs(['-p', 'x']), {
        stdout: new PassThrough(),
        stderr,
        stdin,
        cwd: '/w',
        signal: () => current,
      })
      if (o.signalDuringStdin) current = o.signalDuringStdin
      stdin.end('piped')
      const code = await run
      const methods = endpoint.calls.map((call) => call.method)
      return {
        code,
        opened: methods.filter((m) => m === 'session/new').length,
        prompted: methods.filter((m) => m === 'session/prompt').length,
        err,
      }
    } finally {
      await client.close()
    }
  }

  it('control: no signal opens one session and sends the prompt', async () => {
    expect(await scenario({})).toMatchObject({ code: 0, opened: 1, prompted: 1 })
  })

  it('a signal while stdin is still being read opens no session and sends no prompt', async () => {
    const r = await scenario({ signalDuringStdin: 'SIGINT' })
    expect(r).toMatchObject({ code: 130, opened: 0, prompted: 0 })
    expect(r.err).toContain('SIGINT; prompt not sent (exit 130)')
  })

  it('a signal while the session opens sends no prompt and leaves with that signal code', async () => {
    const r = await scenario({ signalDuringOpen: 'SIGTERM' })
    expect(r).toMatchObject({ code: 143, opened: 1, prompted: 0 })
    expect(r.err).toContain('SIGTERM; prompt not sent (exit 143)')
  })
})
