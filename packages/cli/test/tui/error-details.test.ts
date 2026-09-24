import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stampFor } from '@agnes/ai/testkit'
import { createLocalEndpoint } from '@agnes/daemon/local'
import { createTestHost } from '@agnes/host/testkit'
import { type RequestBody, rpcError } from '@agnes/protocol'
import { createClient } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { formatTuiErrorNotice, TuiApp } from '../../src/tui/app.js'
import { FakeTerminal } from '../../src/tui/terminal.js'
import { FakeEndpoint } from '../fake-endpoint.js'
import { screenOf } from './harness.js'

it('maps only an exact approved business rejection to a local action', () => {
  expect(
    formatTuiErrorNotice({
      code: -32011,
      data: { code: 'SEMANTIC_REJECTED', reason: 'choose a turn/end seq' },
    }),
  ).toBe('Request failed (SEMANTIC_REJECTED).')
  expect(
    formatTuiErrorNotice({
      code: -32011,
      data: { code: 'SEMANTIC_REJECTED', reason: 'fork boundary must be a completed turn/end' },
    }),
  ).toBe('Request failed (SEMANTIC_REJECTED): Choose a completed turn/end sequence.')
  expect(formatTuiErrorNotice(new Error('secret upstream message'))).toBe('Request failed. Try again.')
  expect(formatTuiErrorNotice({ data: { code: {}, reason: ['not text'] } })).toBe(
    'Request failed. Try again.',
  )
})

it('never reflects arbitrary reason text', () => {
  const reasons = [
    'upstream rejected https://example.test/?access_code=fixture-private-value',
    'private-value-without-a-keyword',
    'line one\nline two\x1b[31m',
    'a'.repeat(16_384),
  ]
  for (const reason of reasons) {
    const notice = formatTuiErrorNotice({ data: { code: 'SEMANTIC_REJECTED', reason } })
    expect(notice).toBe('Request failed (SEMANTIC_REJECTED).')
    expect(notice).not.toContain(reason)
  }
})

it('contains malformed getters and proxies without losing a readable stable code', () => {
  const data = {
    code: 'SEMANTIC_REJECTED',
    get reason(): never {
      throw new Error('getter private value')
    },
  }
  expect(formatTuiErrorNotice({ data })).toBe('Request failed (SEMANTIC_REJECTED).')
  expect(
    formatTuiErrorNotice(
      new Proxy(
        {},
        {
          get() {
            throw new Error('proxy private value')
          },
        },
      ),
    ),
  ).toBe('Request failed. Try again.')
})

it('renders a daemon rejection reason through the TUI error path', async () => {
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: 'agnes:local:default:cli:dm:error-reason' }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => {
      throw rpcError('SEMANTIC_REJECTED', {
        reason: 'fork boundary must be a completed turn/end',
        detail: 'secret backend detail',
      })
    })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 100, rows: 24 })
  const app = new TuiApp({ session, term, header: 'Agnes' })
  try {
    await app.start()
    await vi.waitFor(async () =>
      expect((await screenOf(term, 100, 24)).join('\n')).toContain(
        'Request failed (SEMANTIC_REJECTED): Choose a completed turn/end sequence.',
      ),
    )
    expect((await screenOf(term, 100, 24)).join('\n')).not.toContain('secret backend detail')
    expect((await screenOf(term, 100, 24)).join('\n')).not.toContain(
      'fork boundary must be a completed turn/end',
    )
  } finally {
    await app.stop()
    await client.close()
  }
})

it('does not render a late error after the TUI has stopped', async () => {
  const endpoint = new FakeEndpoint()
    .on('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      _meta: { agnes: { agnesVersion: '0.0.0-fake' } },
    }))
    .on('session/new', () => ({ sessionId: 'agnes:local:default:cli:dm:stopped-error' }))
    .on('_agnes/v1/session.attach', () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: 'h' }))
    .on('_agnes/v1/session.detach', () => ({}))
    .on('_agnes/v1/session.projectUI', () => ({
      sessionId: 'agnes:local:default:cli:dm:stopped-error',
      generation: 1,
      upto: 0,
      opState: null,
      turns: [],
      nodes: [],
    }))
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  const session = await client.session.new({ cwd: '/tmp' })
  const term = new FakeTerminal({ columns: 80, rows: 24 })
  const app = new TuiApp({ session, term, header: 'Agnes' })
  try {
    await app.start()
    await app.stop()
    const writes = term.writes.length
    ;(app as unknown as { showError(error: unknown): void }).showError(
      rpcError('SEMANTIC_REJECTED', { reason: 'must not render after stop' }),
    )
    expect(term.writes).toHaveLength(writes)
  } finally {
    await app.stop()
    await client.close()
  }
})

// Mac hand acceptance C2 (2026-09-23): a turn that ran and ended in `error` reaches the TUI as the
// daemon's TURN_ERROR envelope, and its cause is the turn's own stable code in `data.error.code`.
// The TUI showed only the envelope, so a model the account may not use read as "TURN_ERROR".
const AUTH_NOTICE =
  'Request failed (AUTH): The provider refused this model or its credentials; pick another with /model or sign in again.'
const turnError = (error: unknown) => ({
  code: -32603,
  data: { code: 'TURN_ERROR', turnEnd: { reason: 'error' }, error },
})

it('names the turn error code under a TURN_ERROR envelope, never its message', () => {
  expect(formatTuiErrorNotice(turnError({ code: 'AUTH', message: 'status=403' }))).toBe(AUTH_NOTICE)
  expect(
    formatTuiErrorNotice(turnError({ code: 'RATE_LIMIT', message: 'upstream https://x.test/?k=private' })),
  ).toBe('Request failed (RATE_LIMIT).')
  expect(formatTuiErrorNotice(turnError({ code: 'constructor', message: 'x' }))).toBe(
    'Request failed (constructor).',
  )
  // No usable inner code keeps the envelope, as before.
  expect(formatTuiErrorNotice(turnError(undefined))).toBe('Request failed (TURN_ERROR).')
  expect(formatTuiErrorNotice(turnError({ code: {}, message: 'x' }))).toBe('Request failed (TURN_ERROR).')
  expect(
    formatTuiErrorNotice(
      turnError({
        get code(): never {
          throw new Error('getter private value')
        },
      }),
    ),
  ).toBe('Request failed (TURN_ERROR).')
  // Only the TURN_ERROR envelope is unwrapped; another code's `data.error` is not read.
  expect(formatTuiErrorNotice({ data: { code: 'SESSION_BUSY', error: { code: 'AUTH' } } })).toBe(
    'Request failed (SESSION_BUSY).',
  )
})

it('shows the AUTH cause when a real turn ends in a provider 403', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-turn-auth-'))
  const { host } = await createTestHost({
    dataDir: dir,
    provider: {
      models: () => [],
      async *infer(req: RequestBody) {
        yield { type: 'sent' as const, stamp: stampFor(req) }
        yield {
          type: 'error' as const,
          reason: 'error' as const,
          code: 'AUTH' as const,
          message: 'status=403',
          retryable: false,
        }
      },
    },
  })
  const endpoint = createLocalEndpoint(host, { pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint } })
  let app: TuiApp | undefined
  try {
    await client.workspace.add(dir)
    const session = await client.session.new({ cwd: dir })
    const term = new FakeTerminal({ columns: 160, rows: 24 })
    app = new TuiApp({ session, term, header: 'Agnes' })
    await app.start()
    term.feed('hi')
    term.feed('\r')
    await vi.waitFor(
      async () => expect((await screenOf(term, 160, 24)).join('\n')).toContain('Request failed (AUTH)'),
      { timeout: 5_000 },
    )
    const screen = (await screenOf(term, 160, 24)).join('\n')
    expect(screen).not.toContain('TURN_ERROR')
    expect(screen).not.toContain('status=403')
  } finally {
    await app?.stop()
    await client.close()
    await endpoint.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)
