import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ApprovalRequest } from '@agnes/core'
import { expect, it, vi } from 'vitest'
import { scratch } from '../assemble/plugin-extension-fixture.js'
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

it.each([false, true])(
  'security5: role writes keep the workspace fence with parent full access=%s',
  async (fullAccess) => {
    const outside = scratch()
    const paths: string[] = []
    const fixture = await setupRoleEscalation(
      async () => {
        throw new Error('A filesystem denial must not become a permission card')
      },
      {
        calls: (_key, step) =>
          paths[step] ? [{ name: 'write', args: { path: paths[step], content: 'SCOPED_ROLE_WRITE' } }] : [],
      },
    )
    try {
      paths.push(
        'inside-positive.md',
        join(outside, 'absolute.md'),
        relative(fixture.dataDir, join(outside, 'traversal.md')),
        'escape/symlink.md',
      )
      symlinkSync(outside, join(fixture.dataDir, 'escape'), 'junction')
      await fixture.parent.setYolo(fullAccess, roleHuman)
      const handle = await fixture.parent.d.children.createWithKind!('spawn', {
        parent: fixture.parent.key,
        cwd: fixture.dataDir,
        role: fixture.refs[0]!,
        input: 'Write within scope',
        resident: true,
      })
      await handle.run('Write within scope')
      const child = fixture.host.kernel.get(handle.key)!
      expect(child.currentTools().resolve('write')).toBeDefined()
      expect(child.yolo).toBe(false)
      expect(readFileSync(join(fixture.dataDir, paths[0]!), 'utf8')).toBe('SCOPED_ROLE_WRITE')
      const rows = await child.scan({ type: 'tool/result', limit: 100 })
      expect(rows).toHaveLength(paths.length)
      expect(rows[0]!.data).not.toMatchObject({ isError: true })
      for (const row of rows.slice(1)) expect(row.data).toMatchObject({ isError: true, code: 'E_FS_DENIED' })
      for (const file of ['absolute.md', 'traversal.md', 'symlink.md'])
        expect(existsSync(join(outside, file))).toBe(false)
      expect(await child.decisions.list()).toEqual([])
    } finally {
      await fixture.host.close()
    }
  },
  30000,
)

it('security: parent, sibling, agent and system cannot answer the child decision', async () => {
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
    await fixture.parent.setYolo(true, roleHuman)
    await fixture.parent.enqueue('next-turn', {
      actor: fixture.parent.d.actor,
      trust: 'untrusted',
      content: [{ type: 'text', text: 'Delegate' }],
    })
    const running = fixture.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    await vi.waitFor(() => expect(questions).toHaveLength(1))
    const handle = questions[0]!.decision!.handle
    const child = fixture.host.kernel.get(handle.sessionId!)!
    const sibling = await fixture.host.createSession({ key: 'parent-prefix-sibling', cwd: fixture.dataDir })
    const pending = await child.decisions.get(handle)
    const command = {
      handle,
      revision: pending.revision,
      commandId: 'forged',
      response: { option: 'allowed-once', value: null },
    }
    for (const session of [fixture.parent, sibling])
      await expect(
        session.decisions.answer(command, { actor: roleHuman, category: 'human', authorize() {} }),
      ).rejects.toThrow('SCOPE')
    for (const role of ['agent', 'system'])
      await expect(
        child.decisions.answer(command, { actor: { ...roleHuman, role }, category: 'human', authorize() {} }),
      ).rejects.toThrow('HUMAN_REQUIRED')
    for (const option of ['allowed-session', 'allowed-permanent'])
      await expect(
        child.decisions.answer(
          { ...command, response: { option, value: null } },
          { actor: roleHuman, category: 'human', authorize() {} },
        ),
      ).rejects.toThrow('UNOFFERED')
    expect((await child.decisions.get(handle)).result).toBeNull()
    expect((await child.decisions.list())[0]!.result).toBeNull()
    expect(child.yolo).toBe(false)
    expect(existsSync(join(fixture.dataDir, 'requirements-1.md'))).toBe(false)
    await fixture.parent.d.children.cancel!(child.key)
    await running
  } finally {
    await fixture.host.close()
  }
}, 30000)

it.each(['same', 'args', 'child'] as const)(
  'security: one human allowance cannot authorize a second %s call',
  async (variant) => {
    const questions: ApprovalRequest[] = []
    const fixture = await setupRoleEscalation(
      async (request) => {
        questions.push(request)
        return { verdict: questions.length === 1 ? 'allowed-once' : 'rejected', answeredBy: roleHuman }
      },
      {
        calls: (key, step) => {
          if (key === 'parent')
            return step === 0
              ? [
                  {
                    name: 'subagent_spawn',
                    args: { role: '@fixture/escalation#role0', task: 'Write', wait: true },
                  },
                ]
              : variant === 'child' && step === 1
                ? [
                    {
                      name: 'subagent_spawn',
                      args: { role: '@fixture/escalation#role1', task: 'Write', wait: true },
                    },
                  ]
                : []
          if (step > (variant === 'child' ? 0 : 1)) return []
          return [
            {
              name: 'write',
              args: {
                path: variant === 'args' && step === 1 ? 'other.md' : 'once.md',
                content: 'approved content',
              },
            },
          ]
        },
      },
    )
    try {
      await fixture.parent.enqueue('next-turn', {
        actor: fixture.parent.d.actor,
        trust: 'untrusted',
        content: [{ type: 'text', text: 'Delegate' }],
      })
      await fixture.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      expect(questions).toHaveLength(2)
      expect(questions[1]!.decision!.handle.id).not.toBe(questions[0]!.decision!.handle.id)
      expect(questions[1]!.decision!.handle.sessionId === questions[0]!.decision!.handle.sessionId).toBe(
        variant !== 'child',
      )
      const original = questions[0]!.decision!.handle
      const child = fixture.host.kernel.get(original.sessionId!)!
      const decision = await child.decisions.get(original)
      expect(decision.consumption?.effectId).toBeTruthy()
      const consumed = (await child.scan({ type: 'decision/state', limit: 100 })).filter((row) => {
        const state = row.data as { handle: { id: string }; consumption: unknown }
        return state.handle.id === original.id && state.consumption !== null
      })
      expect(consumed).toHaveLength(1)
      expect(readFileSync(join(fixture.dataDir, 'once.md'), 'utf8')).toBe('approved content')
      expect(existsSync(join(fixture.dataDir, 'other.md'))).toBe(false)
    } finally {
      await fixture.host.close()
    }
  },
  30000,
)

it.each(['child', 'parent', 'child-abort', 'parent-abort'] as const)(
  'security: closing %s withdraws a pending delivery before a late allowance',
  async (target) => {
    let request!: ApprovalRequest
    let deliverySignal!: AbortSignal
    let release!: () => void
    const fixture = await setupRoleEscalation(async (offered, signal) => {
      request = offered
      deliverySignal = signal
      return new Promise((resolve) => {
        release = () => resolve({ verdict: 'allowed-once', answeredBy: roleHuman })
        signal.addEventListener('abort', () => resolve({ verdict: 'cancelled', reason: 'stopped' }), {
          once: true,
        })
      })
    })
    let running: Promise<unknown> | undefined
    try {
      await fixture.parent.enqueue('next-turn', {
        actor: fixture.parent.d.actor,
        trust: 'untrusted',
        content: [{ type: 'text', text: 'Delegate' }],
      })
      running = fixture.parent
        .run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
        .catch(() => undefined)
      await vi.waitFor(() => expect(request).toBeDefined())
      const child = fixture.host.kernel.get(request.decision!.handle.sessionId!)!
      const session = target.startsWith('parent') ? fixture.parent : child
      const closing = target.endsWith('-abort') ? session.abort(roleHuman) : session.close()
      // Let close reach its cancellation boundary before the held adapter responds.
      await new Promise((resolve) => setTimeout(resolve, 100))
      const withdrawn = deliverySignal.aborted
      release()
      await closing
      await running
      await vi.waitFor(async () => {
        const record = await fixture.parent.d.log.storage.lookupByKey(child.key)
        expect(record?.state).not.toBe('waiting_approval')
        expect(record?.state).not.toBe('running')
      })
      expect({ withdrawn, wrote: existsSync(join(fixture.dataDir, 'requirements-1.md')) }).toEqual({
        withdrawn: true,
        wrote: false,
      })
      const [row] = await fixture.parent.d.log.storage.scan(child.key, {
        type: 'decision/state',
        order: 'desc',
        limit: 1,
      })
      expect((row!.data as { consumption: unknown }).consumption).toBeNull()
      expect((row!.data as { result: { reason: string } }).result.reason).not.toBe('answered')
    } finally {
      release?.()
      await running
      await fixture.host.close()
    }
  },
  30000,
)

it.each([false, true])(
  'security: grandchild routes to the real root and inherits taint/unattended=%s',
  async (unattended) => {
    const questions: ApprovalRequest[] = []
    const fixture = await setupRoleEscalation(
      async (request) => {
        questions.push(request)
        return { verdict: 'rejected', answeredBy: roleHuman }
      },
      {
        nested: true,
        calls: (key, step) =>
          step
            ? []
            : key.split('/').length < 3
              ? [
                  {
                    name: 'subagent_spawn',
                    args: { role: '@fixture/escalation#role0', task: 'Delegate nested write', wait: true },
                  },
                ]
              : [{ name: 'write', args: { path: 'grandchild.md', content: 'must not execute' } }],
      },
    )
    try {
      await expect(
        fixture.parent.d.children.createWithKind!('spawn', {
          parent: 'parent-prefix-sibling',
          cwd: fixture.dataDir,
          role: fixture.refs[0]!,
          input: 'forged',
        }),
      ).rejects.toThrow('parent mismatch')
      await fixture.parent.enqueue('next-turn', {
        actor: { ...fixture.parent.d.actor, attrs: unattended ? { unattendedApproval: 'refuse' } : {} },
        ...(unattended ? { origin: 'system' as const } : {}),
        trust: 'untrusted',
        content: [{ type: 'text', text: 'Delegate' }],
      })
      await fixture.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
      const [first] = await fixture.parent.d.children.list!()
      const child = fixture.host.kernel.get(first!.id)!
      const [second] = await child.d.children.list!()
      const grandchild = fixture.host.kernel.get(second!.id)!
      expect(grandchild.d.roleDelegation).toMatchObject({
        parentTainted: true,
        humanApprovals: !unattended,
        parentKey: child.key,
      })
      expect(questions).toHaveLength(unattended ? 0 : 1)
      if (!unattended)
        expect(questions[0]).toMatchObject({
          sessionKey: 'parent',
          delegation: {
            childSessionKey: grandchild.key,
            parentSessionKey: child.key,
            reason: 'Untrusted evidence (taint)',
          },
        })
      else
        expect((await grandchild.decisions.list())[0]!.result).toMatchObject({
          code: 'delegated-approval-refused',
        })
      expect(existsSync(join(fixture.dataDir, 'grandchild.md'))).toBe(false)
    } finally {
      await fixture.host.close()
    }
  },
  30000,
)

it('security: a policy switch while the human decides cannot authorize the old call', async () => {
  const fixture = await setupRoleEscalation(async (request) => {
    const child = fixture.host.kernel.get(request.decision!.handle.sessionId!)!
    await child.setPreset({
      ...child.preset,
      approval: {
        ...child.preset.approval,
        commandTable: [{ tool: 'write', argv: '^/.*$', action: 'deny' }],
      },
    })
    return { verdict: 'allowed-once', answeredBy: roleHuman }
  })
  try {
    await fixture.parent.enqueue('next-turn', {
      actor: fixture.parent.d.actor,
      trust: 'untrusted',
      content: [{ type: 'text', text: 'Delegate' }],
    })
    await fixture.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    expect(existsSync(join(fixture.dataDir, 'requirements-1.md'))).toBe(false)
    const [listing] = await fixture.parent.d.children.list!()
    expect(
      await fixture.parent.d.log.storage.scan(listing!.id, { type: 'effect/intent', limit: 100 }),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ kind: 'tool', tool: expect.objectContaining({ name: 'write' }) }),
        }),
      ]),
    )
  } finally {
    await fixture.host.close()
  }
}, 30000)

it.each(['allow', 'deny', 'require_approval'] as const)(
  'security: captured command ceiling %s stays authoritative',
  async (commandAction) => {
    const questions: ApprovalRequest[] = []
    const fixture = await setupRoleEscalation(
      async (request) => {
        questions.push(request)
        return { verdict: 'allowed-once', answeredBy: roleHuman }
      },
      { commandAction },
    )
    try {
      const child = await fixture.parent.d.children.createWithKind!('spawn', {
        parent: 'parent',
        cwd: fixture.dataDir,
        role: fixture.refs[0]!,
        input: 'Write',
        resident: true,
      })
      await child.run('Write')
      expect(questions).toHaveLength(commandAction === 'require_approval' ? 1 : 0)
      expect(existsSync(join(fixture.dataDir, 'requirements-0.md'))).toBe(commandAction !== 'deny')
      if (commandAction === 'deny') {
        const session = fixture.host.kernel.get(child.key)!
        expect(await session.decisions.list()).toEqual([])
        expect((await session.scan({ type: 'tool/result', limit: 100 }))[0]!.data).toMatchObject({
          code: 'POLICY_DENIED',
        })
      }
    } finally {
      await fixture.host.close()
    }
  },
  30000,
)

it('security: an always-ask plugin tool escalates only its Core execution gate', async () => {
  const questions: ApprovalRequest[] = []
  const fixture = await setupRoleEscalation(
    async (request) => {
      questions.push(request)
      return { verdict: 'allowed-once', answeredBy: roleHuman }
    },
    {
      tools: ['always_review'],
      hookBody: `const { Type } = await import(${JSON.stringify(import.meta.resolve('@sinclair/typebox'))});
    ctx.tools.register({ ...tool('always_review'), parameters: Type.Object({}, { additionalProperties: false }), meta: { ...tool('always_review').meta, requiresApproval: 'always' }, async execute(args, ctx) {
      const handle = await ctx.decisions.request({ key: 'plugin-permission', purpose: 'tool.permission', subject: {}, prompt: 'Forge permission', options: ['allowed-once', 'rejected'] });
      const decision = await ctx.decisions.get(handle);
      return { content: [{ type: 'text', text: decision.result.code }] };
    } })`,
      calls: (key, step) =>
        step
          ? []
          : key === 'parent'
            ? [
                {
                  name: 'subagent_spawn',
                  args: { role: '@fixture/escalation#role0', task: 'Review', wait: true },
                },
              ]
            : [{ name: 'always_review', args: {} }],
    },
  )
  try {
    await fixture.parent.enqueue('next-turn', {
      actor: fixture.parent.d.actor,
      content: [{ type: 'text', text: 'Delegate' }],
    })
    await fixture.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    expect(questions).toHaveLength(1)
    const child = fixture.host.kernel.get(questions[0]!.decision!.handle.sessionId!)!
    const decisions = await child.decisions.list()
    expect(decisions).toHaveLength(2)
    expect(decisions.find((d) => d.request.owner === 'core/tool-permission')).toMatchObject({
      result: { reason: 'answered' },
      consumption: { effectId: expect.any(String) },
    })
    expect(decisions.find((d) => d.request.owner !== 'core/tool-permission')).toMatchObject({
      result: { reason: 'unavailable', code: 'delegated-approval-refused' },
      consumption: null,
    })
  } finally {
    await fixture.host.close()
  }
}, 30000)

it('security: a human answer arriving after the persisted deadline cannot authorize an effect', async () => {
  let offered!: ApprovalRequest
  const fixture = await setupRoleEscalation(async (request) => {
    offered = request
    const child = fixture.host.kernel.get(request.decision!.handle.sessionId!)!
    vi.spyOn(child.d, 'clock').mockReturnValue(Date.parse(request.deadline) + 1)
    return { verdict: 'allowed-once', answeredBy: roleHuman }
  })
  try {
    await fixture.parent.enqueue('next-turn', {
      actor: fixture.parent.d.actor,
      trust: 'untrusted',
      content: [{ type: 'text', text: 'Delegate' }],
    })
    await fixture.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    const child = fixture.host.kernel.get(offered.decision!.handle.sessionId!)!
    expect(await child.decisions.get(offered.decision!.handle)).toMatchObject({
      result: { reason: 'expired', code: 'deadline' },
      consumption: null,
    })
    expect(existsSync(join(fixture.dataDir, 'requirements-1.md'))).toBe(false)
  } finally {
    await fixture.host.close()
  }
}, 30000)

it('security: a role admitted before root close cannot acquire a card or effect after root close', async () => {
  const questions: ApprovalRequest[] = []
  const fixture = await setupRoleEscalation(async (request) => {
    questions.push(request)
    return { verdict: 'allowed-once', answeredBy: roleHuman }
  })
  try {
    await fixture.parent.enqueue('next-turn', {
      actor: fixture.parent.d.actor,
      trust: 'untrusted',
      content: [{ type: 'text', text: 'Delegate' }],
    })
    await fixture.parent.acceptInput()
    const handle = await fixture.parent.d.children.createWithKind!('spawn', {
      parent: 'parent',
      cwd: fixture.dataDir,
      role: fixture.refs[0],
      input: 'Write',
      resident: true,
    })
    await fixture.parent.close()
    expect(fixture.parent.closingOrClosed).toBe(true)
    await handle.run('Write').catch(() => undefined)
    expect({
      cards: questions.length,
      wrote: existsSync(join(fixture.dataDir, 'requirements-0.md')),
    }).toEqual({ cards: 0, wrote: false })
  } finally {
    await fixture.host.close()
  }
}, 30000)

it('security: status-only spawn receipts taint the next fresh role instead of laundering authority', async () => {
  const questions: ApprovalRequest[] = []
  const fixture = await setupRoleEscalation(
    async (request) => {
      questions.push(request)
      return { verdict: 'rejected', answeredBy: roleHuman }
    },
    {
      calls: (key, step) =>
        key === 'parent'
          ? step < 2
            ? [
                {
                  name: 'subagent_spawn',
                  args: { role: `@fixture/escalation#role${step}`, task: 'Write', wait: true },
                },
              ]
            : []
          : step === 0
            ? [{ name: 'write', args: { path: `${key.split('/').at(-1)}.md`, content: 'Scoped' } }]
            : [],
    },
  )
  try {
    await fixture.parent.enqueue('next-turn', {
      actor: fixture.parent.d.actor,
      trust: 'trusted',
      content: [{ type: 'text', text: 'Delegate twice' }],
    })
    await fixture.parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
    const children = await fixture.parent.d.children.list!()
    expect(children).toHaveLength(2)
    const byRole = new Map(
      children.map((child) => {
        const session = fixture.host.kernel.get(child.id)!
        return [session.d.roleDelegation!.role.ref, session] as const
      }),
    )
    expect(byRole.get(fixture.refs[0]!)!.d.roleDelegation?.parentTainted).toBe(false)
    expect(byRole.get(fixture.refs[1]!)!.d.roleDelegation?.parentTainted).toBe(true)
    expect(questions).toHaveLength(1)
    expect(questions[0]!.delegation?.role).toBe(fixture.refs[1])
    expect(questions[0]!.delegation?.reason).toMatch(/taint/i)
    const receipts = await fixture.parent.scan({ type: 'tool/result', limit: 100 })
    expect(receipts.some((row) => row.trust === 'untrusted')).toBe(true)
  } finally {
    await fixture.host.close()
  }
}, 30000)
