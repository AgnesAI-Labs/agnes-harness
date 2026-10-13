import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { appendRowAsOlderBuild } from '@agnes/host/testkit'
import { describe, expect, it } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import {
  legacyLedgerRpcError,
  newerLedgerRpcError,
  throwSessionOpenRpcError,
} from '../src/local/methods/acp.js'
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

describe('opening a session a newer build wrote', () => {
  it('answers a ledger in a newer format with a typed refusal and leaves it as it was', async () => {
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
      const db = new DatabaseSync(join(h.dataDir, 'sessions.db'))
      db.prepare('UPDATE sessions SET format_version = 3 WHERE session_key = ?').run(sessionId)
      const rows = () => db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_key = ?').get(sessionId)
      const before = rows()

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
        data: { code: 'NEWER_LEDGER_FORMAT', reason: 'newer-ledger-format' },
      })
      expect(rows()).toEqual(before)
      db.close()
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

/** Core's error shape (code plus detail) without the package, which this one does not depend on. */
const coreError = (code: string, message: string, detail?: Record<string, unknown>) =>
  Object.assign(new Error(`${code}: ${message}`), { code, ...(detail ? { detail } : {}) })

describe('which E_FORMAT is a newer session ledger', () => {
  const outcome = (error: unknown): { data?: { code?: string } } => {
    try {
      throwSessionOpenRpcError(error)
    } catch (thrown) {
      return thrown as { data?: { code?: string } }
    }
    throw new Error('nothing was thrown')
  }

  it('answers a newer session ledger, in process or forwarded by a worker, as NEWER_LEDGER_FORMAT', () => {
    // As core's ledgerFormatError builds it; the session-open case above goes through the real one.
    const ledger = coreError('E_FORMAT', 'session k was written by a newer AGH', {
      sessionKey: 'k',
      formatVersion: 3,
      supported: 2,
      reason: 'newer-ledger-format',
    })
    expect(outcome(ledger).data).toMatchObject({ code: 'NEWER_LEDGER_FORMAT' })
    // A worker forwards code, message and reason only.
    expect(
      outcome({ code: 'E_FORMAT', message: 'E_FORMAT: newer', reason: 'newer-ledger-format' }).data,
    ).toMatchObject({ code: 'NEWER_LEDGER_FORMAT' })
  })

  it('does not report a newer child-control format as a newer session ledger', () => {
    const child = coreError('E_FORMAT', 'child control format 9 is newer than runtime 4')
    expect(outcome(child).data?.code).not.toBe('NEWER_LEDGER_FORMAT')
    expect(outcome({ code: 'E_FORMAT', message: 'E_FORMAT: child control' }).data?.code).not.toBe(
      'NEWER_LEDGER_FORMAT',
    )
  })

  it('audits a newer-ledger refusal with a diagnostic id and still answers it', async () => {
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
      throw newerLedgerRpcError()
    })
    await ep.handle(initialize)
    const reply = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/load',
      params: { sessionId: 's', cwd: '/w', mcpServers: [] },
    })) as { error?: { data: Record<string, unknown> } }
    expect(reply.error?.data).toMatchObject({ code: 'NEWER_LEDGER_FORMAT', reason: 'newer-ledger-format' })
    expect(typeof reply.error?.data.diagnosticId).toBe('string')
    expect(audited).toEqual([
      {
        kind: 'daemon.request_failed',
        detail: {
          diagnosticId: reply.error?.data.diagnosticId,
          method: 'session/load',
          errorCode: 'NEWER_LEDGER_FORMAT',
        },
      },
    ])
    await ep.close()
  })
})
