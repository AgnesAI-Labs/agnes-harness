import type { ApprovalGrant } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, ApprovalSeam, SeamImplementations } from '../src/effects/seams.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { ToolRegistry } from '../src/registry/tools.js'
import type { Event } from '../src/types.js'
import { createWorkspaceInvocationPort } from '../src/workspace/runtime.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, shellTool, testFsOps } from './helpers/open-session.js'

const approver = { ...actor, id: 'reviewer' }
type Receipt = NonNullable<Awaited<ReturnType<ApprovalSeam['resume']>>>
async function parked(
  profileHash: string | null = null,
  approvalOver: Partial<SeamImplementations['approval']> = {},
) {
  let now = 1_757_203_200_000
  let request: ApprovalRequest | undefined
  let calls = 0
  const ticket = 'private-ticket'
  const deadline = new Date(now + 1000).toISOString()
  let backend: (receipt: Receipt) => Promise<Receipt | null> = async (r) => r
  const seams = fakeSeams({
    approval: {
      ask: async (req) => {
        request = req
        return { ticket, expiresAt: deadline }
      },
      resume: async () => {
        calls++
        if (!request) throw new Error('missing test request')
        return backend({
          requestId: request.requestId,
          bindingHash: request.bindingHash,
          expiresAt: deadline,
        })
      },
      ...approvalOver,
    },
  })
  const releases = vi.fn()
  const acquires = vi.fn(() => ({
    source: {
      root: '/w',
      fs: testFsOps(),
      ready: async () => ({ confine: async (argv: readonly string[]) => argv }),
      hookSnapshot: async () => ({ workspaceDigest: 'workspace', policyRevision: 'policy', hooks: [] }),
      hookSandbox: {
        enforcement: () => ({ level: 'full' as const, scope: ['process' as const] }),
        exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }),
      },
      approval: seams.approval,
      checkpoint: seams.checkpoint,
    },
    release: releases,
  }))
  const workspaceInvocation = createWorkspaceInvocationPort(acquires)
  const registry = new ToolRegistry()
  registry.add(shellTool(), { source: 'test', trust: 'builtin' })
  const storage = new MemoryStorage({ clock: () => now })
  const { session, log } = await openSession({
    clock: () => now,
    storage,
    registry,
    seams,
    provider: fakeProvider([toolTurn('shell', {}), textTurn('done')]),
    resolvedProfileHash: profileHash,
    workspaceInvocation,
  })
  await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'run' }] })
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'parked',
  )
  return {
    session,
    log,
    storage,
    seams,
    clock: () => now,
    ticket,
    deadline,
    calls: () => calls,
    invocationCounts: () => ({ acquires: acquires.mock.calls.length, releases: releases.mock.calls.length }),
    advance: (ms: number) => {
      now += ms
    },
    backend: (fn: typeof backend) => {
      backend = fn
    },
  }
}
const rows = (h: Awaited<ReturnType<typeof parked>>) =>
  h.log.scan({ type: 'approval/decided', toSeq: h.log.lastSeq })
async function reopenWithAsked(
  h: Awaited<ReturnType<typeof parked>>,
  rewrite: (data: Record<string, unknown>) => void,
  writerRunId: string,
) {
  const events = await h.log.scan({ fromSeq: 1, toSeq: h.log.lastSeq })
  const rewritten: Event[] = events.map((row) => {
    if (row.type !== 'approval/asked') return row
    const data = { ...(row.data as Record<string, unknown>) }
    rewrite(data)
    return { ...row, data: data as Event['data'] }
  })
  const reopened = await openSession({
    storage: MemoryStorage.fromEvents('k', rewritten),
    key: 'k',
    writerRunId,
    seams: h.seams,
    clock: h.clock,
    provider: fakeProvider([textTurn('unused')]),
  })
  return { ...h, ...reopened }
}

describe('parked approval callbacks', () => {
  it('releases one workspace lease for park and one for callback resume', async () => {
    const h = await parked()
    expect(h.invocationCounts()).toEqual({ acquires: 1, releases: 1 })
    await h.session.resumeApproval(h.ticket, 'rejected', approver)
    expect(h.invocationCounts()).toEqual({ acquires: 2, releases: 2 })
  })

  it('accepts only a verdict offered by the persisted request', async () => {
    const h = await parked()
    await expect(h.session.resumeApproval(h.ticket, 'allowed-permanent', approver)).rejects.toThrow(
      'approval verdict was not offered',
    )
    expect(h.calls()).toBe(0)
    expect(await rows(h)).toEqual([])
  })

  it('accepts permanent only for a tool request that explicitly offered it', async () => {
    const h = await parked(`sha256-${'a'.repeat(64)}`)
    await expect(h.session.resumeApproval(h.ticket, 'allowed-permanent', approver)).resolves.toEqual({
      seq: expect.any(Number),
    })
    expect(h.calls()).toBe(1)
    expect((await rows(h))[0]?.data).toMatchObject({
      verdict: 'allowed-permanent',
      scope: 'tool:shell:execute',
      grantId: expect.stringMatching(/^grant-[a-f0-9]{64}$/),
    })
  })

  it('activates a callback permanent grant only after its continuation is durably consumed', async () => {
    const grants: ApprovalGrant[] = []
    const h = await parked(`sha256-${'a'.repeat(64)}`, {
      listGrants: async () => grants,
      putGrant: async (grant) => {
        grants.push(grant)
      },
    })
    await h.session.resumeApproval(h.ticket, 'allowed-permanent', approver)
    expect(grants).toEqual([])
    expect(await h.session.step()).toEqual({ phase: 'tools' })
    await h.session.runToolsPhase()
    expect(grants).toEqual([
      expect.objectContaining({
        grantId: expect.stringMatching(/^grant-[a-f0-9]{64}$/),
        profileHash: `sha256-${'a'.repeat(64)}`,
        actorId: actor.id,
        actorOrg: actor.org,
        toolId: 'shell',
        scope: 'tool:shell:execute',
      }),
    ])
    expect(await h.log.scan({ type: 'x/core/approval-grant-activated', limit: 10 })).toHaveLength(1)
    expect((await h.log.scan({ type: 'tool/result', limit: 10 }))[0]?.data).toMatchObject({
      isError: false,
    })
  })

  it('limits legacy requests without options to historical verdicts', async () => {
    const accepted = await reopenWithAsked(
      await parked(),
      (asked) => {
        delete asked.options
      },
      'legacy-accepted',
    )
    await expect(
      accepted.session.resumeApproval(accepted.ticket, 'allowed-session', approver),
    ).resolves.toEqual({
      seq: expect.any(Number),
    })

    const rejected = await reopenWithAsked(
      await parked(`sha256-${'a'.repeat(64)}`),
      (asked) => {
        delete asked.options
      },
      'legacy-rejected',
    )
    await expect(
      rejected.session.resumeApproval(rejected.ticket, 'allowed-permanent', approver),
    ).rejects.toThrow('approval verdict was not offered')
    expect(rejected.calls()).toBe(0)
  })

  it('rejects permanent for a non-tool request even if a malformed request offered it', async () => {
    const h = await reopenWithAsked(
      await parked(`sha256-${'a'.repeat(64)}`),
      (asked) => {
        asked.kind = 'budget'
        asked.options = ['allowed-permanent']
      },
      'non-tool-permanent',
    )
    await expect(h.session.resumeApproval(h.ticket, 'allowed-permanent', approver)).rejects.toThrow(
      'permanent approval is only valid for tool requests',
    )
    expect(h.calls()).toBe(0)
  })

  it('records the validated callback exactly once without pretending continuation is implemented', async () => {
    const h = await parked()
    const out = await h.session.resumeApproval(h.ticket, 'allowed-once', approver)
    expect((await rows(h))[0]).toMatchObject({
      seq: out.seq,
      actor: approver,
      data: { verdict: 'allowed-once', via: 'callback', decidedBy: approver },
    })
    expect(h.session.state.pendingApprovals.size).toBe(0)
    expect(h.session.op()).toBeNull()
    await expect(h.session.resumeApproval(h.ticket, 'allowed-once', approver)).rejects.toThrow(
      'ticket unavailable',
    )
    expect(h.calls()).toBe(1)
  })

  it('opens a decided continuation before a queued next-turn prompt without consuming that prompt', async () => {
    const h = await parked()
    await h.session.resumeApproval(h.ticket, 'allowed-once', approver)
    await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'later prompt' }] })

    expect(await h.session.step()).toEqual({ phase: 'tools' })
    const starts = await h.log.scan({ type: 'turn/start', order: 'desc', limit: 1, lane: 'main' })
    expect(starts[0]?.data).toMatchObject({
      trigger: 'approval-resume',
      continues: { requestId: expect.any(String), toolUseId: expect.any(String) },
    })
    expect(h.session.latest('inbox')).toMatchObject({
      items: [
        expect.objectContaining({ target: 'next-turn', content: [{ type: 'text', text: 'later prompt' }] }),
      ],
    })
  })
  it('validates a pending ticket reconstructed from the ledger after reopening', async () => {
    const h = await parked()
    await h.session.close()
    const reopened = await openSession({
      storage: h.storage,
      seams: h.seams,
      clock: h.clock,
      provider: fakeProvider([textTurn('unused')]),
    })
    try {
      expect(reopened.session.state.pendingApprovals.size).toBe(1)
      await reopened.session.resumeApproval(h.ticket, 'allowed-once', approver)
      expect(reopened.session.state.pendingApprovals.size).toBe(0)
      expect(
        (await reopened.log.scan({ type: 'approval/decided', toSeq: reopened.log.lastSeq }))[0]?.data,
      ).toMatchObject({ via: 'callback', verdict: 'allowed-once' })
    } finally {
      await reopened.session.close()
    }
  })

  it('rejects self approval before consuming a backend ticket', async () => {
    const h = await parked()
    await expect(h.session.resumeApproval(h.ticket, 'allowed-once', actor)).rejects.toThrow('self-approval')
    expect(h.calls()).toBe(0)
    expect(await rows(h)).toEqual([])
  })
  it('rejects a missing ticket without calling the backend', async () => {
    const h = await parked()
    await expect(h.session.resumeApproval('missing', 'allowed-once', approver)).rejects.toThrow(
      'ticket unavailable',
    )
    expect(h.calls()).toBe(0)
  })
  it('expires at the stored deadline, with the default rejection and no duplicate expiry', async () => {
    const h = await parked()
    expect(await h.session.expireApprovals()).toBe(0)
    h.advance(1000)
    await expect(h.session.resumeApproval(h.ticket, 'allowed-once', approver)).rejects.toThrow(
      'ticket expired',
    )
    expect(h.calls()).toBe(0)
    expect(await h.session.expireApprovals()).toBe(1)
    expect(await h.session.expireApprovals()).toBe(0)
    expect((await rows(h))[0]?.data).toMatchObject({ verdict: 'rejected', via: 'timeout' })
  })
  it.each(['request', 'binding', 'expiry', 'invalid-date', 'missing'] as const)(
    'rejects backend %s mismatch',
    async (mode) => {
      const h = await parked()
      h.backend(async (r) =>
        mode === 'missing'
          ? null
          : {
              ...r,
              ...(mode === 'request' ? { requestId: 'other' } : {}),
              ...(mode === 'binding' ? { bindingHash: '0'.repeat(64) } : {}),
              ...(mode === 'expiry'
                ? { expiresAt: new Date(Date.parse(r.expiresAt) + 1000).toISOString() }
                : {}),
              ...(mode === 'invalid-date' ? { expiresAt: 'invalid' } : {}),
            },
      )
      await expect(h.session.resumeApproval(h.ticket, 'allowed-once', approver)).rejects.toThrow()
      expect(await rows(h)).toEqual([])
      expect(h.session.state.pendingApprovals.size).toBe(1)
    },
  )
  it.each(['other-lane', 'duplicate-ticket'] as const)(
    'refuses %s before backend consumption',
    async (mode) => {
      const h = await parked()
      const original = [...h.session.state.pendingApprovals.values()][0]
      if (!original?.pending) throw new Error('missing approval')
      const { seq: _seq, lane: _lane, ...data } = original
      const ticket = mode === 'other-lane' ? 'other-ticket' : h.ticket
      await h.log.append([
        h.session.ev(
          'approval/asked',
          { ...data, requestId: 'other-request', pending: { ...original.pending, ticket } },
          { lane: 'other' },
        ),
      ])
      await expect(h.session.resumeApproval(ticket, 'allowed-once', approver)).rejects.toThrow(
        'ticket unavailable',
      )
      expect(h.calls()).toBe(0)
      expect(await rows(h)).toEqual([])
    },
  )

  it('contains backend failure without leaking its message and permits a later retry', async () => {
    const h = await parked()
    h.backend(async () => {
      throw new Error('private-backend-token')
    })
    await expect(h.session.resumeApproval(h.ticket, 'allowed-once', approver)).rejects.toThrow(
      'approval backend unavailable',
    )
    const diagnostics = await h.log.scan({ type: 'x/core/approval-callback-rejected', toSeq: h.log.lastSeq })
    expect(JSON.stringify(diagnostics)).not.toContain(h.ticket)
    expect(JSON.stringify(diagnostics)).not.toContain('private-backend-token')
    h.backend(async (r) => r)
    await h.session.resumeApproval(h.ticket, 'rejected', approver)
    expect(await rows(h)).toHaveLength(1)
  })
  it('bounds an unavailable backend using the default timeout and permits retry', async () => {
    const h = await parked()
    vi.useFakeTimers()
    try {
      h.backend(() => new Promise(() => {}))
      const pending = h.session.resumeApproval(h.ticket, 'allowed-once', approver)
      const rejected = expect(pending).rejects.toThrow('approval backend unavailable')
      await vi.advanceTimersByTimeAsync(60_000)
      await rejected
      expect(await rows(h)).toEqual([])
      h.backend(async (r) => r)
      await h.session.resumeApproval(h.ticket, 'rejected', approver)
      expect(await rows(h)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not invoke accessors in a backend receipt', async () => {
    const h = await parked()
    let reads = 0
    h.backend(async (r) =>
      Object.defineProperty({ ...r }, 'bindingHash', {
        get() {
          reads++
          throw new Error('private')
        },
      }),
    )
    await expect(h.session.resumeApproval(h.ticket, 'allowed-once', approver)).rejects.toThrow(
      'approval binding mismatch',
    )
    expect(reads).toBe(0)
    expect(await rows(h)).toEqual([])
  })

  it('serializes simultaneous callbacks so only one reaches the backend and ledger', async () => {
    const h = await parked()
    const results = await Promise.allSettled([
      h.session.resumeApproval(h.ticket, 'allowed-once', approver),
      h.session.resumeApproval(h.ticket, 'rejected', approver),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
    expect(h.calls()).toBe(1)
    expect(await rows(h)).toHaveLength(1)
  })
  it('rechecks expiry after the backend await and lets queued expiry reject once', async () => {
    const h = await parked()
    h.backend(async (r) => {
      h.advance(1000)
      return r
    })
    const callback = h.session.resumeApproval(h.ticket, 'allowed-once', approver)
    const expiry = h.session.expireApprovals()
    await expect(callback).rejects.toThrow('ticket expired')
    expect(await expiry).toBe(1)
    expect(await rows(h)).toHaveLength(1)
  })
})

describe('a callback on a session whose writer lost its lease', () => {
  it('fails before the approval backend is asked, leaving the ticket unspent', async () => {
    const h = await parked()
    await h.storage.release('k', 'r1')
    await h.storage.open('k', { writerRunId: 'someone-else', ttlMs: 60_000 })
    await expect(h.session.resumeApproval(h.ticket, 'allowed-once', approver)).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    expect(h.calls()).toBe(0)
    expect(h.log.faulted).toBe(true)
  })
})
