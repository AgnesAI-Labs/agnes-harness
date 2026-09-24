import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { type MainIO, main } from '../src/bin.js'
import type { LocalBootDeps } from '../src/boot/local.js'
import { slowProvider, TEST_LOCK } from './boot-host.js'

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agnes-sig-'))
  tmp.push(d)
  return d
}

/**
 * A signal delivered into a turn that is genuinely running: a real host, a real local endpoint, a
 * real sdk client, and a provider that sits in the middle of an inference until it is aborted. The
 * pieces this exercises together were each covered on their own and never in company, which is where
 * the two defects below lived.
 */
function harness(dir: string, delayMs = 30_000) {
  const stdout = Object.assign(new PassThrough(), { isTTY: false })
  const stderr = Object.assign(new PassThrough(), { isTTY: false })
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
  let announceTurnStarted: () => void = () => undefined
  const turnStarted = new Promise<void>((resolve) => {
    announceTurnStarted = resolve
  })
  const io: MainIO = {
    env: { AGH_HOME: dir },
    stdin: Object.assign(Readable.from([]), { isTTY: true }),
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
      (await createTestHost({ dataDir: dir, provider: slowProvider(delayMs, announceTurnStarted) })).host,
  }
  return { io, boot, signals, exits, turnStarted, out: () => out, err: () => err }
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('a signal arriving during a live turn', () => {
  // The defect this pins: the ladder used to close the transport as soon as the cancel was sent,
  // while the prompt request was still in flight. The request then failed as a transport closure
  // rather than coming back as `aborted`, and the run exited 1 instead of with the signal's code.
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ])(
    '%s ends the turn as aborted and exits %d',
    async (sig, code) => {
      const h = harness(scratch())
      const run = main(['-p', 'take your time'], h.io, h.boot)
      await h.turnStarted
      h.signals.emit(sig)
      expect(await run).toBe(code)
      // The reason word, so a wrapper can tell an abort from a failure that shares no code with it.
      expect(h.err()).toContain('turn ended: aborted')
      expect(h.err()).toContain(`(exit ${code})`)
    },
    20_000,
  )

  // The second defect: `aborted` alone does not say which code to leave with. It was pinned to 130,
  // so `kill -TERM` on a running one-shot reported a Ctrl-C, and the ladder's own exit(143) raced
  // the 130 the run had already decided on. Both routes now name the same number.
  it('the ladder and the run agree on the number, rather than racing to different ones', async () => {
    const h = harness(scratch())
    const run = main(['-p', 'take your time'], h.io, h.boot)
    await h.turnStarted
    h.signals.emit('SIGTERM')
    const returned = await run
    await settle(50)
    expect(returned).toBe(143)
    expect(h.exits).toEqual([143])
  }, 20_000)

  it('a second signal leaves at once, without waiting for the first shutdown', async () => {
    const h = harness(scratch())
    const run = main(['-p', 'take your time'], h.io, h.boot)
    await h.turnStarted
    h.signals.emit('SIGHUP')
    h.signals.emit('SIGINT')
    // The second signal's own code goes first, before the shutdown the first one started finishes.
    expect(h.exits[0]).toBe(130)
    expect(await run).toBe(129)
  }, 20_000)

  it('no signal at all leaves the ladder unused and the turn to finish on its own terms', async () => {
    const h = harness(scratch(), 1)
    expect(await main(['-p', 'quick'], h.io, h.boot)).toBe(0)
    expect(h.exits).toEqual([])
    expect(h.out()).toBe('too late\n')
  }, 20_000)

  // The case a rule written only for `aborted` gets wrong. A cancel is a request, not a stop: a turn
  // can finish between the signal arriving and the cancel landing, and then the run's own reason is
  // `completed`. Reporting 0 there tells a caller that sent SIGTERM that nothing happened, and it is
  // also how the ladder's own exit and the run's return came to be different numbers.
  it('a signal that arrives just as the turn completes still reports the signal', async () => {
    const h = harness(scratch(), 150)
    const run = main(['-p', 'quick'], h.io, h.boot)
    await h.turnStarted
    await settle(120)
    h.signals.emit('SIGTERM')
    expect(await run).toBe(143)
    expect(h.err()).toContain('(exit 143)')
  }, 20_000)
})
