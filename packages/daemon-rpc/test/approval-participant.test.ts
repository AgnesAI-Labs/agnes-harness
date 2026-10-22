import { describe, expect, it, vi } from 'vitest'
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

const credential = {
  kind: 'channel' as const,
  channel: 'dingtalk',
  accountId: 'account-1',
  userId: 'user-1',
  chatId: 'chat-1',
  chatType: 'group' as const,
  raw: { accessToken: 'must-not-reach-ledger' },
}

describe('participant RPC', () => {
  it('resolves credentials, folds join/leave, and deduplicates concurrent retries', async () => {
    const opened = await openTestHost()
    const resolveActor = vi.fn(async () => ({
      id: 'resolved-user-1',
      org: 'example',
      role: 'member',
      deptPath: ['engineering'],
      attrs: {},
    }))
    const endpoint = opened.endpoint({ resolveActor })
    await endpoint.handle(initialize)
    const created = (await endpoint.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: opened.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const request = {
      jsonrpc: '2.0' as const,
      method: '_agnes/v1/participant.join',
      params: { sessionId: created.result.sessionId, credential },
    }

    const [joined, retried] = (await Promise.all([
      endpoint.handle({ ...request, id: 3 }),
      endpoint.handle({ ...request, id: 4 }),
    ])) as [{ result: { seq: number } }, { result: { seq: number } }]
    expect(retried.result.seq).toBe(joined.result.seq)
    expect(resolveActor).toHaveBeenCalledWith(credential, 'session', created.result.sessionId)

    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 5,
        method: '_agnes/v1/participant.list',
        params: { sessionId: created.result.sessionId },
      }),
    ).resolves.toMatchObject({
      result: {
        participants: [
          {
            actor: { id: 'resolved-user-1', org: 'example', role: 'member' },
            joinedAt: expect.any(String),
            surface: 'dingtalk',
          },
        ],
      },
    })

    const left = (await endpoint.handle({
      jsonrpc: '2.0',
      id: 6,
      method: '_agnes/v1/participant.leave',
      params: { sessionId: created.result.sessionId, credential },
    })) as { result: { seq: number } }
    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 7,
        method: '_agnes/v1/participant.leave',
        params: { sessionId: created.result.sessionId, credential },
      }),
    ).resolves.toMatchObject({ result: { seq: left.result.seq } })
    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 8,
        method: '_agnes/v1/participant.list',
        params: { sessionId: created.result.sessionId },
      }),
    ).resolves.toMatchObject({ result: { participants: [] } })

    await endpoint.close()
    const reopened = await opened.host.createSession({ key: created.result.sessionId, cwd: opened.dataDir })
    const rows = await reopened.scan({ type: 'participant', limit: 10 })
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: 'principal',
          trust: 'untrusted',
          data: expect.objectContaining({
            action: 'join',
            surface: 'dingtalk',
            credentialKind: 'channel',
            participant: expect.objectContaining({ id: 'resolved-user-1' }),
          }),
        }),
      ]),
    )
    expect(JSON.stringify(rows)).not.toContain('must-not-reach-ledger')
    await reopened.close()
    await opened.close()
  })

  it("uses Host's fitted principals resolver when no endpoint override is supplied", async () => {
    const opened = await openTestHost()
    const endpoint = opened.endpoint()
    await endpoint.handle(initialize)
    const created = (await endpoint.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: opened.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }

    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 3,
        method: '_agnes/v1/participant.join',
        params: { sessionId: created.result.sessionId, credential },
      }),
    ).resolves.toMatchObject({ result: { seq: expect.any(Number) } })
    const participants = (await endpoint.handle({
      jsonrpc: '2.0',
      id: 4,
      method: '_agnes/v1/participant.list',
      params: { sessionId: created.result.sessionId },
    })) as { result: { participants: Array<{ actor: { id: string } }> } }
    expect(participants.result.participants[0]?.actor.id).toBe('u')
    const listing = (await endpoint.handle({
      jsonrpc: '2.0',
      id: 5,
      method: '_agnes/v1/apis.list',
      params: {},
    })) as { result: { families: Array<{ methods: string[] }> } }
    const methods = listing.result.families.flatMap((family) => family.methods)
    expect(methods).toContain('_agnes/v1/participant.join')
    expect(methods).toContain('_agnes/v1/approval.decide')

    await endpoint.close()
    await opened.close()
  })

  it('maps an asynchronously stale owned approval to APPROVAL_REJECTED', async () => {
    const opened = await openTestHost()
    const resolver = vi.fn(opened.host.resolveActor.bind(opened.host))
    const endpoint = opened.endpoint({ resolveActor: resolver })
    try {
      await endpoint.handle(initialize)
      const created = (await endpoint.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: opened.dataDir, mcpServers: [] },
      })) as { result: { sessionId: string } }
      const session = opened.host.kernel.get(created.result.sessionId)!
      const decide = vi
        .spyOn(session, 'decideApproval')
        .mockRejectedValue(Object.assign(new Error('approval already resolved'), { code: 'E_RELATION' }))
      try {
        await expect(
          endpoint.handle({
            jsonrpc: '2.0',
            id: 30,
            method: '_agnes/v1/approval.decide',
            params: {
              sessionId: session.key,
              id: 'stale-owned',
              revision: 1,
              commandId: 'c',
              response: { option: 'allowed-once', value: null },
            },
            _meta: { 'ai.agnes.harness': { sourceCredential: credential } },
          }),
        ).resolves.toMatchObject({ error: { data: { code: 'APPROVAL_SOURCE_UNVERIFIED' } } })
        expect(decide).not.toHaveBeenCalled()
        await expect(
          endpoint.handle({
            jsonrpc: '2.0',
            id: 31,
            method: '_agnes/v1/approval.decide',
            params: {
              sessionId: session.key,
              id: 'stale-owned',
              revision: 1,
              commandId: 'c',
              response: { option: 'allowed-once', value: null },
              sourceCredential: credential,
            },
          }),
        ).resolves.toMatchObject({ error: { code: -32602 } })
        expect(decide).not.toHaveBeenCalled()
        const rejected = await endpoint.handle({
          jsonrpc: '2.0',
          id: 3,
          method: '_agnes/v1/approval.decide',
          params: {
            sessionId: session.key,
            id: 'stale-owned',
            revision: 1,
            commandId: 'c',
            response: { option: 'allowed-once', value: null },
          },
        })
        expect(rejected).toMatchObject({
          error: { code: -32009, data: { code: 'APPROVAL_REJECTED', cause: { code: 'E_RELATION' } } },
        })
        expect(rejected).not.toHaveProperty('error.data.reason')
        expect(JSON.stringify(rejected)).not.toContain('approval already resolved')
        expect(resolver).toHaveBeenCalledWith(endpoint.conn.credential, 'approval', created.result.sessionId)
      } finally {
        resolver.mockReset()
        decide.mockRestore()
      }
    } finally {
      await endpoint.close()
      await opened.close()
    }
  })

  it('maps unknown owned decisions to APPROVAL_REJECTED without returning backend prose', async () => {
    const opened = await openTestHost()
    const endpoint = opened.endpoint()
    try {
      await endpoint.handle(initialize)
      const created = (await endpoint.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: opened.dataDir, mcpServers: [] },
      })) as { result: { sessionId: string } }
      const session = opened.host.kernel.get(created.result.sessionId)!
      const before = session.lastSeq
      for (const option of ['allowed-once', 'allowed-permanent'] as const) {
        const rejected = await endpoint.handle({
          jsonrpc: '2.0',
          id: 3,
          method: '_agnes/v1/approval.decide',
          params: {
            sessionId: session.key,
            id: 'missing',
            revision: 1,
            commandId: option,
            response: { option, value: null },
          },
        })
        expect(rejected).toMatchObject({
          error: { code: -32009, data: { code: 'APPROVAL_REJECTED', cause: { code: 'E_RELATION' } } },
        })
        expect(rejected).not.toHaveProperty('error.data.reason')
        expect(JSON.stringify(rejected)).not.toContain('DECISION_NOT_FOUND')
        expect(session.lastSeq).toBe(before)
      }
    } finally {
      await endpoint.close()
      await opened.close()
    }
  })
})

describe('permanent approval grant RPC', () => {
  it('derives actor/profile from the owned session and exposes only bound list/revoke', async () => {
    const opened = await openTestHost()
    const endpoint = opened.endpoint()
    try {
      await endpoint.handle(initialize)
      const created = (await endpoint.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: opened.dataDir, mcpServers: [] },
      })) as { result: { sessionId: string } }
      const binding = {
        sessionId: created.result.sessionId,
        toolId: 'computer_use',
        scope: 'cua:click:background',
        policyVersion: 'computer-use-v1',
      }
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 3,
          method: '_agnes/v1/approvalGrants.list',
          params: binding,
        }),
      ).resolves.toEqual({ jsonrpc: '2.0', id: 3, result: { grants: [] } })
      const session = opened.host.kernel.get(created.result.sessionId)
      const policyDigest = session?.d.policyDigest
      if (!session || !policyDigest) throw new Error('missing session profile binding')
      const grant = {
        grantId: 'grant-1',
        policyDigest,
        actorId: session.d.actor.id,
        actorOrg: session.d.actor.org,
        toolId: binding.toolId,
        scope: binding.scope,
        policyVersion: binding.policyVersion,
        sourceDecisionId: 'decision-fixture',
        issuer: { id: 'reviewer', org: 'local', role: 'user' as const, deptPath: [], attrs: {} },
        definitionFingerprint: 'd'.repeat(64),
        policyBinding: 'e'.repeat(64),
        createdAt: '2026-09-19T00:00:00Z',
      }
      await expect(session.d.runtime.approvalPutGrant(grant, new AbortController().signal)).resolves.toBe(
        true,
      )
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 4,
          method: '_agnes/v1/approvalGrants.list',
          params: binding,
        }),
      ).resolves.toMatchObject({ result: { grants: [grant] } })
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 5,
          method: '_agnes/v1/approvalGrants.list',
          params: { ...binding, actorId: 'attacker' },
        }),
      ).resolves.toMatchObject({ error: { code: -32602, data: { code: 'UNKNOWN_KEY' } } })
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 6,
          method: '_agnes/v1/approvalGrants.list',
          params: { ...binding, policyDigest },
        }),
      ).resolves.toMatchObject({ error: { code: -32602, data: { code: 'UNKNOWN_KEY' } } })
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 7,
          method: '_agnes/v1/approvalGrants.revoke',
          params: { ...binding, scope: 'cua:click:foreground', grantId: grant.grantId },
        }),
      ).resolves.toMatchObject({
        error: { code: -32009, data: { code: 'APPROVAL_REJECTED', reason: 'grant unavailable' } },
      })
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 8,
          method: '_agnes/v1/approvalGrants.list',
          params: binding,
        }),
      ).resolves.toMatchObject({ result: { grants: [grant] } })
      // The session listing needs no tool, scope or policy version: the grant shows up by itself.
      const summary = {
        grantId: grant.grantId,
        lifetime: 'always',
        toolId: grant.toolId,
        scope: grant.scope,
        policyVersion: grant.policyVersion,
        createdAt: grant.createdAt,
        issuer: grant.issuer,
      }
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 80,
          method: '_agnes/v1/approvalGrants.forSession',
          params: { sessionId: created.result.sessionId },
        }),
      ).resolves.toEqual({ jsonrpc: '2.0', id: 80, result: { grants: [summary] } })
      const revoked = (await endpoint.handle({
        jsonrpc: '2.0',
        id: 9,
        method: '_agnes/v1/approvalGrants.revoke',
        params: { ...binding, grantId: grant.grantId },
      })) as { result: typeof grant & { revokedAt: string } }
      expect(revoked.result).toMatchObject(grant)
      expect(revoked.result.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 10,
          method: '_agnes/v1/approvalGrants.list',
          params: binding,
        }),
      ).resolves.toMatchObject({ result: { grants: [] } })
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 11,
          method: '_agnes/v1/approvalGrants.revoke',
          params: { ...binding, grantId: 'missing-grant' },
        }),
      ).resolves.toMatchObject({
        error: { code: -32009, data: { code: 'APPROVAL_REJECTED', reason: 'grant unavailable' } },
      })
      // Revoking through the session needs only the listed id, and takes effect in the bound store.
      await session.d.runtime.approvalPutGrant({ ...grant, grantId: 'grant-2' }, new AbortController().signal)
      const forSession = (id: number, method: string, params: Record<string, unknown> = {}) =>
        endpoint.handle({
          jsonrpc: '2.0',
          id,
          method: `_agnes/v1/approvalGrants.${method}`,
          params: { sessionId: created.result.sessionId, ...params },
        })
      await expect(forSession(81, 'revokeForSession', { grantId: 'missing-grant' })).resolves.toMatchObject({
        error: { code: -32009, data: { reason: 'grant unavailable' } },
      })
      await expect(forSession(82, 'revokeForSession', { grantId: 'grant-2' })).resolves.toMatchObject({
        result: { ...summary, grantId: 'grant-2', revokedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
      })
      await expect(forSession(83, 'forSession')).resolves.toMatchObject({ result: { grants: [] } })
      await expect(
        endpoint.handle({ jsonrpc: '2.0', id: 84, method: '_agnes/v1/approvalGrants.list', params: binding }),
      ).resolves.toMatchObject({ result: { grants: [] } })
      const listing = (await endpoint.handle({
        jsonrpc: '2.0',
        id: 12,
        method: '_agnes/v1/apis.list',
        params: {},
      })) as { result: { families: Array<{ methods: string[] }> } }
      expect(listing.result.families.flatMap((family) => family.methods)).toEqual(
        expect.arrayContaining([
          '_agnes/v1/approvalGrants.list',
          '_agnes/v1/approvalGrants.revoke',
          '_agnes/v1/approvalGrants.forSession',
          '_agnes/v1/approvalGrants.revokeForSession',
        ]),
      )
    } finally {
      await endpoint.close()
      await opened.close()
    }
  })

  it('denies a different authenticated principal before reading grant state', async () => {
    const opened = await openTestHost()
    const owner = opened.endpoint()
    const stranger = opened.endpoint({
      identity: { principalId: 'other-user', authKind: 'local', credentialKind: 'local' },
    })
    try {
      await owner.handle(initialize)
      await stranger.handle(initialize)
      const created = (await owner.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: opened.dataDir, mcpServers: [] },
      })) as { result: { sessionId: string } }
      await expect(
        stranger.handle({
          jsonrpc: '2.0',
          id: 3,
          method: '_agnes/v1/approvalGrants.list',
          params: {
            sessionId: created.result.sessionId,
            toolId: 'computer_use',
            scope: 'cua:click:background',
            policyVersion: 'computer-use-v1',
          },
        }),
      ).resolves.toMatchObject({
        error: { code: -32006, data: { code: 'CAPABILITY_DENIED' } },
      })
      for (const [method, extra] of [
        ['forSession', {}],
        ['revokeForSession', { grantId: 'grant-1' }],
      ] as const)
        await expect(
          stranger.handle({
            jsonrpc: '2.0',
            id: 4,
            method: `_agnes/v1/approvalGrants.${method}`,
            params: { sessionId: created.result.sessionId, ...extra },
          }),
        ).resolves.toMatchObject({ error: { code: -32006, data: { code: 'CAPABILITY_DENIED' } } })
    } finally {
      await stranger.close()
      await owner.close()
      await opened.close()
    }
  })
})
