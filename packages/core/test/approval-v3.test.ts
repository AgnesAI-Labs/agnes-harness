import type { ToolDef } from '@agnes/extension-api'
import type { ApprovalGrant } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

const profileHash = `sha256-${'a'.repeat(64)}`

function scopedTool(
  scopes: string[],
  execute: () => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
): ToolDef {
  return {
    name: 'scoped_write',
    description: 'scoped write',
    parameters: Type.Object({ value: Type.String() }),
    meta: {
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'never',
      costHint: undefined,
      deferLoading: undefined,
      requiresApproval: 'destructive',
    },
    policyVersion: 'scoped-v1',
    classify: (() => ({
      isReadOnly: false,
      isDestructive: true,
      replay: 'never' as const,
      requiresApproval: 'destructive' as const,
      approvalScopes: scopes,
    })) as NonNullable<ToolDef['classify']>,
    execute,
  }
}

function registryWith(tool: ToolDef): ToolRegistry {
  const registry = new ToolRegistry()
  registry.add(tool, {
    source: 'test',
    trust: 'builtin',
    packageIdentity: '@agnes/test-approval-v3',
    packageVersion: '1.0.0',
  })
  return registry
}

async function atTools(o: {
  scopes: string[]
  calls?: number
  seams?: ReturnType<typeof fakeSeams>
  approvalMode?: 'manual' | 'smart' | 'off'
  profile?: string | null
  execute?: () => Promise<{ content: Array<{ type: 'text'; text: string }> }>
}) {
  const calls = o.calls ?? 1
  const provider = fakeProvider(
    Array.from({ length: calls }, (_, i) => toolTurn('scoped_write', { value: String(i) })),
  )
  const opened = await openSession({
    provider,
    registry: registryWith(
      scopedTool(o.scopes, o.execute ?? (async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))),
    ),
    ...(o.seams ? { seams: o.seams } : {}),
    ...(o.approvalMode ? { approvalMode: o.approvalMode } : {}),
    resolvedProfileHash: o.profile === undefined ? profileHash : o.profile,
  })
  await opened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
  await opened.session.acceptInput()
  await opened.session.runInference()
  return opened
}

describe('v3 approval modes and grants', () => {
  it('requires a separate allowed-once decision for every scope', async () => {
    const seen: string[] = []
    const opened = await atTools({
      scopes: ['cua:click:foreground', 'cua:bring_to_front:foreground'],
      seams: fakeSeams({
        approval: {
          ask: async (request) => {
            seen.push(request.scope)
            return 'allowed-once'
          },
        },
      }),
    })
    await opened.session.runToolsPhase()
    expect(seen).toEqual(['cua:click:foreground', 'cua:bring_to_front:foreground'])
  })

  it('binds allowed-session to each ordered scope, not argv', async () => {
    const seen: string[] = []
    const opened = await atTools({
      scopes: ['cua:click:foreground', 'cua:bring_to_front:foreground'],
      calls: 2,
      seams: fakeSeams({
        approval: {
          ask: async (request) => {
            seen.push(request.scope ?? '')
            return 'allowed-session'
          },
        },
      }),
    })
    await opened.session.runToolsPhase()
    await opened.session.runInference()
    await opened.session.runToolsPhase()
    expect(seen).toEqual(['cua:click:foreground', 'cua:bring_to_front:foreground'])
  })

  it('stores allowed-permanent before use and rechecks exact durable bindings', async () => {
    const grants: ApprovalGrant[] = []
    let asks = 0
    let opened: Awaited<ReturnType<typeof atTools>> | undefined
    const seams = fakeSeams({
      approval: {
        ask: async () => {
          asks++
          return 'allowed-permanent'
        },
        listGrants: async (query) =>
          grants.filter(
            (grant) =>
              grant.profileHash === query.profileHash &&
              grant.actorId === query.actorId &&
              grant.actorOrg === query.actorOrg &&
              grant.toolId === query.toolId &&
              grant.scope === query.scope &&
              grant.policyVersion === query.policyVersion,
          ),
        putGrant: async (grant) => {
          const decisions = await opened?.log.scan({ type: 'approval/decided', limit: 10 })
          expect(
            decisions?.some((row) => (row.data as { grantId?: unknown }).grantId === grant.grantId),
          ).toBe(true)
          grants.push(grant)
        },
      },
    })
    opened = await atTools({
      scopes: ['cua:click:background', 'cua:bring_to_front:background'],
      calls: 2,
      seams,
    })
    await opened.session.runToolsPhase()
    expect(grants).toHaveLength(2)
    await opened.session.runInference()
    await opened.session.runToolsPhase()
    expect(asks).toBe(2)
    expect(grants).toEqual([
      expect.objectContaining({
        profileHash,
        actorId: actor.id,
        actorOrg: actor.org,
        toolId: 'scoped_write',
        scope: 'cua:click:background',
        policyVersion: 'scoped-v1',
      }),
      expect.objectContaining({ scope: 'cua:bring_to_front:background' }),
    ])
  })

  it('does not execute allowed-permanent when the durable store fails', async () => {
    let executions = 0
    const opened = await atTools({
      scopes: ['cua:click:background'],
      execute: async () => {
        executions++
        return { content: [{ type: 'text', text: 'must not execute' }] }
      },
      seams: fakeSeams({
        approval: {
          ask: async () => 'allowed-permanent',
          putGrant: async () => {
            throw new Error('store unavailable')
          },
        },
      }),
    })
    await opened.session.runToolsPhase()
    expect(executions).toBe(0)
    expect((await opened.log.scan({ type: 'approval/decided', limit: 10 })).at(-1)?.data).toMatchObject({
      verdict: 'allowed-permanent',
    })
    expect(
      (await opened.log.scan({ type: 'x/core/approval-grant-activation-failed', limit: 10 })).at(-1)?.data,
    ).toMatchObject({ reason: 'durable grant store unavailable' })
    expect((await opened.log.scan({ type: 'tool/result', limit: 10 })).at(-1)?.data).toMatchObject({
      code: 'APPROVAL_GRANT_UNAVAILABLE',
    })
  })

  it('smart mode records a guardian effect and session-scoped decisions without asking a human', async () => {
    let guards = 0
    let asks = 0
    const seams = fakeSeams({
      approval: {
        guard: async () => {
          guards++
          return { decision: 'allow-session', ruleVersion: 'guardian-v1', reasons: ['low risk'] }
        },
        ask: async () => {
          asks++
          return 'rejected'
        },
      },
    })
    const opened = await atTools({
      scopes: ['cua:click:background'],
      approvalMode: 'smart',
      seams,
    })
    await opened.session.runToolsPhase()
    await opened.log.close()
    const reopened = await openSession({
      provider: fakeProvider([toolTurn('scoped_write', { value: 'different argv' })]),
      registry: registryWith(
        scopedTool(['cua:click:background'], async () => ({
          content: [{ type: 'text' as const, text: 'ok' }],
        })),
      ),
      seams,
      storage: opened.storage,
      key: 'k',
      writerRunId: 'smart-reopen',
      approvalMode: 'smart',
      resolvedProfileHash: profileHash,
    })
    await reopened.session.runInference()
    await reopened.session.runToolsPhase()
    expect({ guards, asks }).toEqual({ guards: 1, asks: 0 })
    expect(await reopened.log.scan({ type: 'approval/guardian-decided', limit: 10 })).toHaveLength(1)
    expect(
      (await reopened.log.scan({ type: 'effect/intent', limit: 20 })).filter(
        (row) => (row.data as { kind?: unknown }).kind === 'approval-guardian',
      ),
    ).toHaveLength(1)
    expect(
      (await reopened.log.scan({ type: 'approval/guardian-decided', limit: 10 }))[0]?.data,
    ).toMatchObject({
      effectId: expect.any(String),
      toolUseId: expect.any(String),
      scope: 'cua:click:background',
      bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      policyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      budget: { tokensReserved: 1024, credits: 1, approved: true },
    })
    expect(
      (await reopened.log.scan({ type: 'cost/ledger', limit: 10 })).find(
        (row) => (row.data as { purpose?: unknown }).purpose === 'approval-guardian',
      )?.data,
    ).toMatchObject({
      purpose: 'approval-guardian',
      tokens: { input: 1024 },
      credits: 1,
    })
  })

  it('fails smart approval closed when its bounded cost cannot be projected or recorded', async () => {
    for (const mode of ['projection', 'record'] as const) {
      let guards = 0
      let asks = 0
      let executions = 0
      const opened = await atTools({
        scopes: ['cua:click:background'],
        approvalMode: 'smart',
        execute: async () => {
          executions++
          return { content: [{ type: 'text', text: 'ok' }] }
        },
        seams: fakeSeams({
          approval: {
            guard: async () => {
              guards++
              return { decision: 'allow-once', ruleVersion: 'guardian-v1', reasons: ['low risk'] }
            },
            ask: async () => {
              asks++
              return 'allowed-once'
            },
          },
          ledger: {
            projected: async () =>
              mode === 'projection'
                ? { credits: Number.POSITIVE_INFINITY, creditSource: 'estimated' }
                : { credits: 1, creditSource: 'estimated' },
            record: async () => {
              if (mode === 'record') throw new Error('ledger unavailable')
            },
          },
        }),
      })
      await opened.session.runToolsPhase()
      expect({ guards, asks, executions }).toEqual({
        guards: mode === 'projection' ? 0 : 1,
        asks: 1,
        executions: 1,
      })
      const guardian = (await opened.log.scan({ type: 'approval/guardian-decided', limit: 10 }))[0]
      expect(guardian?.data).toMatchObject({
        decision: 'escalate',
        ruleVersion: mode === 'projection' ? 'budget-v1' : 'failed',
        budget: { approved: mode !== 'projection' },
      })
      expect(
        (await opened.log.scan({ type: 'cost/ledger', limit: 10 })).filter(
          (row) => (row.data as { purpose?: unknown }).purpose === 'approval-guardian',
        ),
      ).toHaveLength(mode === 'projection' ? 0 : 1)
    }
  })

  it('recovers a permanent approval at both ledger-first crash boundaries without re-asking', async () => {
    const originalGrants: ApprovalGrant[] = []
    const original = await atTools({
      scopes: ['cua:click:background'],
      profile: profileHash,
      seams: fakeSeams({
        approval: {
          ask: async () => 'allowed-permanent',
          listGrants: async () => originalGrants,
          putGrant: async (grant) => {
            originalGrants.push(grant)
          },
        },
      }),
    })
    await original.session.runToolsPhase()
    const events = await original.log.scan({ fromSeq: 1, toSeq: original.log.lastSeq })
    expect(events.filter((row) => row.type === 'approval/asked')).toHaveLength(1)
    expect(events.find((row) => row.type === 'approval/decided')?.data).toMatchObject({
      verdict: 'allowed-permanent',
      via: 'sync',
      grantId: expect.stringMatching(/^grant-[a-f0-9]{64}$/),
    })
    const activation = events.find((row) => row.type === 'x/core/approval-grant-activated')
    if (!activation) throw new Error('missing activation boundary')
    const crashed = events.filter((row) => row.seq < activation.seq)

    for (const alreadyStored of [false, true]) {
      const grants = alreadyStored ? [...originalGrants] : []
      let puts = 0
      let asks = 0
      let executions = 0
      const reopened = await openSession({
        provider: fakeProvider([]),
        registry: registryWith(
          scopedTool(['cua:click:background'], async () => {
            executions++
            return { content: [{ type: 'text', text: 'ok' }] }
          }),
        ),
        storage: MemoryStorage.fromEvents('k', crashed, { opCells: original.opCellsBefore(activation.seq) }),
        key: 'k',
        writerRunId: `permanent-reopen-${alreadyStored}`,
        approvalMode: 'manual',
        resolvedProfileHash: profileHash,
        seams: fakeSeams({
          approval: {
            ask: async () => {
              asks++
              return 'rejected'
            },
            listGrants: async () => grants,
            putGrant: async (grant) => {
              puts++
              grants.push(grant)
            },
          },
        }),
      })
      await reopened.session.resume()
      await reopened.session.runToolsPhase()
      expect({ asks, puts, executions }).toEqual({
        asks: 0,
        puts: alreadyStored ? 0 : 1,
        executions: 1,
      })
      expect(
        (await reopened.log.scan({ type: 'x/core/approval-grant-activated', limit: 10 })).at(-1)?.data,
      ).toMatchObject({ recovered: alreadyStored })
    }
  })

  it.each([
    { name: 'allow', guard: 'allow-once' as const, boundary: 'effect/intent', execute: true },
    { name: 'reject', guard: 'reject' as const, boundary: 'tool/result', execute: false },
  ])('reconsumes a settled guardian $name decision after a crash without rerunning it', async (scenario) => {
    const original = await atTools({
      scopes: ['cua:click:background'],
      approvalMode: 'smart',
      seams: fakeSeams({
        approval: {
          guard: async () => ({ decision: scenario.guard, ruleVersion: 'guardian-v1', reasons: [] }),
        },
      }),
    })
    await original.session.runToolsPhase()
    const events = await original.log.scan({ fromSeq: 1, toSeq: original.log.lastSeq })
    expect(events.filter((row) => row.type === 'approval/asked')).toHaveLength(1)
    expect(events.find((row) => row.type === 'approval/decided')?.data).toMatchObject({
      verdict: scenario.guard === 'reject' ? 'rejected' : 'allowed-once',
      via: 'guardian',
    })
    const boundary = events.find(
      (row) =>
        row.type === scenario.boundary &&
        (scenario.boundary !== 'effect/intent' || (row.data as { kind?: unknown }).kind === 'tool'),
    )
    if (!boundary) throw new Error(`missing ${scenario.boundary} crash boundary`)
    const crashed = events.filter((row) => row.seq < boundary.seq)
    let guards = 0
    let asks = 0
    let executions = 0
    const reopened = await openSession({
      provider: fakeProvider([]),
      registry: registryWith(
        scopedTool(['cua:click:background'], async () => {
          executions++
          return { content: [{ type: 'text', text: 'ok' }] }
        }),
      ),
      storage: MemoryStorage.fromEvents('k', crashed, { opCells: original.opCellsBefore(boundary.seq) }),
      key: 'k',
      writerRunId: `guardian-${scenario.name}-reopen`,
      approvalMode: 'smart',
      resolvedProfileHash: profileHash,
      seams: fakeSeams({
        approval: {
          guard: async () => {
            guards++
            return { decision: 'allow-once', ruleVersion: 'must-not-run', reasons: [] }
          },
          ask: async () => {
            asks++
            return 'allowed-once'
          },
        },
      }),
    })
    await reopened.session.resume()
    await reopened.session.runToolsPhase()
    expect({ guards, asks, executions }).toEqual({
      guards: 0,
      asks: 0,
      executions: scenario.execute ? 1 : 0,
    })
    if (!scenario.execute)
      expect(
        (await reopened.log.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.data,
      ).toMatchObject({
        code: 'APPROVAL_REJECTED',
      })
  })

  it.each(['escalate', 'failed'] as const)(
    'recovers a settled guardian %s through the human path without rerunning it',
    async (mode) => {
      const original = await atTools({
        scopes: ['cua:click:background'],
        approvalMode: 'smart',
        seams: fakeSeams({
          approval: {
            guard: async () => {
              if (mode === 'failed') throw new Error('guardian unavailable')
              return { decision: 'escalate', ruleVersion: 'guardian-v1', reasons: [] }
            },
            ask: async () => 'allowed-once',
          },
        }),
      })
      await original.session.runToolsPhase()
      const events = await original.log.scan({ fromSeq: 1, toSeq: original.log.lastSeq })
      const asked = events.find((row) => row.type === 'approval/asked')
      if (!asked) throw new Error('missing human approval boundary')
      const crashed = events.filter((row) => row.seq < asked.seq)
      let guards = 0
      let asks = 0
      let executions = 0
      const reopened = await openSession({
        provider: fakeProvider([]),
        registry: registryWith(
          scopedTool(['cua:click:background'], async () => {
            executions++
            return { content: [{ type: 'text', text: 'ok' }] }
          }),
        ),
        storage: MemoryStorage.fromEvents('k', crashed, { opCells: original.opCellsBefore(asked.seq) }),
        key: 'k',
        writerRunId: `guardian-${mode}-reopen`,
        approvalMode: 'smart',
        resolvedProfileHash: profileHash,
        seams: fakeSeams({
          approval: {
            guard: async () => {
              guards++
              return { decision: 'allow-once', ruleVersion: 'must-not-run', reasons: [] }
            },
            ask: async () => {
              asks++
              return 'allowed-once'
            },
          },
        }),
      })
      await reopened.session.resume()
      await reopened.session.runToolsPhase()
      expect({ guards, asks, executions }).toEqual({ guards: 0, asks: 1, executions: 1 })
    },
  )

  it('off mode bypasses asks but never overrides an authorization deny', async () => {
    let asks = 0
    const opened = await atTools({
      scopes: ['cua:click:background'],
      approvalMode: 'off',
      seams: fakeSeams({
        approval: {
          ask: async () => {
            asks++
            return 'allowed-once'
          },
        },
        principals: {
          authorize: async () => ({ decisionId: 'deny-1', effect: 'deny', reason: 'policy denied' }),
        },
      }),
    })
    await opened.session.runToolsPhase()
    expect(asks).toBe(0)
    expect((await opened.log.scan({ type: 'tool/result', limit: 10 })).at(-1)?.data).toMatchObject({
      code: 'AUTHZ_DENIED',
    })
  })
})
