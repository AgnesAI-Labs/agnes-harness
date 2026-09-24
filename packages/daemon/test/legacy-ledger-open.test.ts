import { appendRowAsOlderBuild } from '@agnes/host/testkit'
import { describe, expect, it } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { legacyLedgerRpcError } from '../src/local/methods/acp.js'
import { openTestHost } from './host.js'

const initialize = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
}

/** A row type an older build wrote and this one no longer knows, appended with a valid chain. */
type Row = Parameters<Parameters<typeof appendRowAsOlderBuild>[2]>[0]
const legacyRows: Record<string, (last: Row) => Omit<Row, 'seq'>> = {
  'assistant/chunk': (last) => ({
    ...last,
    type: 'assistant/chunk',
    lane: 'main',
    data: { kind: 'text', delta: 'hi', effectId: 'e1' },
  }),
  'op.state': (last) => ({ ...last, type: 'op.state', register: 'op.state', lane: 'main', data: null }),
}

describe('opening a session an older build wrote', () => {
  it.each(Object.keys(legacyRows))('answers a ledger holding %s with a typed refusal', async (type) => {
    const h = await openTestHost()
    const first = h.endpoint({ pollMs: 5 })
    try {
      await first.handle(initialize)
      await h.addWorkspace(h.dataDir)
      const created = (await first.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: h.dataDir, mcpServers: [] },
      })) as { result: { sessionId: string } }
      const sessionId = created.result.sessionId
      await first.close()
      await appendRowAsOlderBuild(
        h.dataDir,
        sessionId,
        legacyRows[type] as Parameters<typeof appendRowAsOlderBuild>[2],
      )

      const again = h.endpoint({ pollMs: 5 })
      await again.handle(initialize)
      const loaded = (await again.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/load',
        params: { sessionId, cwd: h.dataDir, mcpServers: [] },
      })) as { error?: { message: string; data: Record<string, unknown> } }
      expect(loaded.error).toMatchObject({
        message: 'SEMANTIC_REJECTED',
        data: { code: 'LEGACY_LEDGER_FORMAT', reason: 'legacy-ledger-format' },
      })
      await again.close()
    } finally {
      await h.close()
    }
  })
})

describe('the endpoint records a legacy-ledger refusal it answers', () => {
  it('audits it with a diagnostic id and still answers the typed refusal', async () => {
    const audited: unknown[] = []
    const ep = new LocalEndpoint({
      clock: () => 0,
      principalId: 'p',
      audit: (record) => audited.push(record),
    })
    ep.register('initialize', async (_params, c) => {
      c.conn.initialized = true
      return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
    })
    ep.register('session/load', async () => {
      throw legacyLedgerRpcError()
    })
    await ep.handle(initialize)
    const reply = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/load',
      params: { sessionId: 's', cwd: '/w', mcpServers: [] },
    })) as { error?: { data: Record<string, unknown> } }
    expect(reply.error?.data).toMatchObject({ code: 'LEGACY_LEDGER_FORMAT', reason: 'legacy-ledger-format' })
    expect(audited).toEqual([
      {
        kind: 'daemon.request_failed',
        detail: {
          diagnosticId: reply.error?.data.diagnosticId,
          method: 'session/load',
          errorCode: 'LEGACY_LEDGER_FORMAT',
        },
      },
    ])
    await ep.close()
  })
})
