import { describe, expect, it, vi } from 'vitest'
import type { FsPolicy } from '../src/effects/fs-guard.js'
import { buildToolContext, type FsOps } from '../src/effects/tool-context.js'
import { SeamRuntime, withTimeout } from '../src/effects/wrap.js'
import { presetDefaults } from '../src/step/preset.js'
import {
  createWorkspaceInvocationPort,
  type WorkspaceInvocationPort,
  type WorkspaceInvocationSource,
  type WorkspaceInvocationView,
  type WorkspacePublicationDispatch,
} from '../src/workspace/runtime.js'
import { fencedFs, testFsPolicy } from '../testkit/fenced-fs.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { testFsOps } from './helpers/open-session.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const req = {
  requestId: 'r',
  kind: 'tool' as const,
  sessionKey: 'k',
  stepId: '1/1',
  summary: 's',
  risk: 'destructive' as const,
  actor,
  taint: false,
  bindingHash: 'h',
  deadline: 't',
  scope: 'k',
}
const sig = () => new AbortController().signal

const workspacePort = (seams: ReturnType<typeof fakeSeams>, release: () => void | Promise<void>) =>
  createWorkspaceInvocationPort(() => ({
    source: {
      root: '/w',
      fs: testFsOps(),
      ready: async () => ({ confine: async (argv) => argv }),
      hookSnapshot: async () => ({ workspaceDigest: 'workspace', policyRevision: 'policy', hooks: [] }),
      hookSandbox: {
        enforcement: () => ({ level: 'full', scope: ['process'] }),
        exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
      },
      approval: seams.approval,
      checkpoint: seams.checkpoint,
    } satisfies WorkspaceInvocationSource,
    release,
  }))

describe('SeamRuntime', () => {
  it('maps approval failures to rejected and reports which seam and op failed', async () => {
    const failures: unknown[] = []
    const seams = fakeSeams({
      approval: {
        ask: async () => {
          throw new Error('oa down')
        },
        resume: async () => null,
      },
    })
    const rt = new SeamRuntime(seams, presetDefaults(), {
      clock: () => 0,
      onFailure: (f) => failures.push(f),
    })
    expect(await rt.approvalAsk(req, sig())).toBe('rejected')
    expect(failures).toEqual([{ seam: 'approval', op: 'ask', message: 'oa down' }])
  })

  it('hands workspace approval acquisition through Host publication exactly once', async () => {
    const events: string[] = []
    const seams = fakeSeams({
      approval: { ask: async () => 'allowed-once', resume: async () => null },
    })
    const port = workspacePort(seams, () => {
      events.push('workspace:release')
    })
    const rt = new SeamRuntime(seams, presetDefaults(), {
      clock: () => 0,
      onFailure: () => undefined,
      workspaceInvocation: port,
      workspacePublication: {
        workspace: async <T>(
          resolve: () => Readonly<{
            port: WorkspaceInvocationPort
            handler: (view: WorkspaceInvocationView) => T | Promise<T>
          }>,
        ): Promise<Awaited<T>> => {
          events.push('publication:enter')
          const target = resolve()
          const pending = target.port.run(async (view) => {
            events.push('handler')
            return target.handler(view)
          })
          events.push('publication:release')
          return (await pending) as Awaited<T>
        },
      } satisfies WorkspacePublicationDispatch,
    })

    await expect(rt.approvalAsk(req, sig())).resolves.toBe('allowed-once')
    expect(events).toEqual(['publication:enter', 'publication:release', 'handler', 'workspace:release'])
  })

  it('approval timeout is rejected; an out-of-set verdict is rejected; unavailable passes through only under park', async () => {
    const never = fakeSeams({
      approval: { ask: () => new Promise(() => undefined), resume: async () => null },
    })
    const short = { ...presetDefaults(), approval: { ...presetDefaults().approval, timeoutMs: 5 } }
    const timeouts: unknown[] = []
    expect(
      await new SeamRuntime(never, short, { clock: () => 0, onFailure: (f) => timeouts.push(f) }).approvalAsk(
        req,
        sig(),
      ),
    ).toBe('rejected')
    expect(timeouts).toEqual([{ seam: 'approval', op: 'ask', message: 'timeout: approval.ask' }])

    const weird = fakeSeams({ approval: { ask: async () => 'yes' as never, resume: async () => null } })
    const odd: unknown[] = []
    expect(
      await new SeamRuntime(weird, presetDefaults(), {
        clock: () => 0,
        onFailure: (f) => odd.push(f),
      }).approvalAsk(req, sig()),
    ).toBe('rejected')
    expect(odd).toEqual([{ seam: 'approval', op: 'ask', message: 'verdict out of set: yes' }])

    const unavailable = fakeSeams({ approval: { ask: async () => 'unavailable', resume: async () => null } })
    const park = {
      ...presetDefaults(),
      approval: { ...presetDefaults().approval, onUnavailable: 'park' as const },
    }
    expect(
      await new SeamRuntime(unavailable, park, { clock: () => 0, onFailure: () => undefined }).approvalAsk(
        req,
        sig(),
      ),
    ).toBe('unavailable')
    expect(
      await new SeamRuntime(unavailable, presetDefaults(), {
        clock: () => 0,
        onFailure: () => undefined,
      }).approvalAsk(req, sig()),
    ).toBe('rejected')
  })

  it('a Pending ticket is passed through rather than read as a verdict', async () => {
    const pending = fakeSeams({
      approval: {
        ask: async () => ({ ticket: 'T1', expiresAt: '2026-09-08T00:00:00Z' }),
        resume: async () => null,
      },
    })
    const rt = new SeamRuntime(pending, presetDefaults(), { clock: () => 0, onFailure: () => undefined })
    expect(await rt.approvalAsk(req, sig())).toEqual({ ticket: 'T1', expiresAt: '2026-09-08T00:00:00Z' })
  })

  it.each([
    {
      name: 'throw',
      guard: async () => {
        throw new Error('guardian down')
      },
    },
    {
      name: 'invalid response',
      guard: async () =>
        ({ decision: 'escalate', ruleVersion: 'v1', reasons: [], model: 'm'.repeat(129) }) as never,
    },
  ])('guardian $name escalates instead of allowing', async ({ guard }) => {
    const failures: unknown[] = []
    const rt = new SeamRuntime(fakeSeams({ approval: { guard } }), presetDefaults(), {
      clock: () => 0,
      onFailure: (f) => failures.push(f),
    })
    await expect(rt.approvalGuard(req, sig())).resolves.toEqual({
      decision: 'escalate',
      ruleVersion: 'failed',
      reasons: ['guardian unavailable'],
    })
    expect(failures).toEqual([expect.objectContaining({ seam: 'approval', op: 'guard' })])
  })

  it('guardian timeout escalates and a failed durable put is never reported successful', async () => {
    const short = { ...presetDefaults(), approval: { ...presetDefaults().approval, timeoutMs: 5 } }
    const failures: unknown[] = []
    const rt = new SeamRuntime(
      fakeSeams({
        approval: {
          guard: () => new Promise(() => undefined),
          putGrant: async () => {
            throw new Error('grant store down')
          },
        },
      }),
      short,
      { clock: () => 0, onFailure: (f) => failures.push(f) },
    )
    await expect(rt.approvalGuard(req, sig())).resolves.toMatchObject({
      decision: 'escalate',
      ruleVersion: 'failed',
    })
    await expect(
      rt.approvalPutGrant(
        {
          grantId: 'g',
          profileHash: `sha256-${'a'.repeat(64)}`,
          actorId: 'u',
          actorOrg: 'local',
          toolId: 'computer_use',
          scope: 'cua:click:background',
          policyVersion: 'cua-v1',
          createdAt: '2026-09-17T00:00:00.000Z',
        },
        sig(),
      ),
    ).resolves.toBe(false)
    expect(failures).toEqual([
      expect.objectContaining({ op: 'guard', message: 'timeout: approval.guard' }),
      expect.objectContaining({ op: 'putGrant', message: 'grant store down' }),
    ])
  })

  it('lists and revokes durable approval grants through the bounded seam runtime', async () => {
    const grant = {
      grantId: 'g',
      profileHash: `sha256-${'a'.repeat(64)}`,
      actorId: 'u',
      actorOrg: 'local',
      toolId: 'computer_use',
      scope: 'cua:click:background',
      policyVersion: 'cua-v1',
      createdAt: '2026-09-17T00:00:00.000Z',
    }
    const rt = new SeamRuntime(
      fakeSeams({
        approval: {
          listGrants: async () => [grant],
          revokeGrant: async (grantId, revokedAt) =>
            grantId === grant.grantId ? { ...grant, revokedAt } : null,
        },
      }),
      presetDefaults(),
      { clock: () => 0, onFailure: () => undefined },
    )
    const query = {
      profileHash: grant.profileHash,
      actorId: grant.actorId,
      actorOrg: grant.actorOrg,
      toolId: grant.toolId,
      scope: grant.scope,
      policyVersion: grant.policyVersion,
    }
    await expect(rt.approvalGrants(query, sig())).resolves.toEqual([grant])
    await expect(rt.approvalRevokeGrant('g', '2026-09-17T01:00:00.000Z', sig())).resolves.toEqual({
      ...grant,
      revokedAt: '2026-09-17T01:00:00.000Z',
    })
  })

  it('owns one workspace lease across approval timeout, failure, and park outcomes', async () => {
    const immediateTimers = {
      setTimeout: (fn: () => void) => {
        queueMicrotask(fn)
        return 0
      },
      clearTimeout: () => undefined,
    }
    const short = { ...presetDefaults(), approval: { ...presetDefaults().approval, timeoutMs: 1 } }

    const timeoutRelease = vi.fn()
    let settleTimedOutApproval!: (verdict: 'allowed-once') => void
    const timedOutApproval = new Promise<'allowed-once'>((resolve) => {
      settleTimedOutApproval = resolve
    })
    const timeoutApproval = fakeSeams({
      approval: { ask: () => timedOutApproval },
    })
    const timeoutRuntime = new SeamRuntime(fakeSeams(), short, {
      clock: () => 0,
      onFailure: () => undefined,
      timers: immediateTimers,
      workspaceInvocation: workspacePort(timeoutApproval, timeoutRelease),
    })
    await expect(timeoutRuntime.approvalAsk(req, sig())).resolves.toBe('rejected')
    expect(timeoutRelease).not.toHaveBeenCalled()
    settleTimedOutApproval('allowed-once')
    await vi.waitFor(() => expect(timeoutRelease).toHaveBeenCalledOnce())

    const failureRelease = vi.fn()
    const failedApproval = fakeSeams({
      approval: {
        ask: async () => {
          throw new Error('workspace approver failed')
        },
      },
    })
    const failureRuntime = new SeamRuntime(fakeSeams(), presetDefaults(), {
      clock: () => 0,
      onFailure: () => undefined,
      workspaceInvocation: workspacePort(failedApproval, failureRelease),
    })
    await expect(failureRuntime.approvalAsk(req, sig())).resolves.toBe('rejected')
    expect(failureRelease).toHaveBeenCalledOnce()

    const parkRelease = vi.fn()
    const parkedApproval = fakeSeams({ approval: { ask: async () => 'unavailable' } })
    const parkPreset = {
      ...presetDefaults(),
      approval: { ...presetDefaults().approval, onUnavailable: 'park' as const },
    }
    const parkRuntime = new SeamRuntime(fakeSeams(), parkPreset, {
      clock: () => 0,
      onFailure: () => undefined,
      workspaceInvocation: workspacePort(parkedApproval, parkRelease),
    })
    await expect(parkRuntime.approvalAsk(req, sig())).resolves.toBe('unavailable')
    expect(parkRelease).toHaveBeenCalledOnce()
  })

  it('routes approval and checkpoint operations only through the workspace invocation', async () => {
    const grant = {
      grantId: 'g',
      profileHash: `sha256-${'a'.repeat(64)}`,
      actorId: 'u',
      actorOrg: 'local',
      toolId: 'shell',
      scope: 'tool:shell:execute',
      policyVersion: 'v1',
      createdAt: '2026-09-17T00:00:00.000Z',
    }
    const globalApproval = vi.fn(async () => {
      throw new Error('global approval called')
    })
    const globalCheckpoint = vi.fn(async () => {
      throw new Error('global checkpoint called')
    })
    const global = fakeSeams({
      approval: {
        ask: globalApproval,
        resume: globalApproval,
        guard: globalApproval,
        listGrants: globalApproval,
        putGrant: globalApproval,
        revokeGrant: globalApproval,
      },
      checkpoint: {
        snapshot: globalCheckpoint,
        rewind: globalCheckpoint,
        list: globalCheckpoint,
      },
    })
    const bound = fakeSeams({
      approval: {
        ask: async () => 'allowed-once',
        resume: async () => ({ requestId: 'r', bindingHash: 'h', expiresAt: 't' }),
        guard: async () => ({ decision: 'allow-once', ruleVersion: 'v1', reasons: [] }),
        listGrants: async () => [grant],
        putGrant: async () => undefined,
        revokeGrant: async (_id, revokedAt) => ({ ...grant, revokedAt }),
      },
      checkpoint: {
        snapshot: async () => ({ id: 'cp' }),
        rewind: async () => undefined,
        list: async () => [{ id: 'cp', stepId: '1/1' }],
      },
    })
    const release = vi.fn()
    const rt = new SeamRuntime(global, presetDefaults(), {
      clock: () => 0,
      onFailure: () => undefined,
      workspaceInvocation: workspacePort(bound, release),
    })

    await expect(rt.approvalAsk(req, sig())).resolves.toBe('allowed-once')
    await expect(rt.approvalGuard(req, sig())).resolves.toMatchObject({ decision: 'allow-once' })
    await expect(
      rt.approvalGrants(
        {
          profileHash: grant.profileHash,
          actorId: grant.actorId,
          actorOrg: grant.actorOrg,
          toolId: grant.toolId,
          scope: grant.scope,
          policyVersion: grant.policyVersion,
        },
        sig(),
      ),
    ).resolves.toEqual([grant])
    await expect(rt.approvalPutGrant(grant, sig())).resolves.toBe(true)
    await expect(rt.approvalRevokeGrant('g', 'revoked', sig())).resolves.toMatchObject({
      grantId: 'g',
      revokedAt: 'revoked',
    })
    await expect(rt.approvalResume('ticket', 'allowed-once')).resolves.toMatchObject({ requestId: 'r' })
    await expect(rt.checkpointSnapshot(['a'], '1/1')).resolves.toEqual({ ok: true, id: 'cp' })
    await expect(rt.checkpointRewind('cp')).resolves.toBe(true)
    await expect(rt.checkpointList()).resolves.toEqual([{ id: 'cp', stepId: '1/1' }])

    expect(release).toHaveBeenCalledTimes(9)
    expect(globalApproval).not.toHaveBeenCalled()
    expect(globalCheckpoint).not.toHaveBeenCalled()
  })

  it('releases each checkpoint invocation once when the bound operation throws', async () => {
    const release = vi.fn()
    const failed = fakeSeams({
      checkpoint: {
        snapshot: async () => {
          throw new Error('snapshot failed')
        },
        rewind: async () => {
          throw new Error('rewind failed')
        },
        list: async () => {
          throw new Error('list failed')
        },
      },
    })
    const rt = new SeamRuntime(fakeSeams(), presetDefaults(), {
      clock: () => 0,
      onFailure: () => undefined,
      workspaceInvocation: workspacePort(failed, release),
    })

    await expect(rt.checkpointSnapshot([], '1/1')).resolves.toEqual({ ok: false, reason: 'snapshot failed' })
    await expect(rt.checkpointRewind('cp')).resolves.toBe(false)
    await expect(rt.checkpointList()).resolves.toEqual([])
    expect(release).toHaveBeenCalledTimes(3)
  })

  it('verifier failure is fail, repair failure is park, ledger failure is false and an infinite projection', async () => {
    const boom = () => {
      throw new Error('x')
    }
    const seams = fakeSeams({
      verifier: { verify: async () => boom() },
      repair: { decide: async () => boom() },
      ledger: { record: async () => boom(), projected: async () => boom() },
    })
    const rt = new SeamRuntime(seams, presetDefaults(), { clock: () => 0, onFailure: () => undefined })
    expect(await rt.verify('tool', {}, sig())).toEqual({ verdict: 'fail', reasons: ['verifier unavailable'] })
    expect(await rt.repairDecide({ turn: 1, round: 1, history: [] }, { verdict: 'fail', reasons: [] })).toBe(
      'park',
    )
    expect(
      await rt.ledgerRecord({
        purpose: 'inference',
        effectId: 'e',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
        model: 'm',
        sessionKey: 'k',
        lane: 'main',
        turn: 1,
        step: 1,
      }),
    ).toBe(false)
    expect((await rt.ledgerProjected({ tokensEstimate: 1, model: 'm' })).credits).toBe(
      Number.POSITIVE_INFINITY,
    )
  })

  it('treats an unavailable artifact poll as still running and records the seam failure', async () => {
    const failures: unknown[] = []
    const seams = fakeSeams({
      artifacts: {
        poll: async () => {
          throw new Error('job store down')
        },
      },
    })
    const rt = new SeamRuntime(seams, presetDefaults(), {
      clock: () => 0,
      onFailure: (f) => failures.push(f),
    })

    await expect(rt.artifactsPoll('job-7')).resolves.toEqual({ jobId: 'job-7', status: 'running' })
    expect(failures).toEqual([{ seam: 'artifacts', op: 'poll', message: 'job store down' }])
  })

  it('caches authorize decisions for 60 s, keyed by actor/action/target, and denies when principals throws', async () => {
    let now = 0
    let calls = 0
    const seams = fakeSeams({
      principals: {
        resolve: async () => actor,
        authorize: async () => {
          calls++
          return { decisionId: 'd', effect: 'allow', reason: 'ok' }
        },
      },
    })
    const rt = new SeamRuntime(seams, presetDefaults(), { clock: () => now, onFailure: () => undefined })
    await rt.authorize(actor, 'select', { kind: 'table', id: 't' })
    await rt.authorize(actor, 'select', { kind: 'table', id: 't' })
    expect(calls).toBe(1)
    // A different target is a different decision, so it is not served from the first one's entry.
    await rt.authorize(actor, 'select', { kind: 'table', id: 'other' })
    expect(calls).toBe(2)
    now = 60_000
    await rt.authorize(actor, 'select', { kind: 'table', id: 't' })
    expect(calls).toBe(3)
    const bad = fakeSeams({
      principals: {
        resolve: async () => actor,
        authorize: async () => {
          throw new Error('x')
        },
      },
    })
    expect(
      await new SeamRuntime(bad, presetDefaults(), { clock: () => 0, onFailure: () => undefined }).authorize(
        actor,
        'select',
        { kind: 'table', id: 't' },
      ),
    ).toEqual({ decisionId: 'n/a', effect: 'deny', reason: 'principals unavailable' })
  })

  it('invalidates cached decisions and capabilities after seam implementations change', async () => {
    const firstAuthorize = vi.fn(async () => ({
      decisionId: 'first',
      effect: 'allow' as const,
      reason: 'first',
    }))
    const firstCapability = vi.fn(() => ({ level: 'full' as const, scope: ['network'] }))
    const seams = fakeSeams({
      principals: { authorize: firstAuthorize },
      platform: { capability: firstCapability },
    })
    const runtime = new SeamRuntime(seams, presetDefaults(), {
      clock: () => 0,
      onFailure: () => undefined,
    })
    const target = { kind: 'skill' as const, id: 'search' }

    await expect(runtime.authorize(actor, 'execute', target)).resolves.toMatchObject({ decisionId: 'first' })
    expect(runtime.capability('network')).toMatchObject({ level: 'full' })

    const nextAuthorize = vi.fn(async () => ({ decisionId: 'next', effect: 'deny' as const, reason: 'next' }))
    const nextCapability = vi.fn(() => ({ level: 'unavailable' as const, scope: [], reason: 'next' }))
    seams.principals = { ...seams.principals, authorize: nextAuthorize }
    seams.platform = { ...seams.platform, capability: nextCapability }

    await expect(runtime.authorize(actor, 'execute', target)).resolves.toMatchObject({ decisionId: 'first' })
    expect(runtime.capability('network')).toMatchObject({ level: 'full' })
    expect(nextAuthorize).not.toHaveBeenCalled()
    expect(nextCapability).not.toHaveBeenCalled()

    runtime.invalidate()

    await expect(runtime.authorize(actor, 'execute', target)).resolves.toMatchObject({ decisionId: 'next' })
    expect(runtime.capability('network')).toMatchObject({ level: 'unavailable' })
    expect(firstAuthorize).toHaveBeenCalledTimes(1)
    expect(firstCapability).toHaveBeenCalledTimes(1)
    expect(nextAuthorize).toHaveBeenCalledTimes(1)
    expect(nextCapability).toHaveBeenCalledTimes(1)
  })

  it('sandbox enforcement falls back to none, and sandboxAllowed follows the preset from there', async () => {
    let enforcementCalls = 0
    const bad = fakeSeams({
      sandbox: {
        enforcement: () => {
          enforcementCalls++
          throw new Error('no sandbox')
        },
      },
    })
    const deny = new SeamRuntime(bad, presetDefaults(), { clock: () => 0, onFailure: () => undefined })
    expect(deny).not.toHaveProperty('seams')
    expect(deny).not.toHaveProperty('sandboxExec')
    expect(deny).not.toHaveProperty('sandboxConfine')
    expect(deny.enforcement()).toEqual({ level: 'none', scope: [] })
    expect(deny.sandboxAllowed()).toBe(false)
    // Admission uses the immutable open-time fact; it does not call a raw workspace seam after a
    // table has begun closing or an invocation lease has been released.
    expect(deny.sandboxAllowed()).toBe(false)
    expect(enforcementCalls).toBe(2)
    const allow = new SeamRuntime(
      bad,
      { ...presetDefaults(), sandbox: { onUnavailable: 'allow' } },
      {
        clock: () => 0,
        onFailure: () => undefined,
      },
    )
    expect(allow.sandboxAllowed()).toBe(true)
    expect(
      new SeamRuntime(fakeSeams(), presetDefaults(), {
        clock: () => 0,
        onFailure: () => undefined,
      }).sandboxAllowed(),
    ).toBe(true)
  })

  it('withTimeout rejects on time and on abort, and names what it was waiting for', async () => {
    await expect(withTimeout(new Promise(() => undefined), 5, 'x')).rejects.toThrow('timeout: x')
    const ac = new AbortController()
    const p = withTimeout(new Promise(() => undefined), 1000, 'y', ac.signal)
    ac.abort()
    await expect(p).rejects.toThrow('aborted: y')
    await expect(withTimeout(Promise.resolve(7), 1000, 'z')).resolves.toBe(7)
  })
})

describe('withTimeout resource lifecycle', () => {
  const setup = () => {
    const pending = new Map<number, () => void>()
    let id = 0
    const timers = {
      setTimeout: (fn: () => void) => {
        pending.set(++id, fn)
        return id
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number)
      },
    }
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const fire = () => {
      const callback = pending.values().next().value
      if (!callback) throw new Error('No pending timeout')
      callback()
    }
    return { pending, timers, controller, remove, fire }
  }

  it.each(['timeout', 'abort'] as const)(
    'releases resources on %s even if the operation never settles',
    async (kind) => {
      const { pending, timers, controller, remove, fire } = setup()
      const result = withTimeout(new Promise(() => undefined), 100, 'pending', controller.signal, timers)
      const check = expect(result).rejects.toThrow(`${kind === 'abort' ? 'aborted' : 'timeout'}: pending`)
      if (kind === 'abort') controller.abort()
      else fire()
      await check
      expect(pending.size).toBe(0)
      expect(remove).toHaveBeenCalledOnce()
    },
  )

  it.each(['resolve', 'reject'] as const)('releases resources on operation %s', async (kind) => {
    const { pending, timers, controller, remove } = setup()
    const operation = kind === 'resolve' ? Promise.resolve(7) : Promise.reject(new Error('operation'))
    const result = withTimeout(operation, 100, 'settled', controller.signal, timers)
    if (kind === 'resolve') await expect(result).resolves.toBe(7)
    else await expect(result).rejects.toThrow('operation')
    expect(pending.size).toBe(0)
    expect(remove).toHaveBeenCalledOnce()
    controller.abort()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('consumes late failure after timeout and cleans up only once', async () => {
    const { pending, timers, controller, remove, fire } = setup()
    let fail!: (error: Error) => void
    const operation = new Promise<never>((_, reject) => {
      fail = reject
    })
    const result = withTimeout(operation, 100, 'late', controller.signal, timers)
    const check = expect(result).rejects.toThrow('timeout: late')
    fire()
    await check
    fail(new Error('late rejection'))
    await Promise.resolve()
    controller.abort()
    expect(remove).toHaveBeenCalledOnce()
    expect(pending.size).toBe(0)
  })

  it('consumes rejection after an already aborted call without arming a timer', async () => {
    const { pending, timers, controller } = setup()
    controller.abort()
    await expect(
      withTimeout(Promise.reject(new Error('late')), 100, 'cancelled', controller.signal, timers),
    ).rejects.toThrow('aborted: cancelled')
    await Promise.resolve()
    expect(pending.size).toBe(0)
  })
})

describe('buildToolContext hands every path to the file system, and decides none of them', () => {
  const build = (fsPolicy: FsPolicy, seen: string[], seams: Record<string, unknown> = {}) => {
    const runtime = new SeamRuntime(
      fakeSeams({ sandbox: { fsPolicy: () => fsPolicy }, ...seams } as never),
      presetDefaults(),
      { clock: () => 0, onFailure: () => undefined },
    )
    const record: FsOps = {
      read: async (path) => {
        seen.push(path)
        return new Uint8Array()
      },
      write: async (path) => {
        seen.push(path)
      },
      list: async (path) => {
        seen.push(path)
        return []
      },
      stat: async (path) => {
        seen.push(path)
        return { kind: 'file' as const, size: 0, mtimeMs: 0 }
      },
    }
    return buildToolContext(
      {
        sessionKey: 'k',
        lane: 'main',
        turn: 1,
        step: 1,
        depth: 0,
        generationDepth: 0,
        actor,
        cwd: '/w/project',
        runtime,
        preset: presetDefaults(),
        children: { create: async () => ({}) as never },
        fsOps: fencedFs(record, fsPolicy),
        netFetch: async () => new Response(''),
        log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
        invoke: async () => ({ content: [] }),
        listTools: () => [],
        appendPlan: async () => 1 as never,
        requestCompaction: () => undefined,
        progress: () => undefined,
        artifactJobEvent: async () => undefined,
        lease: { remainingMs: () => 1000 },
      },
      { toolUseId: 't0', name: 'read', signal: new AbortController().signal, timeoutMs: 1000 },
    )
  }

  it('fills the actual session identity and one-shot default before the runtime reaches artifacts', async () => {
    const seen: unknown[] = []
    const ctx = build(testFsPolicy('/w'), [], {
      artifacts: {
        submitJob: async (spec: unknown) => {
          seen.push(spec)
          return 'job-bound'
        },
      },
    })
    const forged = {
      idempotencyKey: 'fixture',
      sessionKey: 'other-session',
      payload: { kind: 'shell' as const, command: 'printf fixture', cwd: '/w/project' },
    }
    const before = structuredClone(forged)
    await expect(ctx.artifacts.submitJob(forged)).resolves.toBe('job-bound')
    expect(seen).toEqual([{ ...forged, sessionKey: 'k', schedule: { kind: 'once' } }])
    expect(forged).toEqual(before)
    await ctx.artifacts.submitJob({ ...forged, schedule: { kind: 'every', everyMs: 1000 } })
    expect(seen[1]).toEqual({ ...forged, sessionKey: 'k', schedule: { kind: 'every', everyMs: 1000 } })
  })

  // The spellings that used to walk past the kernel's own comparison and then past its workspace
  // fence, because the fence only asked whether the resolved path was inside the root. Nothing here
  // is decided by the kernel any more: it is the file system that refuses, and it refuses all of
  // them because it resolves first.
  const spellings = [
    'secrets/api-key',
    './secrets/api-key',
    'x/../secrets/api-key',
    'secrets/../secrets/api-key',
    '/w/secrets/api-key',
    'secrets',
  ]

  it('refuses every spelling of a denied path, not only the one written in the list', async () => {
    const seen: string[] = []
    const ctx = build(testFsPolicy('/w', { deny: ['secrets'] }), seen)
    for (const p of spellings) {
      await expect(ctx.fs.read(p), p).rejects.toThrow(/E_FS_DENIED/)
      await expect(ctx.fs.list(p), p).rejects.toThrow(/E_FS_DENIED/)
      await expect(ctx.fs.stat(p), p).rejects.toThrow(/E_FS_DENIED/)
      await expect(ctx.fs.write(p, 'x'), p).rejects.toThrow(/E_FS_DENIED/)
    }
    // Not one of them reached the bytes.
    expect(seen).toEqual([])
  })

  it('refuses a path outside the workspace root, and passes an allowed one through untouched', async () => {
    const seen: string[] = []
    const ctx = build(testFsPolicy('/w'), seen)
    for (const p of ['/etc/passwd', '../../etc/passwd', '/workspace-other/x'])
      await expect(ctx.fs.read(p), p).rejects.toThrow(/E_FS_DENIED/)
    await ctx.fs.read('notes.md')
    await ctx.fs.read('/w/other/notes.md')
    expect(seen).toEqual(['/w/notes.md', '/w/other/notes.md'])
  })

  // A write snapshots the old bytes before it happens. Asking the file system about the path first
  // keeps the checkpoint seam from being handed a path the write is about to be refused for.
  it('does not snapshot a denied path before refusing the write', async () => {
    const seen: string[] = []
    const snapshots: string[][] = []
    const policy: FsPolicy = testFsPolicy('/w', { deny: ['secrets'] })
    const ctx = build(policy, seen, {
      checkpoint: {
        snapshot: async (paths: string[]) => {
          snapshots.push(paths)
          return { id: 'cp' }
        },
      },
    })
    await expect(ctx.fs.write('./secrets/api-key', 'x')).rejects.toThrow(/E_FS_DENIED/)
    expect(snapshots).toEqual([])
    await ctx.fs.write('notes.md', 'x')
    expect(snapshots).toEqual([['notes.md']])
  })
})
