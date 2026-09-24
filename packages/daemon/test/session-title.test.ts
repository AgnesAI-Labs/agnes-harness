import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { createTestHost } from '@agnes/host/testkit'
import { type EventEnvelope, SESSION_TITLE_EVENT } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'
import { MemorySessionWorkspaces, SessionWorkspaceIndex, StorageLister } from '../src/storage/lister.js'
import { handleCommand } from '../src/worker/commands.js'
import { testWorkspaceCatalog } from './host.js'
import { sqliteTables } from './sqlite-tables.js'

const title = (seq: number, value: string): EventEnvelope => ({
  v: 1,
  seq,
  ts: new Date().toISOString(),
  id: `event-${seq}`,
  lane: 'main',
  actor: { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  type: SESSION_TITLE_EVENT,
  origin: 'system',
  trust: 'trusted',
  ignorable: true,
  data: {
    status: 'generated',
    title: value,
    prompt: '问题',
    turn: 1,
    startSeq: 3,
    route: 'gw',
    model: 'm1',
    budgetCap: null,
    treeBudgetCap: null,
  },
})

it('migrates an old database, preserves titles after restart and rejects stale/forged updates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-title-index-'))
  const path = join(root, 'index.sqlite')
  const tables = sqliteTables(path)
  try {
    const table = tables.table('session_workspaces')
    table.exec('CREATE TABLE session_workspaces (session_key TEXT PRIMARY KEY, cwd TEXT NOT NULL)')
    table.exec('INSERT INTO session_workspaces VALUES (?, ?)', ['existing', root])
    const sql = new SessionWorkspaceIndex(table)
    const memory = new MemorySessionWorkspaces()
    memory.put('existing', root)
    for (const store of [sql, memory]) {
      store.observe('existing', title(10, '新标题'))
      store.observe('existing', title(9, '过期标题'))
      store.observe('existing', { ...title(11, '伪造标题'), origin: 'ext:host', trust: 'untrusted' })
      expect(store.metadata('existing')?.title).toBe('新标题')
    }
    expect(new SessionWorkspaceIndex(table).metadata('existing')?.title).toBe('新标题')
    await tables.close()
    const reopened = sqliteTables(path)
    try {
      expect(
        new SessionWorkspaceIndex(reopened.table('session_workspaces')).metadata('existing')?.title,
      ).toBe('新标题')
    } finally {
      await reopened.close()
    }
  } finally {
    await tables.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('uses the same generator through the real local endpoint and worker command dispatcher', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-title-entry-'))
  const { host } = await createTestHost({
    dataDir: root,
    provider: (profile) =>
      new ScriptedProvider({
        models: (profile.provider.routes ?? []).flatMap((route) => route.models ?? []),
        scripts: [
          (req) => [
            { type: 'text_delta', delta: req.kind === 'summary' ? '入口标题验证' : '完成回答' },
            { type: 'done', reason: 'stop' },
          ],
        ],
      }),
  })
  const endpoint = createLocalEndpoint(host, { workspaces: await testWorkspaceCatalog(root) })
  const notifications: unknown[] = []
  const reading = (async () => {
    for await (const notification of endpoint.notifications) notifications.push(notification)
  })()
  const request = (id: number, method: string, params: unknown) => ({
    jsonrpc: '2.0' as const,
    id,
    method,
    params,
  })
  try {
    await endpoint.handle(request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} }))
    const created = (await endpoint.handle(request(2, 'session/new', { cwd: root, mcpServers: [] }))) as {
      result: { sessionId: string }
    }
    const id = created.result.sessionId
    await expect(
      endpoint.handle(request(20, '_agnes/v1/session.attach', { sessionId: id, filter: { preview: true } })),
    ).resolves.toHaveProperty('result')
    await expect(
      endpoint.handle(
        request(3, 'session/prompt', { sessionId: id, prompt: [{ type: 'text', text: '验证会话标题' }] }),
      ),
    ).resolves.toMatchObject({ result: { stopReason: 'end_turn' } })
    await vi.waitFor(async () => {
      expect(await endpoint.handle(request(4, '_agnes/v1/session.list', {}))).toMatchObject({
        result: { items: [expect.objectContaining({ sessionId: id, title: '入口标题验证' })] },
      })
    })
    // Read the actual Host database: a hand-written TEXT lane fixture hides BLOB mismatches.
    const tables = sqliteTables(join(root, 'sessions.db'))
    try {
      const events = tables.table('events')
      expect(events.get<{ kind: string }>('SELECT typeof(lane) AS kind FROM events LIMIT 1')?.kind).toBe(
        'blob',
      )
      const lister = new StorageLister(events, tables.table('writer_claims'))
      expect((await lister.list({})).items).toContainEqual(
        expect.objectContaining({ sessionId: id, title: '入口标题验证' }),
      )
    } finally {
      await tables.close()
    }
    await vi.waitFor(() => {
      expect(notifications).toContainEqual(
        expect.objectContaining({
          method: '_agnes/v1/session.event',
          params: expect.objectContaining({
            sessionId: id,
            event: expect.objectContaining({
              type: SESSION_TITLE_EVENT,
              data: expect.objectContaining({ status: 'generated', title: '入口标题验证' }),
            }),
          }),
        }),
      )
    })
    await endpoint.handle(request(21, '_agnes/v1/session.detach', { sessionId: id }))
    await expect(
      endpoint.handle(request(22, '_agnes/v1/session.attach', { sessionId: id, filter: { preview: true } })),
    ).resolves.toHaveProperty('result')
    const session = await host.createSession({ key: 'worker-title', cwd: root })
    const context = { host, aborts: new Map<string, AbortController>() }
    await handleCommand(
      session,
      {
        kind: 'command',
        requestId: 'enqueue',
        method: 'enqueue',
        params: {
          target: 'next-turn',
          msg: { actor: session.d.actor, content: [{ type: 'text', text: 'worker 标题' }] },
        },
      },
      context,
    )
    await expect(
      handleCommand(
        session,
        { kind: 'command', requestId: 'run', method: 'run', params: { runId: 'run' } },
        context,
      ),
    ).resolves.toMatchObject({ reason: 'completed' })
    await vi.waitFor(async () => {
      const rows = await session.scan({ type: SESSION_TITLE_EVENT, order: 'desc', limit: 1 })
      expect(rows[0]?.data).toMatchObject({ status: 'generated', title: '入口标题验证' })
    })
  } finally {
    await endpoint.close()
    await reading
    await host.close()
    rmSync(root, { recursive: true, force: true })
  }
})
