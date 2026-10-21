import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalRequest } from '@agnes/core'
import { expect, it, vi } from 'vitest'
import { roleHuman, setupRoleEscalation } from './role-escalation-fixture.js'

it.each(['allow', 'deny', 'agent', 'system', 'absent', 'deadline'] as const)(
  'tainted role write reaches the parent human surface: %s',
  async (mode) => {
    const questions: ApprovalRequest[] = []
    const fixture = await setupRoleEscalation(async (request) => {
      questions.push(request)
      return mode === 'absent' || mode === 'deadline'
        ? { verdict: 'unavailable', reason: mode === 'deadline' ? 'deadline' : 'no-approver' }
        : {
            verdict: mode === 'deny' ? 'rejected' : 'allowed-once',
            answeredBy: { ...roleHuman, role: mode === 'agent' || mode === 'system' ? mode : 'human' },
          }
    })
    try {
      await fixture.parent.enqueue('next-turn', {
        actor: fixture.parent.d.actor,
        trust: 'untrusted',
        content: [{ type: 'text', text: 'Delegate requirements from untrusted evidence' }],
      })
      await fixture.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      expect(questions).toHaveLength(1)
      expect(questions[0]).toMatchObject({
        sessionKey: 'parent',
        options: ['allowed-once', 'rejected'],
        tool: { name: 'write' },
      })
      const children = await fixture.parent.d.children.list!()
      expect(children).toHaveLength(1)
      const child =
        fixture.host.kernel.get(children[0]!.id) ??
        (await fixture.host.createSession({ key: children[0]!.id, cwd: fixture.dataDir }))
      expect(child.d.roleDelegation?.parentTainted).toBe(true)
      expect(questions[0]!.summary).toContain(fixture.refs[0])
      expect(questions[0]!.summary).toContain(child.key)
      expect(questions[0]!.summary).toMatch(/taint/i)
      expect(questions[0]!.decision?.handle.sessionId).toBe(child.key)
      const decisions = await child.decisions.list()
      expect(decisions).toHaveLength(1)
      expect(decisions[0]!.result).toMatchObject(
        mode === 'allow' || mode === 'deny'
          ? { reason: 'answered', answeredBy: roleHuman }
          : { reason: 'unavailable' },
      )
      if (mode === 'absent' || mode === 'deadline') {
        expect(decisions[0]!.result).toMatchObject({ code: mode === 'deadline' ? 'deadline' : 'no-approver' })
        expect((await child.scan({ type: 'tool/result', limit: 100 }))[0]?.data).toMatchObject({
          code: 'APPROVAL_UNAVAILABLE',
        })
      }
      expect(existsSync(join(fixture.dataDir, 'requirements-1.md'))).toBe(mode === 'allow')
      if (mode === 'allow') expect(decisions[0]!.consumption).not.toBeNull()
    } finally {
      await fixture.host.close()
    }
  },
  30000,
)

it('executes all twelve adopted roles with four concurrent slots', async () => {
  const fixture = await setupRoleEscalation(async () => {
    throw new Error('Already admitted writes must not ask')
  })
  try {
    expect((await fixture.parent.d.children.roles!()).map((role) => role.ref)).toEqual(fixture.refs)
    for (const [index, role] of fixture.refs.entries()) {
      const child = await fixture.parent.d.children.createWithKind!('spawn', {
        parent: fixture.parent.key,
        cwd: fixture.dataDir,
        role,
        input: `Requirements ${index}`,
        resident: true,
      })
      await child.run(`Requirements ${index}`)
      expect(readFileSync(join(fixture.dataDir, `requirements-${index}.md`), 'utf8')).toBe(
        'Child requirements',
      )
      const session = fixture.host.kernel.get(child.key)!
      expect(session.d.roleDelegation?.role.ref).toBe(role)
      const results = await session.scan({ type: 'tool/result', limit: 100 })
      expect(results).toHaveLength(1)
      expect(results[0]?.data).not.toMatchObject({ isError: true })
    }
    const children = await fixture.parent.d.children.list!()
    expect(children).toHaveLength(12)
    expect(children.every((child) => child.status === 'idle' && child.continuable)).toBe(true)
  } finally {
    await fixture.host.close()
  }
}, 60000)

it.each(['cancel', 'close'] as const)(
  'withdraws a blocked role approval on %s',
  async (action) => {
    const questions: ApprovalRequest[] = []
    const fixture = await setupRoleEscalation((request, signal) => {
      questions.push(request)
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve({ verdict: 'cancelled', reason: 'stopped' }), {
          once: true,
        }),
      )
    })
    try {
      await fixture.parent.enqueue('next-turn', {
        actor: fixture.parent.d.actor,
        trust: 'untrusted',
        content: [{ type: 'text', text: 'Delegate' }],
      })
      const running = fixture.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      await vi.waitFor(() => expect(questions).toHaveLength(1))
      const handle = questions[0]!.decision!.handle
      const child = fixture.host.kernel.get(handle.sessionId!)!
      const pending = await child.decisions.get(handle)
      expect(pending.result).toBeNull()
      expect(existsSync(join(fixture.dataDir, 'requirements-1.md'))).toBe(false)
      await expect(
        child.decisions.answer(
          {
            handle,
            revision: pending.revision,
            commandId: 'model-forgery',
            response: { option: 'allowed-once', value: null },
          },
          { actor: { ...roleHuman, role: 'agent' }, category: 'human', authorize() {} },
        ),
      ).rejects.toThrow()
      if (action === 'cancel') await fixture.parent.d.children.cancel!(child.key)
      else await child.close()
      await running
      expect(existsSync(join(fixture.dataDir, 'requirements-1.md'))).toBe(false)
      const states = await fixture.parent.d.log.storage.scan(child.key, {
        type: 'decision/state',
        order: 'desc',
        limit: 1,
      })
      expect(states[0]?.data).toMatchObject({ result: { reason: 'stopped' } })
    } finally {
      await fixture.host.close()
    }
  },
  30000,
)

it('keeps unattended role gates refused even when a human adapter exists', async () => {
  const fixture = await setupRoleEscalation(async () => {
    throw new Error('Unattended work must not ask')
  })
  try {
    await fixture.parent.enqueue('next-turn', {
      actor: { ...fixture.parent.d.actor, attrs: { unattendedApproval: 'refuse' } },
      origin: 'system',
      trust: 'untrusted',
      content: [{ type: 'text', text: 'Delegate unattended requirements' }],
    })
    await fixture.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    const [listing] = await fixture.parent.d.children.list!()
    const child = fixture.host.kernel.get(listing!.id)!
    expect(child.d.roleDelegation?.humanApprovals).toBe(false)
    expect((await child.decisions.list())[0]?.result).toMatchObject({ code: 'delegated-approval-refused' })
    expect(existsSync(join(fixture.dataDir, 'requirements-1.md'))).toBe(false)
  } finally {
    await fixture.host.close()
  }
}, 30000)
