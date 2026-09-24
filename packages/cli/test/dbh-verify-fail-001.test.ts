// DBH FAIL-001 verification. Real Host (createTestHost), real daemon LocalEndpoint (bootLocal via
// production main()), real signal ladder driven through io.signals. Production entry:
// main(['--mode','acp'], io, boot) -> bin.ts:683-690 -> runAcp (src/modes/acp.ts:12).
// Asserts the CORRECT behaviour, so a failure here reproduces the defect.
//
// Oracle, independent of modes/acp.ts:
//   - packages/cli/src/errors.ts:45-48 -- "a signalled run leaves with the signal's code whatever
//     the turn managed to report first, which is also the only way the ladder's own exit and the
//     run's return can be the same number."
//   - packages/cli/src/bin.ts:652-654 -- "The ladder exits with the same number by its own route,
//     so the two cannot disagree."
//   - The sibling branches bin.ts:692-704 (tui) and :705-714 (print) both pass `signal: () => signal`
//     so their run can report the signal's code; the acp branch (:683-690) does not, and
//     modes/acp.ts:23 returns ExitCode.OK unconditionally.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { type MainIO, main } from '../src/bin.js'
import { say, TEST_LOCK } from './boot-host.js'

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'dbh-fail-001-'))
  tmp.push(d)
  return d
}

type Wire = { id?: number; method?: string; result?: unknown; error?: unknown }

function harness(dir: string) {
  const stdin = Object.assign(new PassThrough(), { isTTY: false })
  const stdout = Object.assign(new PassThrough(), { isTTY: false })
  const stderr = Object.assign(new PassThrough(), { isTTY: false })
  const messages: Wire[] = []
  let buffer = ''
  stdout.on('data', (chunk: Buffer) => {
    buffer += String(chunk)
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      messages.push(JSON.parse(buffer.slice(0, nl)) as Wire)
      buffer = buffer.slice(nl + 1)
    }
  })
  let err = ''
  stderr.on('data', (chunk: Buffer) => {
    err += String(chunk)
  })
  const signals = new EventEmitter()
  const exits: number[] = []
  const io: MainIO = {
    env: { AGH_HOME: dir },
    stdin,
    stdout,
    stderr,
    cwd: dir,
    agnesVersion: '9.9.9',
    exit: (code) => exits.push(code),
    signals,
  }
  const run = main(['--mode', 'acp'], io, {
    lock: TEST_LOCK,
    createHostImpl: async () =>
      (await createTestHost({ dataDir: dir, script: [say('hello from the test host')] })).host,
  })
  const reply = async (id: number, ms: number): Promise<Wire> => {
    const deadline = performance.now() + ms
    for (;;) {
      const found = messages.find((m) => m.id === id && m.method === undefined)
      if (found) return found
      if (performance.now() > deadline) throw new Error(`no reply to ${id} in ${ms}ms; stderr=${err}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  return { stdin, io, signals, exits, run, reply, err: () => err }
}

const settled = async (test: () => boolean, ms: number): Promise<void> => {
  for (const deadline = performance.now() + ms; !test(); ) {
    if (performance.now() > deadline) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('DBH FAIL-001: a signal during `agnes acp` must set the run exit code too', () => {
  it('[control] plain stdin EOF returns 0 and the ladder never exits', async () => {
    const h = harness(scratch())
    h.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
    )
    expect((await h.reply(1, 15_000)).error).toBeUndefined()
    h.stdin.end()
    expect(await h.run).toBe(0)
    expect(h.exits).toEqual([])
  }, 40_000)

  it('SIGTERM makes main() return 143, the same number the ladder exits with', async () => {
    const h = harness(scratch())
    h.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
    )
    expect((await h.reply(1, 15_000)).error).toBeUndefined()
    h.signals.emit('SIGTERM')
    const returned = await h.run
    await settled(() => h.exits.length > 0, 5_000)
    expect({ returned, exits: h.exits }, `stderr=${h.err()}`).toEqual({ returned: 143, exits: [143] })
  }, 40_000)
})
