import type { FsOps, FsPolicy } from '@agnes/core'
import type { SkillRuntimeInput } from '@agnes/resource-control-runtime'
import { describe, expect, it } from 'vitest'
import { bindSkillRuntimeToWorkspace, createSkillPromptPreloader } from '../src/resources/skill-preload.js'
import { SandboxReadinessManager } from '../src/sandbox-readiness-manager.js'
import {
  createSessionWorkspaceRuntime,
  SessionWorkspaceRuntimeTable,
} from '../src/session-workspace-runtime.js'
import { WorkspaceBindingAuthority } from '../src/workspace-authority.js'

const fs: FsOps = {
  read: async () => new Uint8Array(),
  write: async () => undefined,
  list: async () => [],
  stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
}
const policy = (root = '/work'): FsPolicy => ({
  workspaceRoot: root,
  rules: [{ effect: 'allow', path: root, source: 'workspace', hard: false }],
  networkAllow: [],
  digest: 'a'.repeat(64),
})
const binding = (sessionKey: string) =>
  new WorkspaceBindingAuthority().accept(
    {
      version: 1,
      sessionKey,
      workspaceId: 'b'.repeat(64),
      revision: 1,
      canonicalRoot: '/work',
    },
    sessionKey,
  )

async function runtime(
  sessionKey: string,
  events: string[] = [],
  options: Readonly<{
    fs?: FsOps
    confine?: (request: Readonly<{ argv: readonly string[]; cwd: string }>) => Promise<readonly string[]>
    hooks?: unknown
    services?: unknown
  }> = {},
) {
  let digest: string | null = null
  const readiness = new SandboxReadinessManager(async () => ({
    confine: options.confine ?? (({ argv }) => argv),
    close: () => {
      events.push('backend')
    },
  }))
  const value = await createSessionWorkspaceRuntime({
    binding: binding(sessionKey),
    openWorkspace: async () => ({
      kind: 'local',
      root: '/work',
      close: () => {
        events.push('workspace')
      },
    }),
    openFence: async () => ({
      root: '/work',
      fs: options.fs ?? fs,
      bind: (next) => {
        digest = next.digest
      },
      policyDigest: () => digest,
      close: () => {
        events.push('fence')
      },
    }),
    compilePolicy: async () => ({
      policy: policy(),
      staticConfig: {
        level: 'L1',
        required: true,
        onUnavailable: 'deny',
        extraPaths: [],
        denyPaths: [],
        networkAllow: [],
      },
      staticConfigHash: 'c'.repeat(64),
      semantics: { flavor: 'posix', caseSensitive: true },
      backendOptions: { cwd: '/work', allowPaths: ['/work'], denyPaths: [], networkAllow: [] },
    }),
    bindReadiness: () =>
      readiness.bind({
        backendId: 'test',
        canonicalRoot: '/work',
        staticConfigHash: 'c'.repeat(64),
        caseSensitive: true,
      }),
    openHooks: async () => {
      events.push('hooks-open')
      return options.hooks ?? 'hooks'
    },
    closeHooks: () => {
      events.push('hooks')
    },
    openServices: async () => {
      events.push('services-open')
      return options.services ?? 'services'
    },
    closeServices: () => {
      events.push('services')
    },
  })
  return { value, readiness }
}

describe('createSessionWorkspaceRuntime', () => {
  it('constructs in the fixed order and closes session resources in reverse order', async () => {
    const events: string[] = []
    const built = await runtime('session-a', events)
    const table = new SessionWorkspaceRuntimeTable()
    let suppliedPort: ReturnType<typeof table.invocation> | undefined
    const opened = await table.open(built.value.binding, async (invocation) => {
      suppliedPort = invocation
      return built.value
    })
    expect(opened.invocation).toBe(suppliedPort)
    expect(opened.invocation).toBe(table.invocation('session-a'))
    expect(events).toEqual(['hooks-open', 'services-open'])
    await table.close('session-a')
    expect(events).toEqual(['hooks-open', 'services-open', 'services', 'hooks', 'fence', 'workspace'])
    await built.readiness.revoke()
    expect(events).toContain('backend')
  })

  it('rolls back already-created resources when a later stage fails', async () => {
    const events: string[] = []
    let digest: string | null = null
    const manager = new SandboxReadinessManager(async () => ({ confine: ({ argv }) => argv }))
    await expect(
      createSessionWorkspaceRuntime({
        binding: binding('session-a'),
        openWorkspace: async () => ({
          kind: 'local',
          root: '/work',
          close: () => {
            events.push('workspace')
          },
        }),
        openFence: async () => ({
          root: '/work',
          fs,
          bind: (next) => {
            digest = next.digest
          },
          policyDigest: () => digest,
          close: () => {
            events.push('fence')
          },
        }),
        compilePolicy: async () => ({
          policy: policy(),
          staticConfig: {
            level: 'L0',
            required: false,
            onUnavailable: 'deny',
            extraPaths: [],
            denyPaths: [],
            networkAllow: [],
          },
          staticConfigHash: 'c'.repeat(64),
          semantics: { flavor: 'posix', caseSensitive: true },
          backendOptions: { cwd: '/work', allowPaths: ['/work'], denyPaths: [], networkAllow: [] },
        }),
        bindReadiness: () =>
          manager.bind({
            backendId: 'test',
            canonicalRoot: '/work',
            staticConfigHash: 'c'.repeat(64),
            caseSensitive: true,
          }),
        openHooks: async () => {
          throw new Error('hooks failed')
        },
      }),
    ).rejects.toThrow('hooks failed')
    expect(events).toEqual(['fence', 'workspace'])
    await manager.revoke()
  })
})

describe('workspace resource consumers', () => {
  it('keeps an in-flight Skill call on A leased while B continues independently', async () => {
    const eventsA: string[] = []
    const eventsB: string[] = []
    const builtA = await runtime('session-a', eventsA)
    const builtB = await runtime('session-b', eventsB)
    const table = new SessionWorkspaceRuntimeTable()
    await table.open(builtA.value.binding, async () => builtA.value)
    await table.open(builtB.value.binding, async () => builtB.value)
    const resources: SkillRuntimeInput = {
      list: () => [
        {
          kind: 'skill',
          resourceId: 'skill:review',
          name: 'review',
          description: 'review',
          revision: 'a'.repeat(64),
          sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 'source' },
          priority: 1,
          resolution: { winner: true, shadowed: [] },
          trust: 'trusted',
          desired: 'enabled',
          actual: 'ready',
          stale: false,
        },
      ],
      read: (_id, session) => ({ ok: true, content: `loaded:${session.sessionKey}` }),
      readFile: () => ({ ok: false, code: 'NOT_FOUND' }),
    }
    const resolve = (key: string) => table.invocation(key)
    const bound = bindSkillRuntimeToWorkspace(resources, resolve)
    const preload = createSkillPromptPreloader(resources, resolve)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolveStarted) => {
      entered = resolveStarted
    })
    const held = new Promise<void>((resolveHeld) => {
      release = resolveHeld
    })
    const activeA = bound.runInWorkspace('session-a', async () => {
      entered()
      await held
      return 'done'
    })
    await started
    const closeA = table.close('session-a')
    expect(() => bound.runInWorkspace('session-a', async () => undefined)).toThrow('E_WORKSPACE_REQUIRED')
    await expect(
      preload({ sessionKey: 'session-b', prompt: 'Use the review Skill.' }),
    ).resolves.toMatchObject({
      section: { text: expect.stringContaining('loaded:session-b') },
    })
    expect(eventsA).not.toContain('workspace')
    expect(eventsB).not.toContain('workspace')
    release()
    await expect(activeA).resolves.toBe('done')
    await closeA
    expect(eventsA.filter((event) => event === 'workspace')).toHaveLength(1)
    expect(eventsB).not.toContain('workspace')
    await table.close('session-b')
    await Promise.all([builtA.readiness.revoke(), builtB.readiness.revoke()])
  })
})

describe('SessionWorkspaceRuntimeTable', () => {
  it('acquires exactly one lease before scheduling the invocation callback', async () => {
    const events: string[] = []
    const built = await runtime('session-a', events)
    const table = new SessionWorkspaceRuntimeTable()
    await table.open(built.value.binding, async () => built.value)
    const internal = table as unknown as {
      acquire(sessionKey: string): { runtime: unknown; release(): void }
    }
    const originalAcquire = internal.acquire.bind(table)
    let acquisitions = 0
    internal.acquire = (sessionKey) => {
      acquisitions++
      return originalAcquire(sessionKey)
    }
    let callbackStarted = false
    let releaseCallback!: () => void
    const callbackHeld = new Promise<void>((resolve) => {
      releaseCallback = resolve
    })

    const running = table.invocation('session-a').run(async () => {
      callbackStarted = true
      await callbackHeld
    })

    expect(acquisitions).toBe(1)
    expect(callbackStarted).toBe(false)
    const closing = table.close('session-a')
    await Promise.resolve()
    expect(callbackStarted).toBe(true)
    expect(events).not.toContain('workspace')
    releaseCallback()
    await running
    await closing
    expect(acquisitions).toBe(1)
    expect(events.filter((event) => event === 'workspace')).toHaveLength(1)
    await built.readiness.revoke()
  })

  it('waits for unawaited descendants and revokes every leaked capability after callback return', async () => {
    const starts: string[] = []
    let releaseDescendants!: () => void
    const descendantsHeld = new Promise<void>((resolve) => {
      releaseDescendants = resolve
    })
    const invocationFs: FsOps = {
      ...fs,
      read: async () => {
        starts.push('fs')
        await descendantsHeld
        return new Uint8Array([1])
      },
    }
    const built = await runtime('session-a', [], {
      fs: invocationFs,
      confine: async ({ argv }) => {
        starts.push('confine')
        await descendantsHeld
        return argv
      },
      hooks: {
        async snapshot() {
          starts.push('hook')
          await descendantsHeld
          return Object.freeze({
            workspaceDigest: 'a'.repeat(64),
            policyRevision: 'revision-1',
            hooks: [],
          })
        },
      },
      services: {
        approval: {
          async ask() {
            return 'rejected' as const
          },
          async resume() {
            starts.push('approval')
            await descendantsHeld
            return null
          },
        },
        checkpoint: {
          async snapshot() {
            return { id: 'checkpoint' }
          },
          async rewind() {},
          async list() {
            starts.push('checkpoint')
            await descendantsHeld
            return []
          },
        },
      },
    })
    const table = new SessionWorkspaceRuntimeTable()
    await table.open(built.value.binding, async () => built.value)
    let leakedView: Parameters<Parameters<ReturnType<typeof table.invocation>['run']>[0]>[0] | undefined
    const lateCalls: Array<() => Promise<unknown>> = []
    const descendants: Promise<unknown>[] = []

    const running = table.invocation('session-a').run(async (view) => {
      leakedView = view
      const leakedFs = view.fs()
      const leakedSandbox = await view.ready()
      const leakedApproval = view.approvalContext()
      const leakedCheckpoint = view.checkpointContext()
      lateCalls.push(
        () => leakedFs.read('late'),
        () => leakedSandbox.confine(['late']),
        () => view.hookSnapshot(),
        () => leakedApproval.resume('ticket', 'rejected'),
        () => leakedCheckpoint.list(),
      )
      descendants.push(
        leakedFs.read('file'),
        leakedSandbox.confine(['tool']),
        view.hookSnapshot(),
        leakedApproval.resume('ticket', 'rejected'),
        leakedCheckpoint.list(),
      )
    })
    let settled = false
    void running.then(() => {
      settled = true
    })
    for (let index = 0; index < 10 && starts.length < 5; index++) await Promise.resolve()

    expect(starts).toEqual(['fs', 'confine', 'hook', 'approval', 'checkpoint'])
    expect(settled).toBe(false)
    releaseDescendants()
    const outcomes = await Promise.allSettled(descendants)
    expect(outcomes.map(({ status }) => status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
    ])
    expect(outcomes[3]).toMatchObject({ reason: { code: 'E_WORKSPACE_CLOSED' } })
    await running

    expect(() => leakedView?.fs()).toThrow('E_WORKSPACE_CLOSED')
    expect(lateCalls).toHaveLength(5)
    for (const call of lateCalls) await expect(call()).rejects.toThrow('E_WORKSPACE_CLOSED')
    await table.close('session-a')
    await built.readiness.revoke()
  })

  it('removes a closing session immediately and waits for its invocation lease', async () => {
    const events: string[] = []
    const built = await runtime('session-a', events)
    const table = new SessionWorkspaceRuntimeTable()
    await table.open(built.value.binding, async () => built.value)
    let releaseInvocation!: () => void
    const held = new Promise<void>((resolve) => {
      releaseInvocation = resolve
    })
    const port = table.invocation('session-a')
    const invocation = port.run(async () => held)
    const closing = table.close('session-a')
    expect(table.peek('session-a')).toEqual({
      root: '/work',
      policyDigest: 'a'.repeat(64),
      state: 'closing',
    })
    expect(() => port.run(async () => undefined)).toThrow('E_WORKSPACE_CLOSED')
    let settled = false
    void closing.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseInvocation()
    await invocation
    await closing
    expect(table.close('session-a')).toBe(closing)
    expect(events).toContain('workspace')
    await built.readiness.revoke()
  })

  it('does not publish a same-key reopen until the previous invocation lease drains', async () => {
    const oldEvents: string[] = []
    const nextEvents: string[] = []
    const oldRuntime = await runtime('session-a', oldEvents)
    const nextRuntime = await runtime('session-a', nextEvents)
    const table = new SessionWorkspaceRuntimeTable()
    await table.open(oldRuntime.value.binding, async () => oldRuntime.value)
    let releaseInvocation!: () => void
    const held = new Promise<void>((resolve) => {
      releaseInvocation = resolve
    })
    const oldPort = table.invocation('session-a')
    const invocation = oldPort.run(async () => held)
    const closing = table.close('session-a')
    let created = false
    const reopening = table.open(nextRuntime.value.binding, async () => {
      created = true
      return nextRuntime.value
    })
    await Promise.resolve()
    expect(created).toBe(false)
    expect(table.peek('session-a')).toMatchObject({ state: 'closing' })
    releaseInvocation()
    await invocation
    await closing
    await expect(reopening).resolves.toMatchObject({
      binding: nextRuntime.value.binding,
      invocation: table.invocation('session-a'),
    })
    expect(() => oldPort.run(async () => undefined)).toThrow('E_WORKSPACE_CLOSED')
    expect(created).toBe(true)
    await table.close('session-a')
    await Promise.all([oldRuntime.readiness.revoke(), nextRuntime.readiness.revoke()])
  })

  it('lets close take ownership of an opening key without publishing or reviving it', async () => {
    const events: string[] = []
    const built = await runtime('session-a', events)
    const table = new SessionWorkspaceRuntimeTable()
    let createEntered!: () => void
    let finishCreate!: () => void
    const createStarted = new Promise<void>((resolve) => {
      createEntered = resolve
    })
    const createHeld = new Promise<void>((resolve) => {
      finishCreate = resolve
    })
    const opening = table.open(built.value.binding, async () => {
      createEntered()
      await createHeld
      return built.value
    })
    void opening.catch(() => undefined)
    await createStarted

    const firstClose = table.close('session-a')
    expect(table.close('session-a')).toBe(firstClose)
    let closeSettled = false
    void firstClose.then(() => {
      closeSettled = true
    })
    await Promise.resolve()
    expect(closeSettled).toBe(false)
    expect(table.peek('session-a')).toBeUndefined()

    finishCreate()
    await expect(opening).rejects.toThrow('E_WORKSPACE_CLOSED')
    await firstClose
    expect(table.peek('session-a')).toBeUndefined()
    expect(events).toEqual(['hooks-open', 'services-open', 'services', 'hooks', 'fence', 'workspace'])
    expect(() => table.invocation('session-a').run(async () => undefined)).toThrow('E_WORKSPACE_REQUIRED')

    const reopened = await runtime('session-a')
    await expect(table.open(reopened.value.binding, async () => reopened.value)).resolves.toBeDefined()
    await table.close('session-a')
    await Promise.all([built.readiness.revoke(), reopened.readiness.revoke()])
  })

  it('shares one owner with a committed child and closes it exactly once in either order', async () => {
    const events: string[] = []
    const built = await runtime('parent', events)
    const table = new SessionWorkspaceRuntimeTable()
    await table.open(built.value.binding, async () => built.value)
    const unbound = table.invocation('child')
    const child = await table.reserve('parent', 'child')
    expect(child.invocation).toBe(table.invocation('child'))
    expect(child.invocation).not.toBe(unbound)
    expect(() => unbound.run(async () => undefined)).toThrow('E_WORKSPACE_CLOSED')
    expect(child.commit()).toBe(true)
    expect(child.invocation).toBe(table.invocation('child'))
    expect(child.commit()).toBe(false)
    await table.close('parent')
    expect(events).not.toContain('workspace')
    const firstClose = child.close()
    expect(child.close()).toBe(firstClose)
    await firstClose
    expect(events.filter((event) => event === 'workspace')).toHaveLength(1)
    await built.readiness.revoke()
  })

  it('never revives a pending child that loses close/commit', async () => {
    const built = await runtime('parent')
    const table = new SessionWorkspaceRuntimeTable()
    await table.open(built.value.binding, async () => built.value)
    const child = await table.reserve('parent', 'child')
    const closing = child.close()
    expect(child.commit()).toBe(false)
    await closing
    expect(table.peek('child')).toBeUndefined()
    await table.close('parent')
    await built.readiness.revoke()
  })

  it('does not consume an owner ref when an invalid child key is rejected', async () => {
    const events: string[] = []
    const parent = await runtime('parent', events)
    const table = new SessionWorkspaceRuntimeTable()
    await table.open(parent.value.binding, async () => parent.value)

    await expect(table.reserve('parent', 'invalid\0child')).rejects.toThrow('E_WORKSPACE_UNTRUSTED')
    await table.closeAll()
    expect(events.filter((event) => event === 'workspace')).toHaveLength(1)
    expect(table.peek('parent')).toBeUndefined()
    await parent.readiness.revoke()
  })

  it('rejects reserve and commit while the same child key is closing', async () => {
    const parent = await runtime('parent')
    const table = new SessionWorkspaceRuntimeTable()
    await table.open(parent.value.binding, async () => parent.value)
    const pending = await table.reserve('parent', 'child')
    await expect(table.reserve('parent', 'child')).rejects.toThrow('E_WORKSPACE_UNTRUSTED')

    let releaseInvocation!: () => void
    const held = new Promise<void>((resolve) => {
      releaseInvocation = resolve
    })
    const invocation = pending.invocation.run(async () => held)
    const closing = table.close('child')
    expect(pending.commit()).toBe(false)
    await expect(table.reserve('parent', 'child')).rejects.toThrow('E_WORKSPACE_UNTRUSTED')

    releaseInvocation()
    await invocation
    await closing
    await pending.close()
    await table.close('parent')
    await parent.readiness.revoke()
  })

  it('rejects a pending child commit after its parent starts closing', async () => {
    const events: string[] = []
    const parent = await runtime('parent', events)
    const table = new SessionWorkspaceRuntimeTable()
    await table.open(parent.value.binding, async () => parent.value)
    const pending = await table.reserve('parent', 'child')

    await table.close('parent')
    expect(pending.commit()).toBe(false)
    expect(table.peek('child')).toBeUndefined()
    await pending.close()
    expect(events.filter((event) => event === 'workspace')).toHaveLength(1)
    await parent.readiness.revoke()
  })

  it('beginClose rejects open/reserve/acquire and closeAll drains pending tokens', async () => {
    const built = await runtime('parent')
    const table = new SessionWorkspaceRuntimeTable()
    await table.open(built.value.binding, async () => built.value)
    const pending = await table.reserve('parent', 'child')
    table.beginClose()
    expect(() => table.invocation('parent').run(async () => undefined)).toThrow('E_WORKSPACE_CLOSED')
    await expect(table.reserve('parent', 'another')).rejects.toThrow('E_WORKSPACE_CLOSED')
    await expect(table.open(binding('late'), async () => built.value)).rejects.toThrow('E_WORKSPACE_CLOSED')
    await table.finishCloseAll()
    expect(pending.commit()).toBe(false)
    await built.readiness.revoke()
  })

  it('two-phase shutdown drains pending children, committed sessions, and an in-flight invocation', async () => {
    const events: string[] = []
    const built = await runtime('parent', events)
    const table = new SessionWorkspaceRuntimeTable()
    await table.open(built.value.binding, async () => built.value)
    const committed = await table.reserve('parent', 'child')
    expect(committed.commit()).toBe(true)
    const pending = await table.reserve('parent', 'pending-child')
    let releaseInvocation!: () => void
    const held = new Promise<void>((resolve) => {
      releaseInvocation = resolve
    })
    const childPort = table.invocation('child')
    const invocation = childPort.run(async () => held)

    table.beginClose()
    const closing = table.finishCloseAll()
    let settled = false
    void closing.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(() => childPort.run(async () => undefined)).toThrow('E_WORKSPACE_CLOSED')
    expect(pending.commit()).toBe(false)

    releaseInvocation()
    await invocation
    await closing
    expect(events.filter((event) => event === 'workspace')).toHaveLength(1)
    expect(table.peek('parent')).toBeUndefined()
    expect(table.peek('child')).toBeUndefined()
    expect(table.peek('pending-child')).toBeUndefined()
    await built.readiness.revoke()
  })
})
