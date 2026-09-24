// Deep Bug Hunt M-11 (adversarial-tester, group B). Assertions describe CORRECT behaviour:
// a failure on the current code is the reproduction.
//
// Oracle: INV-14 and packages/cli/test/tui/permission-modal.test.ts ("paginates full input while
// keeping controls visible and blocks unseen positive choices"): only an allow-type option that is
// actually visible to the user may be selected. The modal computes `visible` from its own maxRows;
// the Renderer then keeps only the last `rows` lines of the whole frame, so an open picker below the
// modal can clip allow options off the physical screen while they stay selectable by digit.
import type { JsonRpcMessage, JsonRpcNotification } from '@agnes/sdk'
import { createClient } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { FakeEndpoint } from '../fake-endpoint.js'
import { screenOf } from './harness.js'

const SID = 'agnes:local:default:cli:dm:m11'
const COLS = 80
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const USAGE = {
  totals: { input: 1_600, output: 58, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  cost: { usdMicros: 1_000, source: 'estimated', subscription: false },
  context: { tokens: 2_000, window: 1_000_000, autoCompact: true },
  model: { route: 'deepseek', id: 'deepseek-v4-pro', thinking: 'high' },
}

function endpointFor(opts: { usage: boolean }) {
  const responses: JsonRpcMessage[] = []
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
      // After the first real inference the projection carries usage: the status bar grows to 2 rows.
      ...(opts.usage ? { usage: USAGE } : {}),
    }))
    .on('_agnes/v1/session.list', () => ({
      items: Array.from({ length: 20 }, (_, i) => ({
        sessionId: `agnes:local:default:cli:session:old-${String(i).padStart(2, '0')}`,
        createdAt: `2026-09-${String(10 + (i % 5)).padStart(2, '0')}T12:${String(i).padStart(2, '0')}:00Z`,
        lastSeq: i,
        generation: 1,
        preset: 'standard',
      })),
    }))
  // Observation only: the client's JSON-RPC answer to the server-initiated permission request.
  const handle = endpoint.handle.bind(endpoint)
  endpoint.handle = async (msg) => {
    if (!('method' in msg) && (msg as { id?: unknown }).id === 'perm-1') {
      responses.push(msg)
      return
    }
    return handle(msg)
  }
  return { endpoint, responses }
}

const REQUEST = {
  sessionId: SID,
  toolCall: { toolCallId: 'tool-1', status: 'pending', title: 'write' },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  ],
}

async function scenario(opts: {
  usage: boolean
  picker: boolean
  rows?: number
  draft?: string
  rawInput?: unknown
  key?: string
}) {
  const ROWS = opts.rows ?? 24
  const { endpoint, responses } = endpointFor(opts)
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    const session = await client.session.new({ cwd: '/tmp' })
    const term = new FakeTerminal({ columns: COLS, rows: ROWS })
    app = new TuiApp({ session, term, profile: 'local-dev', preset: 'standard' })
    await app.start()
    const screen = async () => (await screenOf(term, COLS, ROWS)).join('\n')
    if (opts.usage) await vi.waitFor(async () => expect(await screen()).toContain('deepseek-v4-pro'))
    if (opts.picker) {
      term.feed('/resume')
      term.feed('\r')
      await vi.waitFor(async () => expect(await screen()).toContain('Select Session'))
    }
    if (opts.draft) term.feed(opts.draft)
    endpoint.push({
      jsonrpc: '2.0',
      id: 'perm-1',
      method: 'session/request_permission',
      params: {
        ...REQUEST,
        toolCall: { ...REQUEST.toolCall, ...(opts.rawInput ? { rawInput: opts.rawInput } : {}) },
      },
    } as JsonRpcNotification) // a server-initiated request; push delivers any message
    const modal = (app as unknown as { modal: { questions: unknown[] } }).modal
    await vi.waitFor(() => expect(modal.questions).toHaveLength(1))
    await sleep(50)
    const before = await screen()
    term.feed(opts.key ?? '1')
    await sleep(150)
    return {
      allowOnceOnScreen: before.includes('1. Allow once'),
      pickerOnScreen: before.includes('Select Session'),
      responses: structuredClone(responses),
      screen: before,
      after: await screen(),
    }
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
  }
}

const selected = (responses: JsonRpcMessage[]) =>
  responses.map((r) => (r as { result?: { outcome?: { optionId?: string } } }).result?.outcome?.optionId)

it('[control] no picker: Allow once is on screen and digit 1 selects it', async () => {
  const seen = await scenario({ usage: true, picker: false })
  expect(seen.allowOnceOnScreen, seen.screen).toBe(true)
  expect(selected(seen.responses)).toEqual(['allow-once'])
})

it('[boundary] picker open, no usage row: Allow once is on screen and digit 1 selects it', async () => {
  const seen = await scenario({ usage: false, picker: true })
  expect(seen.allowOnceOnScreen, seen.screen).toBe(true)
  expect(selected(seen.responses)).toEqual(['allow-once'])
})

it('[M-11] picker open with usage row: digit 1 approves only an Allow once that is on screen', async () => {
  const seen = await scenario({ usage: true, picker: true })
  // Before the fix the frame clipped "1. Allow once" off the top while digit 1 still selected it.
  expect(selected(seen.responses), `${JSON.stringify(seen.responses)}\n${seen.screen}`).toEqual(
    seen.allowOnceOnScreen ? ['allow-once'] : [],
  )
})

it('[M-11] the open picker yields its rows while the approval is pending and returns once answered', async () => {
  const seen = await scenario({ usage: true, picker: true })
  expect(seen.pickerOnScreen, seen.screen).toBe(false)
  expect(seen.allowOnceOnScreen, seen.screen).toBe(true)
  expect(seen.after, seen.after).toContain('Select Session')
})

it('[M-11] slash menu open on a 14-row terminal: digit 2 approves only an Allow always that is on screen', async () => {
  // Second row source: the editor's completion menu is not counted in the modal's fixed budget, so
  // on a short terminal the frame clipped the modal's visible choices off the top.
  const seen = await scenario({
    usage: true,
    picker: false,
    rows: 14,
    draft: '/',
    rawInput: { path: 'receipt.txt', content: 'line\n'.repeat(40) },
    key: '2',
  })
  expect(selected(seen.responses), `${JSON.stringify(seen.responses)}\n${seen.screen}`).toEqual(
    seen.screen.includes('2. Allow always') ? ['allow-always'] : [],
  )
})
