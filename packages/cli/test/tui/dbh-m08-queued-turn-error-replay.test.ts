// Deep Bug Hunt M-08 (adversarial-tester, group B). Assertions describe CORRECT behaviour:
// a failure on the current code is the reproduction.
//
// Oracle: packages/sdk/src/session.ts requestPrompt catch ("retry this prompt exactly once [only for
// SESSION_NOT_FOUND]. No other failure is safe to replay here."); packages/cli/src/modes/print.ts
// reasonFromThrow (TURN_ERROR is how daemon reports a turn that ran and ended in `error`);
// packages/daemon/src/local/methods/acp.ts session/prompt (user message enqueued and turn run before
// TURN_ERROR is thrown). A queued prompt whose turn was accepted and ran must not be sent again.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stampFor } from '@agnes/ai/testkit'
import { createLocalEndpoint } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import type { RequestBody } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'
import { createClient } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { FakeEndpoint } from '../fake-endpoint.js'

const SID = 'agnes:local:default:cli:dm:m08'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fakeScenario(laterPrompts: 'turn-error' | 'ok') {
  let prompts = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
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
        await gate
        return { stopReason: 'end_turn' }
      }
      // Same shape daemon's acp.ts raises after the turn was enqueued, run and ended in `error`.
      if (laterPrompts === 'turn-error')
        throw rpcError('INTERNAL_ERROR', { code: 'TURN_ERROR', turnEnd: { reason: 'error' } })
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
    term.feed('\r') // queued
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

it('[control] a queued prompt that succeeds is sent exactly once', async () => {
  const seen = await fakeScenario('ok')
  expect(seen.total, JSON.stringify(seen)).toBe(2)
})

it('[M-08] a queued prompt rejected with TURN_ERROR (already accepted and run) is not re-sent', async () => {
  const seen = await fakeScenario('turn-error')
  // Correct: `a` once + `b` once. Anything above 2 replays an executed turn.
  expect(seen.total, JSON.stringify(seen)).toBeLessThanOrEqual(2)
})

// Second, independent dynamic source: real SDK + local daemon endpoint + core + test host. The first
// inference is slow; every later inference fails with a non-retryable provider error, so core ends
// that turn with reason `error` and daemon answers session/prompt with TURN_ERROR. Observation is the
// durable ledger (user/message nodes) and the provider's own call counter.
function provider(firstDelayMs: number, laterFails: boolean, onCall: (n: number) => void) {
  let calls = 0
  return {
    models: () => [],
    async *infer(req: RequestBody, _opts: { signal: AbortSignal; toolNames: string[] }) {
      const n = ++calls
      onCall(n)
      yield {
        type: 'sent' as const,
        stamp: stampFor(req),
      }
      if (n === 1 || !laterFails) {
        if (n === 1) await sleep(firstDelayMs)
        yield { type: 'text_delta' as const, delta: `reply ${n}` }
        yield { type: 'done' as const, reason: 'stop' as const }
        return
      }
      yield {
        type: 'error' as const,
        reason: 'error' as const,
        code: 'AUTH' as const,
        message: 'provider refused',
        retryable: false,
      }
    },
  }
}

async function realScenario(failLater: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'dbh-m08-real-'))
  let calls = 0
  const { host } = await createTestHost({
    dataDir: dir,
    provider: provider(300, failLater, (n) => {
      calls = n
    }),
  })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  // Observation only: record each session/prompt RPC outcome as it leaves the real daemon endpoint.
  const promptRpc: string[] = []
  const handle = endpoint.handle.bind(endpoint)
  endpoint.handle = async (msg) => {
    const response = await handle(msg)
    if ((msg as { method?: string }).method === 'session/prompt') {
      const r = response as { error?: { data?: { code?: string } } } | undefined
      promptRpc.push(r?.error ? String(r.error.data?.code) : 'ok')
    }
    return response
  }
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: 80, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    term.feed('a')
    term.feed('\r')
    await vi.waitFor(() => expect(calls).toBe(1))
    term.feed('b')
    term.feed('\r') // queued behind the slow first turn
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 5_000 })
    // Provider-call samples once per second show whether replay is bounded or keeps going.
    const samples: number[] = []
    for (let i = 0; i < 4; i++) {
      await sleep(1_000)
      samples.push(calls)
    }
    const users = (await session.projectUI()).nodes
      .filter((node) => node.kind === 'user')
      .flatMap((node) => (node.kind === 'user' ? node.content : []))
      .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    const turns = (await session.projectUI()).turns.map((turn) => turn.status)
    const pending = (app as unknown as { pendingPrompts: unknown[] }).pendingPrompts.length
    // Once the chain stalls, `b` is still queued: the user's next ordinary submission drains it again.
    const bBefore = users.filter((text) => text === 'b').length
    const callsBeforeNext = calls
    const rpcBeforeNext = promptRpc.length
    term.feed('c')
    term.feed('\r')
    const samplesAfterNext: number[] = []
    for (let i = 0; i < 6; i++) {
      await sleep(500)
      samplesAfterNext.push(calls)
    }
    const usersAfterNext = (await session.projectUI()).nodes
      .filter((node) => node.kind === 'user')
      .flatMap((node) => (node.kind === 'user' ? node.content : []))
      .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    return {
      bAfterNextSubmit: usersAfterNext.filter((text) => text === 'b').length - bBefore,
      providerCallsAfterNextSubmit: calls,
      samplesAfterNext,
      providerCalls: callsBeforeNext,
      samples,
      promptRpc: promptRpc.slice(0, rpcBeforeNext),
      promptRpcAfterNextSubmit: promptRpc.length,
      rpcOutcomesAfterNext: promptRpc.slice(rpcBeforeNext).reduce<Record<string, number>>((acc, code) => {
        acc[code] = (acc[code] ?? 0) + 1
        return acc
      }, {}),
      cRowsAfterNext: usersAfterNext.filter((text) => text === 'c').length,
      pendingAtEnd: pending,
      users,
      bCount: users.filter((text) => text === 'b').length,
      turns,
    }
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

it('[control/real] a queued prompt that succeeds is recorded and inferred once', async () => {
  const seen = await realScenario(false)
  expect(seen.bCount, JSON.stringify(seen)).toBe(1)
  expect(seen.providerCalls, JSON.stringify(seen)).toBe(2)
  expect(seen.bAfterNextSubmit, JSON.stringify(seen)).toBe(0)
}, 20_000)

it('[M-08/real] a queued prompt whose turn ends in error is executed once, not replayed', async () => {
  const seen = await realScenario(true)
  // Correct: the ledger records user message `b` exactly once and the provider is asked twice.
  expect(seen.bCount, JSON.stringify(seen)).toBe(1)
  expect(seen.providerCalls, JSON.stringify(seen)).toBeLessThanOrEqual(2)
}, 20_000)
