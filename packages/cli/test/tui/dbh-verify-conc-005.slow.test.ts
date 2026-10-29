// DBH CONC-005 verification. Production entry: TuiApp.submit -> BusyInput.prompt
// (packages/cli-tui/src/busy-input.ts), driven through the real FakeTerminal key path and the real SDK
// client over an in-process endpoint.
// Asserts the CORRECT behaviour, so a failure here reproduces the defect.
//
// The defect was a prompt put back into a client-side queue after a SESSION_BUSY refusal whose retry
// chain could die and strand it. This client keeps no queue now. Oracle: a prompt the daemon refuses
// as busy was not recorded, so it is handed to the daemon's followUp queue, which runs it by itself
// once the turn ends. It must be delivered exactly once, never stranded and never sent again.
import { rpcError } from '@agnes/protocol'
import { createClient } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { FakeEndpoint } from '../fake-endpoint.js'

const SID = 'agnes:local:default:cli:dm:conc005'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function scenario(outcome: 'session-busy' | 'ok') {
  const prompts: string[] = []
  const followUps: string[] = []
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
    .on('_agnes/v1/submit', (params) => {
      const p = params as { kind: string; payload: { content: Array<{ text?: string }> } }
      if (p.kind === 'followUp') followUps.push(p.payload.content[0]?.text ?? '')
      return { seq: 1, replayed: false }
    })
    .on('_agnes/v1/submit.ack', () => ({}))
    .on('session/prompt', async (params) => {
      prompts.push((params as { prompt: Array<{ text?: string }> }).prompt[0]?.text ?? '')
      // The refusal the daemon gives before it records anything: another prompt is still in flight.
      if (outcome === 'session-busy') throw rpcError('INTERNAL_ERROR', { code: 'SESSION_BUSY' })
      return { stopReason: 'end_turn' }
    })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    term.feed('b')
    term.feed('\r')
    await vi.waitFor(() => expect(prompts).toEqual(['b']))
    await vi.waitFor(() => expect(app?.busy).toBe(false))
    const samples: number[] = []
    for (let i = 0; i < 4; i++) {
      await sleep(500)
      samples.push(prompts.length + followUps.length)
    }
    return { prompts, followUps, samples }
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
}

describe('DBH CONC-005: a prompt refused as busy is delivered exactly once', () => {
  it('[control] an accepted prompt is sent exactly once and queues nothing', async () => {
    const seen = await scenario('ok')
    expect(seen, JSON.stringify(seen)).toEqual({ prompts: ['b'], followUps: [], samples: [1, 1, 1, 1] })
  }, 30_000)

  it('a prompt refused with SESSION_BUSY is queued in the daemon once, not stranded or re-sent', async () => {
    const seen = await scenario('session-busy')
    expect(seen, JSON.stringify(seen)).toEqual({ prompts: ['b'], followUps: ['b'], samples: [2, 2, 2, 2] })
  }, 30_000)
})
