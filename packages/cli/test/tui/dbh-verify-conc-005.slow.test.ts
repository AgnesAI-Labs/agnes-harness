// DBH CONC-005 verification. Production entry: TuiApp.submit -> wakeQueuedPrompt
// (packages/cli-tui/src/app.ts:814-822) -> flushQueuedPrompts (:785-812), driven through the real
// FakeTerminal key path and the real SDK client over an in-process endpoint.
// Asserts the CORRECT behaviour, so a failure here reproduces the defect.
//
// Oracle, independent of the lines at fault:
//   - app.ts:814 function contract, verbatim: "Poll once per short interval while queued input
//     exists, covering a missed idle projection." After :802 unshifts the prompt back, queued input
//     DOES exist, so the poll must still be running.
//   - app.ts:796-800 states why SESSION_BUSY/OVERLOADED are the two codes that are safe to re-send:
//     "Only a prompt the daemon refused before recording it may be sent again." Putting it back in
//     the queue is therefore a commitment to send it, not a way to drop it.
// The re-arm at :820 is guarded by `this.pendingPrompts.length > 0`, and the wake's own resync
// triggers the flush (app.ts:528) whose shift at :790 empties the queue before resync settles. The
// re-arm is skipped, :770 is the only other caller of wakeQueuedPrompt in the file, and the queued
// prompt is stranded.
import { rpcError } from '@agnes/protocol'
import { createClient } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { FakeEndpoint } from '../fake-endpoint.js'

const SID = 'agnes:local:default:cli:dm:conc005'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function scenario(queuedOutcome: 'session-busy' | 'ok') {
  let prompts = 0
  let release!: () => void
  const firstTurn = new Promise<void>((resolve) => {
    release = resolve
  })
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: SID }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => ({
      sessionId: SID,
      upto: 0,
      generation: 1,
      opState: null,
      turns: [],
      nodes: [],
    }))
    .on('session/prompt', async () => {
      const n = ++prompts
      if (n === 1) {
        await firstTurn
        return { stopReason: 'end_turn' }
      }
      // The refusal app.ts:796-800 explicitly classifies as safe to re-send: the daemon turned the
      // prompt away before recording it.
      if (queuedOutcome === 'session-busy') throw rpcError('INTERNAL_ERROR', { code: 'SESSION_BUSY' })
      return { stopReason: 'end_turn' }
    })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    term.feed('a')
    term.feed('\r')
    await vi.waitFor(() => expect(prompts).toBe(1))
    expect(app.busy).toBe(true)
    term.feed('b')
    term.feed('\r') // queued while the first turn is in flight
    release()
    await vi.waitFor(() => expect(prompts).toBeGreaterThanOrEqual(2))
    const samples: number[] = []
    for (let i = 0; i < 4; i++) {
      await sleep(500)
      samples.push(prompts)
    }
    return { total: prompts, samples }
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
}

describe('DBH CONC-005: a re-queued prompt must keep being retried', () => {
  it('[control] a queued prompt that is accepted is sent exactly once', async () => {
    const seen = await scenario('ok')
    expect(seen.total, JSON.stringify(seen)).toBe(2)
  }, 30_000)

  it('a queued prompt refused with SESSION_BUSY is put back and retried', async () => {
    const seen = await scenario('session-busy')
    // Correct: "poll once per short interval WHILE queued input exists" (app.ts:814). The prompt is
    // still queued for the whole sampling window, so attempts must keep accruing across it. A flat
    // tail means the wake chain died and nothing is left to ignite the queue again.
    const first = seen.samples[0] as number
    const last = seen.samples.at(-1) as number
    expect({ stillRetrying: last > first }, JSON.stringify(seen)).toEqual({ stillRetrying: true })
  }, 30_000)
})
