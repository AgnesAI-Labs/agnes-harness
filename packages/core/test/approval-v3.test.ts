import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { presetDefaults } from '@agnes/core-common/step/preset'
import { ToolPolicyRegistry } from '@agnes/core-effects/effects/tool-providers'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ToolContext, ToolDef, ToolMeta, ToolPolicyRegistryPort } from '@agnes/extension-api'
import type { ApprovalGrant, DecisionSnapshot, Provider } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { permanentGrantId } from '../src/step/approval-grants.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, testFsOps } from './helpers/open-session.js'

const profileHash = `sha256-${'a'.repeat(64)}`
/** The view of a preset that states this command table. */
function withCommandTable(commandTable: import('../src/command-table/normalize.js').PolicyRule[]) {
  const preset = presetDefaults()
  return { ...preset, approval: { ...preset.approval, commandTable } }
}

function scopedTool(
  scopes: string[],
  execute: (args: unknown, ctx: ToolContext) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
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
  grants?: import('@agnes/core-effects/effects/seams').ApprovalGrantsPort
  approvalMode?: 'manual' | 'off' | 'auto-review'
  toolPolicies?: ToolPolicyRegistryPort
  provider?: Provider
  paths?: ToolMeta['paths']
  parameters?: ToolDef['parameters']
  fsOps?: import('@agnes/core-effects/effects/tool-context').FsOps
  preset?: import('@agnes/core-common/step/preset').PresetView
  toolPolicySettings?: import('../src/step/session.js').SessionDeps['toolPolicySettings']
  profile?: string | null
  execute?: (args: unknown, ctx: ToolContext) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
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
    ...(o.grants ? { approvalGrants: o.grants } : {}),
    ...(o.approvalMode ? { approvalMode: o.approvalMode } : {}),
    ...(o.preset ? { preset: o.preset } : {}),
    ...(o.toolPolicies ? { toolPolicies: o.toolPolicies } : {}),
    ...(o.toolPolicySettings ? { toolPolicySettings: o.toolPolicySettings } : {}),
    resolvedProfileHash: o.profile === undefined ? profileHash : o.profile,
    policyDigest: o.profile === undefined ? profileHash : o.profile,
  })
  await opened.session.enqueue('next-turn', o.input ?? { actor, content: [{ type: 'text', text: 'go' }] })
  await opened.session.acceptInput()
  await opened.session.runInference()
  return opened
}

describe('v3 approval modes and grants', () => {
  it('labels forced review of a never-risk tool unknown and starts its deadline after hooks', async () => {
    let now = 1_757_203_200_000
    const policies = new ToolPolicyRegistry()
    policies.register('test', {
      id: 'force-review',
      version: '1',
      decide: async () => ({ effect: 'ask', reason: 'review required' }),
    })
    const tool = scopedTool(['tool:write'], async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    tool.meta = { ...tool.meta, isDestructive: false, requiresApproval: 'never' }
    tool.classify = () => ({
      isReadOnly: false,
      isDestructive: false,
      replay: 'never',
      requiresApproval: 'never',
      approvalScopes: ['tool:write'],
    })
    let seen: { risk: string; deadline: string } | undefined
    const opened = await openSession({
      provider: fakeProvider([toolTurn('scoped_write', { value: 'one' }), textTurn('done')]),
      registry: registryWith(tool),
      toolPolicies: policies,
      toolPolicySettings: async () => ({ policy: 'force-review' }),
      clock: () => now,
      seams: fakeSeams({
        approval: {
          ask: async (request) => {
            seen = request
            return { verdict: 'allowed-once', answeredBy: actor }
          },
        },
      }),
    })
    opened.session.hooks = {
      ...opened.session.hooks,
      approvalRequest: async () => {
        now += 5000
        return {}
      },
    }
    await opened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
    await opened.session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(seen?.risk).toBe('unknown')
    // Durable decisions retain pendingTtlMs; the delivery waiter timeout does not shorten validity.
    expect(Date.parse(seen?.deadline ?? '') - now).toBe(opened.session.preset.approval.pendingTtlMs)
    const request = (await opened.log.scan({ type: 'decision/state', limit: 1 }))[0]?.data as DecisionSnapshot
    expect(Date.parse(request.request.createdAt)).toBe(now)
    await opened.session.close()
  })

  it.each(['manual', 'off', 'auto-review'] as const)(
    'requires verified once answers for human-only revision review in %s mode',
    async (approvalMode) => {
      const policies = new ToolPolicyRegistry()
      const revision = 'a'.repeat(64)
      policies.register('test', {
        id: 'human-review',
        version: '1',
        decide: () => ({
          effect: 'ask',
          reason: 'Review exact revision',
          approval: { reviewerRequirement: 'human', grantConstraints: 'once', subjectRevision: revision },
        }),
      })
      for (const answer of ['allowed-session', 'allowed-permanent', 'allowed-once', 'verified'] as const) {
        let executions = 0
        const offered: unknown[] = []
        const proofs: Array<ToolContext['approval']> = []
        const opened = await atTools({
          scopes: ['tool:write'],
          calls: 2,
          approvalMode,
          toolPolicies: policies,
          toolPolicySettings: async () => ({ policy: 'human-review' }),
          execute: async (_args, ctx) => {
            proofs.push(ctx.approval)
            executions++
            return { content: [{ type: 'text', text: 'reviewed' }] }
          },
          grants: {
            list: async () => {
              throw new Error('human review cannot use durable grants')
            },
            put: async () => undefined,
          },
          seams: fakeSeams({
            approval: {
              ask: async (req) => {
                offered.push(req.options)
                expect(req.approval).toEqual({
                  reviewerRequirement: 'human',
                  grantConstraints: 'once',
                  subjectRevision: revision,
                })
                return answer === 'verified'
                  ? { verdict: 'allowed-once', answeredBy: { ...actor, id: 'reviewer' } }
                  : answer
              },
            },
          }),
        })
        await opened.session.runToolsPhase()
        if (answer === 'verified') {
          await opened.session.runInference()
          await opened.session.runToolsPhase()
        }
        expect(offered).toEqual(
          Array.from({ length: answer === 'verified' ? 2 : 1 }, () => ['allowed-once', 'rejected']),
        )
        expect(executions).toBe(answer === 'verified' ? 2 : 0)
        expect(proofs).toEqual(
          answer === 'verified'
            ? Array.from({ length: 2 }, () => ({
                requestId: expect.any(String),
                subjectRevision: revision,
                answeredBy: { ...actor, id: 'reviewer' },
              }))
            : [],
        )
        const decisions = await opened.session.decisions.list()
        expect(decisions).toHaveLength(answer === 'verified' ? 2 : 1)
        for (const snapshot of decisions) {
          if (answer === 'verified')
            expect(snapshot).toMatchObject({
              result: {
                reason: 'answered',
                response: { option: 'allowed-once' },
                answeredBy: { ...actor, id: 'reviewer' },
              },
              consumption: { effectId: expect.any(String) },
            })
          else expect(snapshot.result).toBeNull()
        }
        await opened.log.close()
      }
    },
  )

  it.each(['allowed-session', 'allowed-permanent'] as const)(
    'requires human review despite an existing %s grant',
    async (grantVerdict) => {
      let humanOnly = false
      let executions = 0
      const offers: unknown[] = []
      const grants: ApprovalGrant[] = []
      const policies = new ToolPolicyRegistry()
      policies.register('test', {
        id: 'revision-review',
        version: '1',
        decide: () => ({
          effect: 'ask',
          reason: 'review',
          ...(humanOnly
            ? {
                approval: {
                  reviewerRequirement: 'human' as const,
                  grantConstraints: 'once' as const,
                  subjectRevision: 'a'.repeat(64),
                },
              }
            : {}),
        }),
      })
      const opened = await atTools({
        scopes: ['tool:write'],
        calls: 2,
        toolPolicies: policies,
        toolPolicySettings: async () => ({ policy: 'revision-review' }),
        execute: async () => {
          executions++
          return { content: [{ type: 'text', text: 'done' }] }
        },
        grants: {
          list: async () => grants,
          put: async (grant) => {
            grants.push(grant)
          },
        },
        seams: fakeSeams({
          approval: {
            ask: async (request) => {
              offers.push(request.options)
              return humanOnly
                ? { verdict: 'rejected' as const, answeredBy: { ...actor, id: 'reviewer' } }
                : { verdict: grantVerdict, answeredBy: actor }
            },
          },
        }),
      })
      try {
        await opened.session.runToolsPhase()
        humanOnly = true
        await opened.session.runInference()
        await opened.session.runToolsPhase()
        expect(offers).toHaveLength(2)
        expect(offers[1]).toEqual(['allowed-once', 'rejected'])
        expect(executions).toBe(1)
        expect((await opened.session.decisions.list()).at(-1)?.result).toMatchObject({
          reason: 'answered',
          response: { option: 'rejected' },
          answeredBy: { ...actor, id: 'reviewer' },
        })
      } finally {
        await opened.session.close()
      }
    },
  )

  it('requires a separate allowed-once decision for every scope', async () => {
    const seen: string[] = []
    const opened = await atTools({
      scopes: ['cua:click:foreground', 'cua:bring_to_front:foreground'],
      seams: fakeSeams({
        approval: {
          ask: async (request) => {
            seen.push(request.scope)
            return { verdict: 'allowed-once' as const, answeredBy: actor }
          },
        },
      }),
    })
    await opened.session.runToolsPhase()
    expect(seen).toEqual(['cua:click:foreground', 'cua:bring_to_front:foreground'])
  })

  it('keeps partial multi-scope answers unconsumed, then commits all scopes with one original intent', async () => {
    let executions = 0
    const opened = await atTools({
      scopes: ['synthetic:first', 'synthetic:second'],
      tail: 1,
      execute: async () => {
        executions++
        return { content: [] }
      },
      seams: fakeSeams({
        approval: {
          ask: async (request) =>
            request.scope === 'synthetic:first'
              ? { verdict: 'allowed-once', answeredBy: actor }
              : { verdict: 'unavailable', reason: 'no-handler' },
        },
      }),
    })
    const commits = vi.spyOn(opened.log.storage, 'commit')
    try {
      expect(
        await opened.session.run({ until: 'turn-end', signal: new AbortController().signal }),
      ).toMatchObject({ reason: 'parked' })
      const values = await opened.session.decisions.list()
      expect(values).toHaveLength(2)
      expect(values[0]?.result).toMatchObject({ reason: 'answered' })
      expect(values[1]?.result).toBeNull()
      expect(values.every((value) => value.consumption === null)).toBe(true)
      expect(executions).toBe(0)
      const pending = values[1]!
      await opened.session.decisions.answer(
        {
          handle: pending.handle,
          revision: pending.revision,
          commandId: 'second-scope',
          response: { option: 'allowed-once', value: null },
        },
        { actor, category: 'human', authorize() {} },
      )
      expect(
        await opened.session.run({ until: 'turn-end', signal: new AbortController().signal }),
      ).toMatchObject({ reason: 'completed' })
      const transaction = commits.mock.calls
        .map((call) => call[1])
        .find((tx) =>
          tx.events.some(
            (row) => row.type === 'effect/intent' && (row.data as { kind?: string }).kind === 'tool',
          ),
        )!
      const states = transaction.events
        .filter((row) => row.type === 'decision/state')
        .map((row) => row.data as DecisionSnapshot)
      expect(states.map((value) => value.handle.id)).toEqual(values.map((value) => value.handle.id))
      expect(new Set(states.map((value) => value.consumption?.effectId)).size).toBe(1)
      expect(transaction.opState).toBeDefined()
      expect(executions).toBe(1)
    } finally {
      await opened.session.close()
    }
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
            return { verdict: 'allowed-session' as const, answeredBy: actor }
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
          return { verdict: 'allowed-permanent' as const, answeredBy: actor }
        },
      },
    })
    const port = {
      list: async (query: import('@agnes/core-effects/effects/seams').ApprovalGrantQuery) =>
        grants.filter(
          (grant) =>
            grant.policyDigest === query.policyDigest &&
            grant.actorId === query.actorId &&
            grant.actorOrg === query.actorOrg &&
            grant.toolId === query.toolId &&
            grant.scope === query.scope &&
            grant.policyVersion === query.policyVersion,
        ),
      put: async (grant: ApprovalGrant) => {
        const decisions = await opened?.session.decisions.list()
        expect(
          decisions?.some(
            (value) =>
              value.result?.reason === 'answered' &&
              value.result.response.option === 'allowed-permanent' &&
              permanentGrantId({
                sessionKey: value.handle.sessionId!,
                toolUseId: value.request.operationId,
                scope: (value.request.spec.subject as { scope: string }).scope,
              }) === grant.grantId,
          ),
        ).toBe(true)
        grants.push(grant)
      },
    }
    opened = await atTools({
      scopes: ['cua:click:background', 'cua:bring_to_front:background'],
      calls: 2,
      seams,
      grants: port,
    })
    await opened.session.runToolsPhase()
    expect(grants).toHaveLength(2)
    // Each card says what its own always-allow stores: this card's scope and no other.
    const asked = await opened.session.decisions.list()
    expect(asked.length).toBeGreaterThan(1)
    for (const value of asked) {
      const subject = value.request.spec.subject as { scope: string }
      expect(subject).toMatchObject({ grantScopes: [subject.scope], origin: { package: expect.any(String) } })
    }
    await opened.session.runInference()
    await opened.session.runToolsPhase()
    expect(asks).toBe(2)
    expect(grants).toEqual([
      expect.objectContaining({
        policyDigest: profileHash,
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
      grants: {
        list: async () => [],
        put: async () => {
          throw new Error('store unavailable')
        },
      },
      seams: fakeSeams({
        approval: { ask: async () => ({ verdict: 'allowed-permanent' as const, answeredBy: actor }) },
      }),
    })
    await opened.session.runToolsPhase()
    expect(executions).toBe(0)
    expect((await opened.session.decisions.list()).at(-1)?.result).toMatchObject({
      reason: 'answered',
      response: { option: 'allowed-permanent' },
    })
    expect(
      (await opened.log.scan({ type: 'x/core/approval-grant-activation-failed', limit: 10 })).at(-1)?.data,
    ).toMatchObject({ reason: 'durable grant store unavailable' })
    expect((await opened.log.scan({ type: 'tool/result', limit: 10 })).at(-1)?.data).toMatchObject({
      code: 'APPROVAL_GRANT_UNAVAILABLE',
    })
  })

  it('recovers a permanent approval at both ledger-first crash boundaries without re-asking', async () => {
    const originalGrants: ApprovalGrant[] = []
    const original = await atTools({
      scopes: ['cua:click:background'],
      profile: profileHash,
      grants: {
        list: async () => originalGrants,
        put: async (grant) => {
          originalGrants.push(grant)
        },
      },
      seams: fakeSeams({
        approval: { ask: async () => ({ verdict: 'allowed-permanent' as const, answeredBy: actor }) },
      }),
    })
    await original.session.runToolsPhase()
    const events = await original.log.scan({ fromSeq: 1, toSeq: original.log.lastSeq })
    const facts = events
      .filter((row) => row.type === 'decision/state')
      .map((row) => row.data as unknown as DecisionSnapshot)
    expect(facts.filter((value) => value.revision === 1)).toHaveLength(1)
    expect(facts.find((value) => value.result)?.result).toMatchObject({
      reason: 'answered',
      response: { option: 'allowed-permanent' },
      answeredBy: actor,
    })
    const request = facts[0]!.request
    const subject = request.spec.subject as { policyBinding: string; call: { definitionFingerprint: string } }
    expect(originalGrants).toMatchObject([
      {
        sourceDecisionId: facts[0]!.handle.id,
        issuer: actor,
        definitionFingerprint: subject.call.definitionFingerprint,
        policyBinding: subject.policyBinding,
      },
    ])
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
        // The model route changed between the crash and the reopen; the whole-profile hash moved, authorization did not.
        resolvedProfileHash: `sha256-${'c'.repeat(64)}`,
        policyDigest: profileHash,
        approvalGrants: {
          list: async () => grants,
          put: async (grant) => {
            puts++
            grants.push(grant)
          },
        },
        seams: fakeSeams({
          approval: {
            ask: async () => {
              asks++
              return { verdict: 'rejected' as const, answeredBy: actor }
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
              return { verdict: 'rejected' as const, answeredBy: actor }
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
          toolPolicySettings: async () => ({ policy: 'scripted-review' }),
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
    const denying = new ToolPolicyRegistry()
    denying.register('test', {
      id: 'floor-deny',
      version: '1',
      decide: () => ({ effect: 'deny', reason: 'blocked by the command policy' }),
    })
    const blocked = await atTools({
      scopes: ['tool:write'],
      toolPolicies: denying,
      toolPolicySettings: async () => ({ policy: 'floor-deny' }),
    })
    await blocked.session.runToolsPhase()
    expect((await blocked.log.scan({ type: 'tool/result', limit: 10 })).at(-1)?.data).toMatchObject({
      code: 'POLICY_DENIED',
    })
  })

  it.each(['manual', 'off', 'auto-review'] as const)(
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

  it.each([
    { name: 'a configuration path', check: async () => true, guarded: true },
    { name: 'an ordinary path', check: async () => false, guarded: false },
    {
      // The tool writes `0` relative to the session cwd; the check must see that same absolute path.
      name: 'a relative path resolved against the session cwd',
      check: async (path: string) => !/^([A-Za-z]:)?\/.+\/0$/.test(path),
      guarded: false,
    },
    { name: 'a host without the check', check: undefined, guarded: true },
    {
      name: 'a check that fails',
      check: async () => {
        throw new Error('cannot resolve')
      },
      guarded: true,
    },
    { name: 'a tool that declares no path', check: async () => true, guarded: false, declared: false },
  ])('offers one-time approval only for $name', async ({ check, guarded, declared = true }) => {
    const offered: unknown[] = []
    const opened = await atTools({
      scopes: ['tool:write'],
      grants: { list: async () => [], put: async () => undefined },
      fsOps: { ...testFsOps(), preflight: async () => undefined, ...(check ? { isConfigPath: check } : {}) },
      ...(declared ? { paths: [{ arg: 'value', access: 'write' as const }] } : {}),
      seams: fakeSeams({
        approval: {
          ask: async (request) => {
            offered.push(request.options)
            return { verdict: 'allowed-once' as const, answeredBy: actor }
          },
        },
      }),
    })
    await opened.session.runToolsPhase()
    expect(offered).toEqual([
      guarded
        ? ['allowed-once', 'rejected']
        : ['allowed-once', 'allowed-session', 'allowed-permanent', 'rejected'],
    ])
    const [decision] = await opened.session.decisions.list()
    const presentation = decision?.request.spec.presentation
    expect(presentation?.en?.fields[0]?.value ?? '').toContain(guarded ? 'one call at a time' : '')
    expect(presentation?.['zh-CN']?.fields[0]?.value ?? '').toContain(guarded ? '逐次批准' : '')
    expect(presentation === undefined).toBe(!guarded)
  })

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

  it.each([
    ['EIO', 'E_FS_IO'],
    ['E_WORKSPACE_CLOSED', 'E_WORKSPACE_CLOSED'],
    ['EACCES', 'E_FS_DENIED'],
    ['MEMORY_DISABLED', 'E_FS_DENIED'],
    ['UNKNOWN_PRIVATE_ERROR', 'E_FS_CHECK_FAILED'],
  ])('keeps preflight %s distinct and refuses execution', async (failure, expected) => {
    const blocked = await atTools({
      scopes: ['tool:write'],
      fsOps: {
        ...testFsOps(),
        preflight: async () => {
          throw Object.assign(new Error('PRIVATE_PATH_SENTINEL'), { code: failure })
        },
      },
      paths: [{ arg: 'value', access: 'write' }],
      execute: async () => {
        throw new Error('preflight failure must prevent execution')
      },
    })
    await blocked.session.runToolsPhase()
    const result = (await blocked.log.scan({ type: 'tool/result', limit: 10 })).at(-1)?.data
    expect(result).toMatchObject({ code: expected, isError: true })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PATH_SENTINEL')
    expect(
      (await blocked.log.scan({ type: 'effect/intent', limit: 100 })).filter(
        (row) => (row.data as { kind: string }).kind === 'tool',
      ),
    ).toEqual([])
  })

  it.each([false, true])(
    'provides tool-free reviewer requests and refuses unreserved hard-budget reviews (hard=%s)',
    async (hard) => {
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
      // Session start keeps an auxiliary slot only when the provider catalogue publishes that model.
      provider.models = () => [
        {
          id: 'm',
          name: 'm',
          api: 'openai-completions',
          route: 'default',
          baseUrl: 'https://example.invalid/v1',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1024,
          toolCallFormats: ['native'],
          thinkingReplay: 'native',
          contract_id: null,
        },
        {
          id: 'scripted-cheap',
          name: 'scripted-cheap',
          api: 'openai-completions',
          route: 'cheap',
          baseUrl: 'https://example.invalid/v1',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8_000,
          maxTokens: 1024,
          toolCallFormats: ['native'],
          thinkingReplay: 'native',
          contract_id: null,
          slot: 'fast',
        },
      ]
      let writes = 0
      const opened = await atTools({
        ...(hard
          ? {
              input: {
                actor,
                content: [{ type: 'text' as const, text: 'bounded' }],
                budget: 10,
                hardBudget: true,
              },
            }
          : {}),
        execute: async () => {
          writes++
          return { content: [{ type: 'text' as const, text: 'done' }] }
        },
        provider,
        preset,
        scopes: ['tool:write'],
        toolPolicies: policies,
        toolPolicySettings: async () => ({ policy: 'budget-review' }),
        seams: fakeSeams({
          approval: { ask: async () => ({ verdict: 'rejected' as const, answeredBy: actor }) },
        }),
      })
      if (hard) {
        await expect(opened.session.runToolsPhase()).rejects.toThrow('hard turn budget')
        expect(provider.requests.some((request) => request.model === 'scripted-cheap')).toBe(false)
        expect(writes).toBe(0)
        return
      }
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
    },
  )

  it('re-decides a resumed review with the current policy and reuses only the recorded model output', async () => {
    const modelReviewing = (id: string) => {
      const registry = new ToolPolicyRegistry()
      registry.register('test', {
        id,
        version: '1',
        async decide(_input, signal, ports) {
          await ports!.reserve(5)
          const response = await ports!.model({ slot: 'fast', prompt: 'Review the bounded write' }, signal)
          return {
            effect: 'allow' as const,
            reason: response.text,
            review: {
              model: response.model,
              promptHash: 'a'.repeat(64),
              argsHash: sha256Hex(canonicalJson({ value: '0' })),
              scopeHash: 'b'.repeat(64),
              decision: 'allow' as const,
              risk: 'low' as const,
              reason: response.text,
              latencyMs: 1,
              cost: response.cost,
              costSource: response.costSource ?? ('estimated' as const),
              source: 'model' as const,
            },
          }
        },
      })
      return registry
    }
    const preset = presetDefaults()
    preset.model.route.fast = 'cheap'
    preset.model.id.fast = 'scripted-cheap'
    const catalogue = (provider: Provider) => {
      provider.models = () => [
        {
          id: 'scripted-cheap',
          name: 'scripted-cheap',
          api: 'openai-completions',
          route: 'cheap',
          baseUrl: 'https://example.invalid/v1',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8_000,
          maxTokens: 1024,
          toolCallFormats: ['native'],
          thinkingReplay: 'native',
          contract_id: null,
          slot: 'fast',
        },
      ]
      return provider
    }
    let executions = 0
    const original = await atTools({
      provider: catalogue(
        fakeProvider([toolTurn('scoped_write', { value: '0' }), textTurn('Bounded write')]),
      ),
      preset,
      scopes: ['tool:write'],
      toolPolicies: modelReviewing('model-review'),
      toolPolicySettings: async () => ({ policy: 'model-review' }),
      execute: async () => {
        executions++
        return { content: [{ type: 'text', text: 'done' }] }
      },
    })
    await original.session.runToolsPhase()
    expect(executions).toBe(1)
    const events = await original.log.scan({ fromSeq: 1, toSeq: original.log.lastSeq })
    const review = events.find((row) => row.type === 'x/approval/review')!
    const reopen = async (policies: ToolPolicyRegistry, policy: string, provider: Provider) => {
      const reopened = await openSession({
        provider: catalogue(provider),
        preset,
        toolPolicies: policies,
        toolPolicySettings: async () => ({ policy }),
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
        writerRunId: `review-recovery-${policy}`,
      })
      await reopened.session.resume()
      await reopened.session.runToolsPhase()
      return reopened
    }
    const denying = new ToolPolicyRegistry()
    denying.register('test', {
      id: 'tightened',
      version: '1',
      decide: () => ({ effect: 'deny', reason: 'blocked by the command policy' }),
    })
    const tightened = await reopen(denying, 'tightened', fakeProvider([]))
    expect(executions).toBe(1)
    expect((await tightened.log.scan({ type: 'tool/result', limit: 10 })).at(-1)?.data).toMatchObject({
      code: 'POLICY_DENIED',
    })
    const sameProvider = fakeProvider([])
    await reopen(modelReviewing('model-review'), 'model-review', sameProvider)
    expect(executions).toBe(2)
    expect(sameProvider.requests.filter((request) => request.model === 'scripted-cheap')).toHaveLength(0)
  })

  it('keeps an escalating review as an observation when the command table allows the call', async () => {
    let asks = 0,
      executions = 0
    const registry = new ToolPolicyRegistry()
    registry.register('test', {
      id: 'escalating',
      version: '1',
      decide: (input) => ({
        effect: 'ask',
        reason: 'Reviewer unavailable; human approval required',
        review: {
          model: 'fast',
          promptHash: 'a'.repeat(64),
          argsHash: sha256Hex(canonicalJson(input.call.args)),
          scopeHash: 'b'.repeat(64),
          costSource: 'unavailable',
          decision: 'escalate',
          risk: 'medium',
          reason: 'Reviewer unavailable; human approval required',
          latencyMs: 0,
          cost: 0,
          source: 'fallback',
        },
      }),
    })
    const opened = await atTools({
      scopes: ['tool:write'],
      toolPolicies: registry,
      preset: withCommandTable([{ tool: 'scoped_write', argv: '.*', action: 'allow' }]),
      toolPolicySettings: async () => ({ policy: 'escalating' }),
      seams: fakeSeams({
        approval: {
          ask: async () => {
            asks++
            return { verdict: 'rejected' as const, answeredBy: actor }
          },
        },
      }),
      execute: async () => {
        executions++
        return { content: [{ type: 'text', text: 'done' }] }
      },
    })
    await opened.session.runToolsPhase()
    expect({ asks, executions }).toEqual({ asks: 0, executions: 1 })
    expect((await opened.log.scan({ type: 'x/approval/review', limit: 10 })).at(-1)?.data).toMatchObject({
      effect: 'allow',
      allowedBy: 'command-policy',
      review: { decision: 'escalate', source: 'fallback' },
    })
  })

  it('enforces the command table of the preset the session runs under, not another preset’s', async () => {
    const run = async (preset?: import('@agnes/core-common/step/preset').PresetView) => {
      let executions = 0
      const opened = await atTools({
        scopes: ['tool:write'],
        approvalMode: 'off',
        ...(preset ? { preset } : {}),
        execute: async () => {
          executions++
          return { content: [{ type: 'text', text: 'done' }] }
        },
      })
      await opened.session.runToolsPhase()
      const [result] = await opened.log.scan({ type: 'tool/result', limit: 1 })
      return { executions, result: result?.data as { isError?: boolean; content: unknown } }
    }
    const denied = await run(
      withCommandTable([{ tool: 'scoped_write', argv: '"value":"0"', action: 'deny' }]),
    )
    expect(denied.executions).toBe(0)
    expect(JSON.stringify(denied.result)).toContain('blocked by the command policy')
    // The same call under a preset that states no such rule is not held to it.
    expect((await run()).executions).toBe(1)
  })

  it('ends every answered decision of a call a human rejected', async () => {
    let executions = 0
    const verdicts = ['allowed-once', 'rejected'] as const
    let asked = 0
    const opened = await atTools({
      scopes: ['tool:write', 'tool:other'],
      seams: fakeSeams({
        approval: {
          ask: async () => ({ verdict: verdicts[asked++]!, answeredBy: actor }),
        },
      }),
      execute: async () => {
        executions++
        return { content: [{ type: 'text', text: 'done' }] }
      },
    })
    await opened.session.runToolsPhase()
    expect({ asked, executions }).toEqual({ asked: 2, executions: 0 })
    expect((await opened.log.scan({ type: 'tool/result', limit: 10 })).at(-1)?.data).toMatchObject({
      code: 'APPROVAL_REJECTED',
    })
    const latest = new Map<string, { consumption: unknown; result: { response?: { option?: string } } }>()
    for (const row of await opened.log.scan({ type: 'decision/state', limit: 50 })) {
      const value = row.data as { handle: { id: string }; consumption: unknown; result: never }
      latest.set(value.handle.id, value)
    }
    expect([...latest.values()].map((value) => value.result.response?.option)).toEqual([
      'allowed-once',
      'rejected',
    ])
    expect([...latest.values()].every((value) => value.consumption !== null)).toBe(true)
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
            return { verdict: 'allowed-once' as const, answeredBy: actor }
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

it.each(['manual', 'off', 'auto-review'] as const)(
  'full-access records a one-shot allowance for principal and exact-content policy approvals in %s mode',
  async (approvalMode) => {
    let executed = false
    const ask = vi.fn(async () => {
      throw new Error('Human request must not be raised')
    })
    const preset = presetDefaults()
    preset.name = 'standard'
    preset.permission = 'full-access'
    preset.approval.policy = 'full-access'
    const policies = new ToolPolicyRegistry()
    policies.register('fixture', {
      id: 'full-access',
      version: '1.0.0',
      decide(input) {
        expect(input.fullAccess).toBe(true)
        return {
          effect: 'ask',
          reason: 'exact-content review',
          approval: {
            reviewerRequirement: 'human',
            grantConstraints: 'once',
            subjectRevision: 'a'.repeat(64),
          },
        }
      },
    })
    const f = await atTools({
      scopes: ['credential.admin'],
      preset,
      approvalMode,
      toolPolicies: policies,
      seams: fakeSeams({
        approval: { ask },
        principals: {
          authorize: async () => ({
            decisionId: 'principal-review',
            effect: 'require_approval',
            reason: 'principal approval',
          }),
        },
      }),
      execute: async (_args, context) => {
        executed = true
        expect(context.approval?.answeredBy.role).toBe('system')
        return { content: [] }
      },
    })
    try {
      await f.session.runToolsPhase()
      expect(executed).toBe(true)
      expect(ask).not.toHaveBeenCalled()
      expect((await f.session.decisions.list())[0]).toMatchObject({
        result: { code: 'full-access', response: { option: 'allowed-once' } },
        consumption: expect.any(Object),
      })
    } finally {
      await f.session.close()
    }
  },
)

describe('hard block at dispatch', () => {
  it.each(['manual', 'off', 'auto-review'] as const)(
    'refuses an unrecoverable shell command in %s mode under an allow-everything policy, without asking',
    async (approvalMode) => {
      let asks = 0
      let executions = 0
      const shell: ToolDef = {
        ...scopedTool(['tool:shell:execute'], async () => {
          executions++
          return { content: [{ type: 'text', text: 'ran' }] }
        }),
        name: 'shell',
        parameters: Type.Object({ command: Type.String() }),
      }
      shell.meta = { ...shell.meta, commandArg: 'command' }
      const policies = new ToolPolicyRegistry()
      policies.register('test', {
        id: 'allow-all',
        version: '1',
        decide: () => ({ effect: 'allow', reason: 'full access' }),
      })
      const opened = await openSession({
        provider: fakeProvider([toolTurn('shell', { command: 'sudo rm -rf /' }), textTurn('done')]),
        registry: registryWith(shell),
        approvalMode,
        toolPolicies: policies,
        toolPolicySettings: async () => ({ policy: 'allow-all' }),
        seams: fakeSeams({
          approval: {
            ask: async () => {
              asks++
              return { verdict: 'allowed-once', answeredBy: actor }
            },
          },
        }),
      })
      await opened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
      await opened.session.acceptInput()
      await opened.session.runInference()
      await opened.session.runToolsPhase()
      expect((await opened.log.scan({ type: 'tool/result', limit: 10 })).at(-1)?.data).toMatchObject({
        code: 'POLICY_HARD_BLOCKED',
        isError: true,
      })
      expect({ asks, executions }).toEqual({ asks: 0, executions: 0 })
      expect(await opened.log.scan({ type: 'decision/state', limit: 5 })).toEqual([])
    },
  )
})
