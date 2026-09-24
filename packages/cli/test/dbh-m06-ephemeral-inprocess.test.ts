// Deep Bug Hunt M-06, second independent dynamic source (adversarial-tester, group A). Test-only.
// In-process: production main() -p --ephemeral with a real test Host; the ladder's exit is injected so
// the test can look at the filesystem at the instant production's hardExit would terminate the
// process (exit + FLUSH_MS = 100 ms, bin.ts:304-307). Asserts the CORRECT behaviour.
// Oracle: cli-package design :82 "--ephemeral: 临时 AGNES_HOME，退出即删"; boot/inputs.ts:25.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { stampFor } from '@agnes/ai/testkit'
import type { TestHostOptions } from '@agnes/host/testkit'
import { createTestHost } from '@agnes/host/testkit'
import type { RequestBody } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { type MainIO, main } from '../src/bin.js'
import { slowProvider, TEST_LOCK } from './boot-host.js'

const FLUSH_MS = 100
/** A model call that does not react to abort (a provider/SDK that ignores the signal) until released. */
function unresponsiveProvider(
  onStart: () => void,
  release: Promise<void>,
): NonNullable<TestHostOptions['provider']> {
  return {
    models: () => [],
    async *infer(req: RequestBody) {
      onStart()
      yield {
        type: 'sent',
        stamp: stampFor(req),
      }
      await release
      yield { type: 'text_delta', delta: 'released' }
      yield { type: 'done', reason: 'stop' }
    },
  }
}

async function scenario(kind: 'print-honours-abort' | 'acp-inflight-prompt') {
  const root = mkdtempSync(join(tmpdir(), 'dbh-m06-inproc-'))
  const dataDir = join(root, 'data')
  const savedTmp = process.env.TMPDIR
  process.env.TMPDIR = root
  const ephemeral = (): string[] => readdirSync(root).filter((e) => e.startsWith('agnes-ephemeral-'))
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let announce: () => void = () => undefined
  const started = new Promise<void>((resolve) => {
    announce = resolve
  })
  const signals = new EventEmitter()
  let mainSettled = false
  const atHardExit: Array<{ code: number; leaked: string[]; mainSettled: boolean }> = []
  let exitObserved: () => void = () => undefined
  const observed = new Promise<void>((resolve) => {
    exitObserved = resolve
  })
  const stdout = Object.assign(new PassThrough(), { isTTY: false })
  const stderr = Object.assign(new PassThrough(), { isTTY: false })
  let out = ''
  stdout.on('data', (b: Buffer) => {
    out += String(b)
  })
  stderr.resume()
  const acpIn = Object.assign(new PassThrough(), { isTTY: false })
  const acp = kind === 'acp-inflight-prompt'
  const io: MainIO = {
    env: {},
    stdin: acp ? acpIn : Object.assign(Readable.from([]), { isTTY: true }),
    stdout,
    stderr,
    cwd: root,
    agnesVersion: '9.9.9',
    exit: (code) => {
      // hardExit: process.exitCode = code; setTimeout(process.exit, FLUSH_MS).unref()
      setTimeout(() => {
        atHardExit.push({ code, leaked: ephemeral(), mainSettled })
        exitObserved()
      }, FLUSH_MS)
    },
    signals,
  }
  mkdirSync(dataDir)
  const argv = acp
    ? ['--mode', 'acp', '--ephemeral', '--cwd', dataDir]
    : ['-p', 'take your time', '--ephemeral', '--cwd', dataDir]
  const run = main(argv, io, {
    lock: TEST_LOCK,
    createHostImpl: async () =>
      (
        await createTestHost({
          dataDir,
          provider: acp ? unresponsiveProvider(announce, released) : slowProvider(30_000, announce),
        })
      ).host,
  }).finally(() => {
    mainSettled = true
  })
  const reply = async (id: number): Promise<{ result?: { sessionId?: string } }> => {
    for (const deadline = performance.now() + 15_000; performance.now() < deadline; ) {
      const hit = out
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l) as { id?: number; method?: string; result?: { sessionId?: string } })
        .find((m) => m.id === id && m.method === undefined)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error(`no reply ${id}`)
  }
  const send = (m: Record<string, unknown>): void => {
    acpIn.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
  }
  try {
    if (acp) {
      send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
      await reply(1)
      send({ id: 2, method: 'session/new', params: { cwd: dataDir, mcpServers: [] } })
      const sessionId = (await reply(2)).result?.sessionId
      send({ id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] } })
    }
    await started
    const homesDuringTurn = ephemeral().length
    signals.emit('SIGINT')
    await observed
    return { homesDuringTurn, atHardExit: atHardExit[0] }
  } finally {
    release()
    acpIn.end()
    await run.catch(() => undefined)
    if (savedTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = savedTmp
    rmSync(root, { recursive: true, force: true })
  }
}

describe('DBH M-06 in-process: ephemeral home at the moment the ladder hard-exits', () => {
  it('control: a turn that honours the cancel disposes the home before the ladder exits', async () => {
    const r = await scenario('print-honours-abort')
    expect(r.homesDuringTurn).toBe(1)
    expect(r.atHardExit).toEqual({ code: 130, leaked: [], mainSettled: true })
  }, 30_000)

  // Trigger: one SIGINT while an ACP prompt is in flight. The cancel never reaches the turn (M-01), so
  // shutdown outlives the 5 s grace and the ladder hard-exits. The model call here only ends when the
  // test releases it after the observation, which stands in for a model call longer than the grace.
  it('ACP: a shutdown that outlives the 5 s grace: the home is gone when hardExit terminates the process', async () => {
    const r = await scenario('acp-inflight-prompt')
    expect(r.homesDuringTurn).toBe(1)
    expect(r.atHardExit).toEqual({ code: 130, leaked: [], mainSettled: true })
  }, 30_000)
})
