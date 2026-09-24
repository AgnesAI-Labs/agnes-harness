// Deep Bug Hunt M-07 (adversarial-tester, group A). Test-only; asserts the CORRECT behaviour, so a
// failure reproduces the defect. Production path: main() TTY form -> installSignalLadder -> runTui,
// which writes ?1049h (modes/tui.ts:28) and then awaits session/new against a real test Host and the
// real local endpoint. The Host is wrapped only to delay createSession (a slow session open).
// The ladder's exit is injected; the terminal output is read FLUSH_MS (100 ms) after it, which is when
// production's hardExit (bin.ts:304-307) calls process.exit.
// Oracle: INV-04 / modes/tui.ts:91-92 "Do not strand the user's terminal in its alternate screen in
// that path"; cli-tui renderer.ts:135 stop() "Restore the shell"; the control below (signal after the
// TUI started) shows the same ladder restoring the screen before it exits.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Host } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type MainIO, main } from '../src/bin.js'
import type { LocalBootDeps } from '../src/boot/local.js'
import { say, TEST_LOCK } from './boot-host.js'

const FLUSH_MS = 100
const ENTER = '\x1b[?1049h'
const LEAVE = '\x1b[?1049l'

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

function harness(o: { gated: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'dbh-m07-'))
  tmp.push(dir)
  let out = ''
  const stdout = Object.assign(new PassThrough(), { isTTY: true })
  stdout.on('data', (b: Buffer) => {
    out += String(b)
  })
  const stderr = Object.assign(new PassThrough(), { isTTY: false })
  stderr.resume()
  let raw = false
  let rawEnabled = 0
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(value: boolean) {
      raw = value
      if (value) rawEnabled++
    },
  })
  const signals = new EventEmitter()
  const atExit: Array<{ code: number; screenAfterFlush: string }> = []
  let exitSeen: () => void = () => undefined
  const exited = new Promise<void>((resolve) => {
    exitSeen = resolve
  })
  let openGate: () => void = () => undefined
  const gate = o.gated
    ? new Promise<void>((resolve) => {
        openGate = resolve
      })
    : Promise.resolve()
  let createSessionCalls = 0
  const io: MainIO = {
    env: { AGH_HOME: dir },
    stdin,
    stdout,
    stderr,
    cwd: dir,
    agnesVersion: '9.9.9',
    exit: (code) => {
      setTimeout(() => {
        atExit.push({ code, screenAfterFlush: out })
        exitSeen()
      }, FLUSH_MS)
    },
    signals,
  }
  const boot: Partial<LocalBootDeps> = {
    lock: TEST_LOCK,
    createHostImpl: async () => {
      const { host } = await createTestHost({ dataDir: dir, script: [say('hi')] })
      return new Proxy(host, {
        get(target, prop) {
          if (prop === 'createSession')
            return async (options: Parameters<Host['createSession']>[0]) => {
              createSessionCalls++
              await gate
              return target.createSession(options)
            }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
  return {
    io,
    boot,
    stdin,
    signals,
    atExit,
    exited,
    openGate,
    raw: () => raw,
    rawEnabled: () => rawEnabled,
    out: () => out,
    createSessionCalls: () => createSessionCalls,
  }
}

/** True when the last alternate-screen entry in `screen` has been followed by a leave. */
const restored = (screen: string): boolean => {
  const lastEnter = screen.lastIndexOf(ENTER)
  return lastEnter >= 0 && screen.indexOf(LEAVE, lastEnter) > lastEnter
}

describe('DBH M-07: signal while the TUI is still opening its session', () => {
  it('control: SIGINT after the TUI started restores the alternate screen before the ladder exits', async () => {
    const h = harness({ gated: false })
    const running = main([], h.io, h.boot)
    try {
      await vi.waitFor(() => expect(h.raw()).toBe(true), { timeout: 15_000 })
      h.signals.emit('SIGINT')
      await h.exited
      const first = h.atExit[0]
      expect({
        code: first?.code,
        entered: first?.screenAfterFlush.includes(ENTER),
        restored: restored(first?.screenAfterFlush ?? ''),
      }).toEqual({
        code: 130,
        entered: true,
        restored: true,
      })
    } finally {
      await running
      h.stdin.destroy()
    }
  }, 30_000)

  // Scope probe (not the candidate itself): is the stranding specific to the opening phase, or does
  // the second-signal rung strand a fully started TUI as well?
  it('scope probe: two SIGINTs after the TUI started, screen restored by the time hardExit terminates', async () => {
    const h = harness({ gated: false })
    const running = main([], h.io, h.boot)
    try {
      await vi.waitFor(() => expect(h.raw()).toBe(true), { timeout: 15_000 })
      h.signals.emit('SIGINT')
      h.signals.emit('SIGINT')
      await h.exited
      const first = h.atExit[0]
      expect({ code: first?.code, restored: restored(first?.screenAfterFlush ?? '') }).toEqual({
        code: 130,
        restored: true,
      })
    } finally {
      await running
      h.stdin.destroy()
    }
  }, 30_000)

  it.each([
    ['one SIGINT (grace expires)', 1],
    ['two SIGINTs (second exits at once)', 2],
  ])(
    '%s while session/new is pending: screen restored by the time hardExit terminates',
    async (_name, count) => {
      const h = harness({ gated: true })
      const running = main([], h.io, h.boot)
      try {
        await vi.waitFor(
          () => {
            expect(h.out()).toContain(ENTER)
            expect(h.createSessionCalls()).toBe(1)
          },
          { timeout: 15_000 },
        )
        for (let i = 0; i < count; i++) h.signals.emit('SIGINT')
        await h.exited
        const first = h.atExit[0]
        expect(
          { code: first?.code, restored: restored(first?.screenAfterFlush ?? '') },
          `screen tail=${JSON.stringify(first?.screenAfterFlush.slice(-60))}`,
        ).toEqual({ code: 130, restored: true })
      } finally {
        h.openGate()
        await running
        h.stdin.destroy()
      }
    },
    30_000,
  )
})

describe('DBH M-07: a session that opens after the signal', () => {
  it('SIGINT while session/new is pending, then the open completes: the TUI never starts and main returns 130', async () => {
    const h = harness({ gated: true })
    const running = main([], h.io, h.boot)
    try {
      await vi.waitFor(
        () => {
          expect(h.out()).toContain(ENTER)
          expect(h.createSessionCalls()).toBe(1)
        },
        { timeout: 15_000 },
      )
      h.signals.emit('SIGINT')
      h.openGate()
      const code = await running
      expect({ code, rawEnabled: h.rawEnabled(), restored: restored(h.out()) }).toEqual({
        code: 130,
        rawEnabled: 0,
        restored: true,
      })
    } finally {
      h.openGate()
      await running.catch(() => undefined)
      h.stdin.destroy()
    }
  }, 30_000)
})
