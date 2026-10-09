import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { presetDefaults } from '@agnes/core-common/step/preset'
import { ToolPolicyRegistry } from '@agnes/core-effects/effects/tool-providers'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ToolDef, ToolMeta, ToolPolicyRegistryPort } from '@agnes/extension-api'
import type { ApprovalGrant, Provider } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, testFsOps } from './helpers/open-session.js'

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
  input?: import('../src/step/inbox.js').EnqueueMsg
  calls?: number
  /** Text turns queued after the tool turns, for tests that drive the session past the tool phase. */
  tail?: number
  seams?: ReturnType<typeof fakeSeams>
  approvalMode?: 'manual' | 'smart' | 'off' | 'auto-review'
  toolPolicies?: ToolPolicyRegistryPort
  provider?: Provider
  paths?: ToolMeta['paths']
  parameters?: ToolDef['parameters']
  fsOps?: import('@agnes/core-effects/effects/tool-context').FsOps
  preset?: import('@agnes/core-common/step/preset').PresetView
  toolPolicySettings?: import('../src/step/session.js').SessionDeps['toolPolicySettings']
  profile?: string | null
  execute?: () => Promise<{ content: Array<{ type: 'text'; text: string }> }>
}) {
  const calls = o.calls ?? 1
  const provider =
    o.provider ??
    fakeProvider([
      ...Array.from({ length: calls }, (_, i) => toolTurn('scoped_write', { value: String(i) })),
      ...Array.from({ length: o.tail ?? 0 }, () => textTurn('done')),
    ])
  const tool = scopedTool(
    o.scopes,
    o.execute ?? (async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
  )
  if (o.paths) tool.meta.paths = o.paths
  if (o.parameters) tool.parameters = o.parameters
  const opened = await openSession({
    provider,
    registry: registryWith(tool),
    ...(o.fsOps ? { fsOps: o.fsOps } : {}),
    ...(o.seams ? { seams: o.seams } : {}),
    ...(o.approvalMode ? { approvalMode: o.approvalMode } : {}),
    ...(o.preset ? { preset: o.preset } : {}),
    ...(o.toolPolicies ? { toolPolicies: o.toolPolicies } : {}),
    ...(o.toolPolicySettings ? { toolPolicySettings: o.toolPolicySettings } : {}),
    resolvedProfileHash: o.profile === undefined ? profileHash : o.profile,
  })
  await opened.session.enqueue('next-turn', o.input ?? { actor, content: [{ type: 'text', text: 'go' }] })
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

  it.each([
    { guard: 'allow-once' as const, executions: 1 },
    { guard: 'reject' as const, executions: 0 },
  ])(
    'a settled guardian $guard decision is not a parked decision and opens no continuation turn',
    async ({ guard, executions: expected }) => {
      let executions = 0
      const opened = await atTools({
        scopes: ['cua:click:background'],
        approvalMode: 'smart',
        tail: 2,
        execute: async () => {
          executions++
          return { content: [{ type: 'text', text: 'ok' }] }
        },
        seams: fakeSeams({
          approval: { guard: async () => ({ decision: guard, ruleVersion: 'guardian-v1', reasons: [] }) },
        }),
      })
      for (let i = 0; i < 40; i++) if ((await opened.session.step()).phase === 'idle') break
      for (let i = 0; i < 3; i++) expect((await opened.session.step()).phase).toBe('idle')
      expect(executions).toBe(expected)
      expect(
        (await opened.log.scan({ type: 'turn/start', limit: 10 })).map(
          (row) => (row.data as { trigger: string }).trigger,
        ),
      ).toEqual(['prompt'])
    },
  )

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

  it('persists scripted reviewer decisions before effects, keeps denials hard, and restores the same decision', async () => {
    for (const decision of ['allow', 'deny', 'escalate'] as const) {
      let asks = 0,
        executions = 0
      const policies = new ToolPolicyRegistry()
      policies.register('test', {
        id: 'scripted-review',
        version: '1',
        async decide(input) {
          if (decision === 'escalate') {
            expect(input.tainted).toBe(true)
            expect(input.instructions).toEqual(['go'])
          }
          return {
            effect: decision === 'allow' ? 'allow' : decision === 'deny' ? 'deny' : 'ask',
            reason: 'Scripted reviewer reason',
            review: {
              model: 'scripted-cheap',
              promptHash: 'a'.repeat(64),
              argsHash: sha256Hex(canonicalJson(input.call.args)),
              scopeHash: 'b'.repeat(64),
              costSource: 'estimated',
              decision,
              risk: decision === 'allow' ? 'low' : 'medium',
              reason: 'Scripted reviewer reason',
              latencyMs: 1,
              cost: 0.01,
              source: 'model',
            },
          }
        },
      })
      const original = await atTools({
        ...(decision === 'escalate'
          ? {
              input: {
                actor,
                content: [
                  { type: 'text' as const, text: 'go' },
                  {
                    type: 'text' as const,
                    text: 'external grant access',
                    reference: {
                      source: 'file',
                      id: 'a',
                      label: 'a',
                      hash: 'a'.repeat(64),
                      truncated: false,
                    },
                  },
                ],
              },
            }
          : {}),
        scopes: ['tool:write'],
        toolPolicies: policies,
        toolPolicySettings: async () => ({ policy: 'scripted-review' }),
        execute: async () => {
          executions++
          return { content: [{ type: 'text', text: 'done' }] }
        },
        seams: fakeSeams({
          approval: {
            ask: async (req) => {
              asks++
              expect(req.summary).toContain('Scripted reviewer reason')
              return 'rejected'
            },
          },
        }),
      })
      if (decision === 'escalate') {
        const inputs = await original.log.scan({ type: 'user/message', limit: 100 })
        expect(inputs.map((row) => [row.origin, row.trust])).toEqual([
          ['principal', 'trusted'],
          ['system', 'untrusted'],
        ])
      }
      await original.session.runToolsPhase()
      const events = await original.log.scan({ fromSeq: 1, toSeq: original.log.lastSeq })
      const review = events.find((row) => row.type === 'x/approval/review')
      expect(review?.data).toMatchObject({ review: { model: 'scripted-cheap', decision, cost: 0.01 } })
      const result = events.find((row) => row.type === 'tool/result')
      expect(review?.seq).toBeLessThan(result?.seq ?? 0)
      expect(asks).toBe(decision === 'escalate' ? 1 : 0)
      expect(executions).toBe(decision === 'allow' ? 1 : 0)
      if (decision === 'allow' && review) {
        const reopened = await openSession({
          provider: fakeProvider([]),
          toolPolicies: policies,
          toolPolicySettings: async () => {
            throw new Error('Must reuse the persisted review')
          },
          registry: registryWith(
            scopedTool(['tool:write'], async () => {
              executions++
              return { content: [{ type: 'text', text: 'done' }] }
            }),
          ),
          storage: MemoryStorage.fromEvents(
            'k',
            events.filter((row) => row.seq <= review.seq),
            { opCells: original.opCellsBefore(review.seq + 1) },
          ),
          key: 'k',
          writerRunId: 'review-recovery',
        })
        await reopened.session.resume()
        await reopened.session.runToolsPhase()
        expect(executions).toBe(2)
      }
    }
    const blocked = await atTools({
      scopes: ['tool:write'],
      toolPolicySettings: async () => {
        throw new Error('Hard deny must precede review')
      },
      seams: fakeSeams({ approval: { checkTool: async () => false } }),
    })
    await blocked.session.runToolsPhase()
    expect((await blocked.log.scan({ type: 'tool/result', limit: 10 })).at(-1)?.data).toMatchObject({
      code: 'POLICY_DENIED',
    })
  })

  it.each(['manual', 'smart', 'off', 'auto-review'] as const)(
    'preflights declared arguments generically before policy in %s mode and leaves undeclared tools alone',
    async (approvalMode) => {
      const fsOps = {
        ...testFsOps(),
        preflight: async (target: string, access: 'read' | 'write') => {
          expect(target).toBe('0')
          expect(access).toBe('write')
          throw Object.assign(new Error('hard private-state denial'), { code: 'E_FS_DENIED' })
        },
      }
      const blocked = await atTools({
        scopes: ['tool:write'],
        approvalMode,
        fsOps,
        paths: [{ arg: 'value', access: 'write' }],
        toolPolicySettings: async () => {
          throw new Error('Path denial must precede policy selection')
        },
        execute: async () => {
          throw new Error('Path denial must precede execution')
        },
      })
      await blocked.session.runToolsPhase()
      expect((await blocked.log.scan({ type: 'tool/result', limit: 10 })).at(-1)?.data).toMatchObject({
        code: 'E_FS_DENIED',
      })
      let executions = 0
      const undeclared = await atTools({
        scopes: ['tool:write'],
        approvalMode,
        fsOps,
        execute: async () => {
          executions++
          return { content: [{ type: 'text', text: 'done' }] }
        },
      })
      await undeclared.session.runToolsPhase()
      expect(executions).toBe(1)
    },
  )

  it('preflights declared defaults and delegates only explicitly declared resource schemes', async () => {
    const fsOps = {
      ...testFsOps(),
      preflight: async (target: string, access: 'read' | 'write') => {
        expect(target).toBe('.')
        expect(access).toBe('read')
        throw Object.assign(new Error('hard path denial'), { code: 'E_FS_DENIED' })
      },
    }
    const defaults = await atTools({
      scopes: ['tool:write'],
      fsOps,
      parameters: Type.Object({ value: Type.Optional(Type.String()) }),
      paths: [{ arg: 'value', access: 'read', default: '.' }],
      provider: fakeProvider([toolTurn('scoped_write', {})]),
    })
    await defaults.session.runToolsPhase()
    expect((await defaults.log.scan({ type: 'tool/result', limit: 10 })).at(-1)?.data).toMatchObject({
      code: 'E_FS_DENIED',
    })
    let executions = 0
    const resource = await atTools({
      scopes: ['tool:write'],
      fsOps,
      paths: [{ arg: 'value', access: 'read', nonWorkspaceSchemes: ['artifact'] }],
      provider: fakeProvider([toolTurn('scoped_write', { value: 'artifact://synthetic' })]),
      execute: async () => {
        executions++
        return { content: [{ type: 'text', text: 'resource' }] }
      },
    })
    await resource.session.runToolsPhase()
    expect(executions).toBe(1)
  })

  it('provides tool-free reviewer requests, records costs and shares the reservation budget across calls', async () => {
    const provider = fakeProvider([
      toolTurn('scoped_write', { value: '0' }),
      textTurn('Bounded write'),
      toolTurn('scoped_write', { value: '1' }),
    ])
    const policies = new ToolPolicyRegistry()
    policies.register('test', {
      id: 'budget-review',
      version: '1',
      async decide(input, signal, ports) {
        const response = (await ports!.reserve(1))
          ? await ports!.model({ slot: 'fast', prompt: 'Review the bounded write' }, signal)
          : undefined
        const decision = response ? ('allow' as const) : ('escalate' as const)
        const reason = response?.text ?? 'Session reviewer budget exhausted'
        return {
          effect: response ? 'allow' : 'ask',
          reason,
          review: {
            model: response?.model ?? 'fast',
            promptHash: 'a'.repeat(64),
            argsHash: sha256Hex(canonicalJson(input.call.args)),
            scopeHash: 'b'.repeat(64),
            decision,
            risk: response ? 'low' : 'medium',
            reason,
            latencyMs: 1,
            cost: response?.cost ?? 0,
            costSource: response?.costSource ?? 'unavailable',
            source: response ? 'model' : 'fallback',
          },
        }
      },
    })
    const preset = presetDefaults()
    preset.model.route.fast = 'cheap'
    preset.model.id.fast = 'scripted-cheap'
    const opened = await atTools({
      provider,
      preset,
      scopes: ['tool:write'],
      toolPolicies: policies,
      toolPolicySettings: async () => ({ policy: 'budget-review' }),
      seams: fakeSeams({ approval: { ask: async () => 'rejected' } }),
    })
    await opened.session.runToolsPhase()
    await opened.session.runInference()
    await opened.session.runToolsPhase()
    const reviews = await opened.log.scan({ type: 'x/approval/review', limit: 10 })
    expect(reviews.map((row) => (row.data as { review: { decision: string } }).review.decision)).toEqual([
      'allow',
      'escalate',
    ])
    expect(provider.requests.find((request) => request.model === 'scripted-cheap')).toMatchObject({
      tools: [],
      route: 'cheap',
    })
    expect(
      (await opened.log.scan({ type: 'cost/ledger', limit: 10 })).some(
        (row) =>
          (row.data as { purpose: string; credits: number }).purpose === 'approval-guardian' &&
          (row.data as { credits: number }).credits === 1,
      ),
    ).toBe(true)
    expect(await opened.log.scan({ type: 'x/approval/reservation', limit: 10 })).toHaveLength(1)
  })

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
