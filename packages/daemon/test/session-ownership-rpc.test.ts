import { realpathSync } from 'node:fs'
import { sessionKey as canonicalSessionKey } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import type { JobsPort, SessionLister, SessionMetaRow } from '../src/local/ports.js'
import { MemoryTickets } from '../src/storage/lister.js'
import { openTestHost } from './host.js'

const initialize = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  },
}

const meta = (sessionId: string): SessionMetaRow => ({
  sessionId,
  createdAt: '2026-09-18T00:00:00.000Z',
  lastSeq: 1,
  generation: 1,
  preset: 'standard',
})

describe('authenticated session ownership RPC guard', () => {
  it('keeps the Host canonical session key when the client does not supply one', async () => {
    const h = await openTestHost()
    const endpoint = h.endpoint()
    try {
      await endpoint.handle(initialize)
      const actor = await h.host.resolveActor({ kind: 'local' }, 'session')
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: { cwd: h.dataDir, mcpServers: [] },
        }),
      ).resolves.toMatchObject({
        result: { sessionId: canonicalSessionKey(h.host.profile, actor, realpathSync(h.dataDir)) },
      })
    } finally {
      await endpoint.close()
      await h.close()
    }
  })

  it('allows same-principal reconnect and denies another principal across session entry points', async () => {
    const h = await openTestHost()
    const owner = h.endpoint({ pollMs: 5 })
    const reconnect = h.endpoint({ pollMs: 5 })
    const stranger = h.endpoint({
      pollMs: 5,
      identity: { principalId: 'other-principal', authKind: 'jwt', credentialKind: 'jwt' },
    })
    try {
      for (const endpoint of [owner, reconnect, stranger])
        await expect(endpoint.handle(initialize)).resolves.toMatchObject({ result: { protocolVersion: 1 } })
      const created = (await owner.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: h.dataDir, mcpServers: [] },
      })) as { result: { sessionId: string } }
      const sessionId = created.result.sessionId
      await owner.close()
      await expect(
        reconnect.handle({
          jsonrpc: '2.0',
          id: 3,
          method: 'session/load',
          params: { sessionId, cwd: h.dataDir, mcpServers: [] },
        }),
      ).resolves.toMatchObject({ result: {} })
      for (const request of [
        { method: 'session/load', params: { sessionId, cwd: h.dataDir, mcpServers: [] } },
        { method: 'session/prompt', params: { sessionId, prompt: [] } },
        { method: '_agnes/v1/session.setYolo', params: { sessionId, enabled: true } },
        { method: '_agnes/v1/session.attach', params: { sessionId } },
        { method: '_agnes/v1/session.fork', params: { sessionId, at: 1 } },
      ])
        await expect(stranger.handle({ jsonrpc: '2.0', id: 4, ...request })).resolves.toMatchObject({
          error: { data: { code: 'CAPABILITY_DENIED', reason: 'session owner unavailable' } },
        })
    } finally {
      await Promise.all([owner.close(), reconnect.close(), stranger.close()])
      await h.close()
    }
  })

  it('does not let session/load claim a legacy session with no owner binding', async () => {
    const h = await openTestHost()
    const legacyKey = 'agnes:local:default:daemon:dm:legacy-unowned'
    const legacy = await h.host.createSession({ key: legacyKey, cwd: h.dataDir })
    await legacy.close()
    const endpoint = h.endpoint({ pollMs: 5 })
    try {
      await endpoint.handle(initialize)
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/load',
          params: { sessionId: legacyKey, cwd: h.dataDir, mcpServers: [] },
        }),
      ).resolves.toMatchObject({
        error: { data: { code: 'CAPABILITY_DENIED', reason: 'session owner unavailable' } },
      })
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 3,
          method: 'session/new',
          params: {
            cwd: h.dataDir,
            mcpServers: [],
            _meta: { 'ai.agnes.harness': { sessionKey: legacyKey } },
          },
        }),
      ).resolves.toMatchObject({
        error: { data: { code: 'CAPABILITY_DENIED', reason: 'session owner unavailable' } },
      })
    } finally {
      await endpoint.close()
      await h.close()
    }
  })

  it('does not reserve an explicit session key before workspace validation succeeds', async () => {
    const h = await openTestHost()
    const first = h.endpoint({ pollMs: 5 })
    const second = h.endpoint({
      pollMs: 5,
      identity: { principalId: 'other-principal', authKind: 'jwt', credentialKind: 'jwt' },
    })
    const sessionKey = 'agnes:local:default:daemon:dm:not-squatted'
    try {
      await first.handle(initialize)
      await second.handle(initialize)
      await expect(
        first.handle({
          jsonrpc: '2.0',
          id: 2,
          method: 'session/new',
          params: {
            cwd: '',
            mcpServers: [],
            _meta: { 'ai.agnes.harness': { sessionKey } },
          },
        }),
      ).resolves.toHaveProperty('error')
      await expect(
        second.handle({
          jsonrpc: '2.0',
          id: 3,
          method: 'session/new',
          params: {
            cwd: h.dataDir,
            mcpServers: [],
            _meta: { 'ai.agnes.harness': { sessionKey } },
          },
        }),
      ).resolves.toMatchObject({ result: { sessionId: sessionKey } })
    } finally {
      await Promise.all([first.close(), second.close()])
      await h.close()
    }
  })

  it('keeps a failed open reservation retryable only by the same authenticated owner', async () => {
    const h = await openTestHost()
    const owner = h.endpoint({ pollMs: 5 })
    const stranger = h.endpoint({
      pollMs: 5,
      identity: { principalId: 'other-principal', authKind: 'jwt', credentialKind: 'jwt' },
    })
    const sessionKey = 'agnes:local:default:daemon:dm:retry-owned-reservation'
    const createSession = vi.spyOn(h.host, 'createSession')
    createSession.mockRejectedValueOnce(new Error('injected open failure'))
    const request = {
      jsonrpc: '2.0' as const,
      id: 2,
      method: 'session/new',
      params: {
        cwd: h.dataDir,
        mcpServers: [],
        _meta: { 'ai.agnes.harness': { sessionKey } },
      },
    }
    try {
      await owner.handle(initialize)
      await stranger.handle(initialize)
      await expect(owner.handle(request)).resolves.toHaveProperty('error')
      await expect(stranger.handle({ ...request, id: 3 })).resolves.toMatchObject({
        error: { data: { code: 'CAPABILITY_DENIED', reason: 'session owner unavailable' } },
      })
      await expect(owner.handle({ ...request, id: 4 })).resolves.toMatchObject({
        result: { sessionId: sessionKey },
      })
    } finally {
      createSession.mockRestore()
      await Promise.all([owner.close(), stranger.close()])
      await h.close()
    }
  })

  it('authorizes jobs from stored job ownership and hides foreign jobs', async () => {
    const h = await openTestHost()
    const jobSessions = new Map<string, string>()
    const poll = vi.fn(async () => ({ status: 'waiting', secret: 'must-not-leak' }))
    const cancel = vi.fn(async () => undefined)
    const jobs: JobsPort = {
      enqueue: async (raw) => {
        const spec = raw as { idempotencyKey: string; sessionKey: string }
        jobSessions.set(spec.idempotencyKey, spec.sessionKey)
        return { jobId: spec.idempotencyKey }
      },
      sessionKey: async (jobId) => jobSessions.get(jobId),
      poll,
      cancel,
    }
    const owner = h.endpoint({ jobs })
    const stranger = h.endpoint({
      jobs,
      identity: { principalId: 'other-principal', authKind: 'jwt', credentialKind: 'jwt' },
    })
    try {
      await owner.handle(initialize)
      await stranger.handle(initialize)
      const created = (await owner.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: h.dataDir, mcpServers: [] },
      })) as { result: { sessionId: string } }
      const spec = {
        idempotencyKey: 'owned-job',
        sessionKey: created.result.sessionId,
        payload: { prompt: 'later' },
        schedule: { kind: 'once' },
      }
      await expect(
        owner.handle({ jsonrpc: '2.0', id: 3, method: '_agnes/v1/jobs.enqueue', params: spec }),
      ).resolves.toMatchObject({ result: { jobId: 'owned-job' } })
      for (const method of ['_agnes/v1/jobs.poll', '_agnes/v1/jobs.cancel'])
        await expect(
          stranger.handle({ jsonrpc: '2.0', id: 4, method, params: { jobId: 'owned-job' } }),
        ).resolves.toMatchObject({ error: { data: { code: 'SESSION_NOT_FOUND', jobId: 'owned-job' } } })
      await expect(
        stranger.handle({ jsonrpc: '2.0', id: 5, method: '_agnes/v1/jobs.enqueue', params: spec }),
      ).resolves.toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
      await expect(
        stranger.handle({
          jsonrpc: '2.0',
          id: 6,
          method: '_agnes/v1/submit',
          params: { clientId: 'x', commandId: 'x', kind: 'jobs.enqueue', payload: spec },
        }),
      ).resolves.toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
      expect(poll).not.toHaveBeenCalled()
      expect(cancel).not.toHaveBeenCalled()
    } finally {
      await Promise.all([owner.close(), stranger.close()])
      await h.close()
    }
  })

  it('does not let an unknown submit id pass authorization into the journal', async () => {
    const h = await openTestHost()
    const begin = vi.fn(async () => ({ state: 'new' as const }))
    const endpoint = h.endpoint({
      journal: {
        begin,
        complete: async () => undefined,
        abandon: async () => undefined,
        ack: async () => false,
        gc: async () => 0,
      },
    })
    try {
      await endpoint.handle(initialize)
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 2,
          method: '_agnes/v1/submit',
          params: {
            clientId: 'x',
            commandId: 'x',
            kind: 'steer',
            payload: { sessionId: 'unknown-session', content: [] },
          },
        }),
      ).resolves.toMatchObject({ error: { data: { code: 'SESSION_NOT_FOUND' } } })
      expect(begin).not.toHaveBeenCalled()
    } finally {
      await endpoint.close()
      await h.close()
    }
  })

  it('maps a foreign indexed approval ticket to the same unknown-ticket rejection', async () => {
    const h = await openTestHost()
    const tickets = new MemoryTickets()
    const owner = h.endpoint({ tickets })
    const stranger = h.endpoint({
      tickets,
      identity: { principalId: 'other-principal', authKind: 'jwt', credentialKind: 'jwt' },
    })
    try {
      await owner.handle(initialize)
      await stranger.handle(initialize)
      const created = (await owner.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: h.dataDir, mcpServers: [] },
      })) as { result: { sessionId: string } }
      tickets.put('foreign-ticket', created.result.sessionId, Date.now() + 60_000, h.dataDir)
      const response = await stranger.handle({
        jsonrpc: '2.0',
        id: 3,
        method: '_agnes/v1/approval.decide',
        params: { ticket: 'foreign-ticket', verdict: 'rejected', approverCredential: { kind: 'local' } },
      })
      expect(response).toMatchObject({
        error: { data: { code: 'APPROVAL_REJECTED', reason: 'unknown ticket' } },
      })
      expect(JSON.stringify(response)).not.toContain(created.result.sessionId)
    } finally {
      await Promise.all([owner.close(), stranger.close()])
      await h.close()
    }
  })

  it('fills owner-scoped list pages without exposing or counting foreign rows', async () => {
    const h = await openTestHost()
    let ownerOne = ''
    let ownerTwo = ''
    let foreign = ''
    const lister: SessionLister = {
      list: async ({ cursor, limit = 50, sessionIds = [] }) => {
        expect(sessionIds).toEqual([ownerOne, ownerTwo])
        expect(sessionIds).not.toContain(foreign)
        const offset = cursor ? Number(cursor) : 0
        const rows = sessionIds.map(meta)
        const items = rows.slice(offset, offset + limit)
        return {
          items,
          ...(offset + limit < rows.length ? { cursor: String(offset + limit) } : {}),
        }
      },
    }
    const owner = h.endpoint({ lister })
    const stranger = h.endpoint({
      identity: { principalId: 'other-principal', authKind: 'jwt', credentialKind: 'jwt' },
    })
    const create = async (endpoint: typeof owner, sessionKey: string): Promise<string> => {
      const response = (await endpoint.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: {
          cwd: h.dataDir,
          mcpServers: [],
          _meta: { 'ai.agnes.harness': { sessionKey } },
        },
      })) as { result: { sessionId: string } }
      return response.result.sessionId
    }
    try {
      await owner.handle(initialize)
      await stranger.handle(initialize)
      ownerOne = await create(owner, 'agnes:test:owner-one')
      ownerTwo = await create(owner, 'agnes:test:owner-two')
      foreign = await create(stranger as typeof owner, 'agnes:test:foreign')
      const first = await owner.handle({
        jsonrpc: '2.0',
        id: 3,
        method: '_agnes/v1/session.list',
        params: { limit: 1 },
      })
      expect(first).toMatchObject({ result: { items: [{ sessionId: ownerOne }], next: '1' } })
      expect(JSON.stringify(first)).not.toContain(foreign)
      await expect(
        owner.handle({
          jsonrpc: '2.0',
          id: 4,
          method: '_agnes/v1/session.list',
          params: { limit: 1, cursor: '1' },
        }),
      ).resolves.toMatchObject({ result: { items: [{ sessionId: ownerTwo }] } })
    } finally {
      await Promise.all([owner.close(), stranger.close()])
      await h.close()
    }
  })

  it('keeps a failed fork reservation retryable only as the same fork, never session/new', async () => {
    const h = await openTestHost()
    const endpoint = h.endpoint()
    const childKey = 'agnes:test:failed-fork-child'
    try {
      await endpoint.handle(initialize)
      const created = (await endpoint.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: h.dataDir, mcpServers: [] },
      })) as { result: { sessionId: string } }
      const fork = {
        jsonrpc: '2.0' as const,
        id: 3,
        method: '_agnes/v1/session.fork',
        params: { sessionId: created.result.sessionId, at: 1, childKey },
      }
      await expect(endpoint.handle(fork)).resolves.toMatchObject({
        error: { data: { code: 'SEMANTIC_REJECTED' } },
      })
      await expect(endpoint.handle({ ...fork, id: 4 })).resolves.toMatchObject({
        error: { data: { code: 'SEMANTIC_REJECTED' } },
      })
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 5,
          method: 'session/new',
          params: {
            cwd: h.dataDir,
            mcpServers: [],
            _meta: { 'ai.agnes.harness': { sessionKey: childKey } },
          },
        }),
      ).resolves.toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
    } finally {
      await endpoint.close()
      await h.close()
    }
  })
})
