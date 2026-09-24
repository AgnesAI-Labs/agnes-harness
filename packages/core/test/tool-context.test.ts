import type { PublicFetch } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { buildToolContext, type ChildHandle, type ChildrenFactory } from '../src/effects/tool-context.js'
import { SeamRuntime } from '../src/effects/wrap.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeSeams } from './helpers/fake-seams.js'

function setup(
  seams = fakeSeams(),
  publicFetch?: PublicFetch,
  over: {
    invoke?: Parameters<typeof buildToolContext>[0]['invoke']
    parentSignal?: AbortSignal
  } = {},
) {
  const created: unknown[] = []
  const run = vi.fn(async (input: string) => ({ text: `answer:${input}`, lastSeq: 1 }))
  const close = vi.fn(async () => undefined)
  const child: ChildHandle = {
    key: 'child-1',
    worktree: '/tmp/child-1',
    run,
    status: async () => ({ state: 'done', lastSeq: 1, text: 'done' }),
    close,
  }
  const children: ChildrenFactory = {
    create: async (opts) => {
      created.push(opts)
      return child
    },
  }
  const runtime = new SeamRuntime(seams, presetDefaults(), {
    clock: () => 0,
    onFailure: () => undefined,
  })
  const context = buildToolContext(
    {
      sessionKey: 'parent-1',
      lane: 'main',
      turn: 1,
      step: 1,
      depth: 0,
      generationDepth: 0,
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      cwd: '/workspace/parent',
      runtime,
      preset: presetDefaults(),
      children,
      fsOps: {
        read: async () => new Uint8Array(),
        write: async () => undefined,
        list: async () => [],
        stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
      },
      netFetch: async () => new Response(''),
      ...(publicFetch ? { publicFetch } : {}),
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      invoke: over.invoke ?? (async () => ({ content: [] })),
      listTools: () => [],
      appendPlan: async () => 1,
      requestCompaction: () => undefined,
      progress: () => undefined,
      artifactJobEvent: async () => undefined,
      lease: { remainingMs: () => 1_000 },
    },
    {
      toolUseId: 'tool-1',
      name: 'fixture',
      signal: over.parentSignal ?? new AbortController().signal,
      timeoutMs: 1_000,
    },
  )
  return { context, created, run, close }
}

describe('ToolContext subagent options', () => {
  it('always propagates parent cancellation to nested tools while allowing a child to narrow it', async () => {
    const signals: AbortSignal[] = []
    const parent = new AbortController()
    const child = new AbortController()
    const { context } = setup(fakeSeams(), undefined, {
      parentSignal: parent.signal,
      invoke: async (_name, _args, opts) => {
        if (opts.signal) signals.push(opts.signal)
        return { content: [] }
      },
    })
    await context.tools.invoke('a', {})
    await context.tools.invoke('b', {}, { signal: child.signal })
    expect(signals).toHaveLength(2)
    parent.abort()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })

  it('binds public fetching to this tool cancellation and lease budget', async () => {
    const fetch = vi.fn<PublicFetch>().mockResolvedValue({
      url: 'https://example.com',
      statusCode: 200,
      contentType: 'text/plain',
      body: { kind: 'text', content: 'ok' },
      truncation: { bytes: false, decoded: false },
    })
    const { context } = setup(fakeSeams(), fetch)
    await context.net.fetchPublic?.('https://example.com')
    expect(fetch).toHaveBeenCalledWith('https://example.com', { signal: context.signal, timeoutMs: 1000 })
    expect(setup().context.net.fetchPublic).toBeUndefined()
  })
  it('passes fork model to the child factory and retains one-shot cleanup', async () => {
    const { context, created, run, close } = setup()

    await expect(context.subagent.fork('question', { model: 'provider/model' })).resolves.toBe(
      'answer:question',
    )
    expect(created).toEqual([
      {
        parent: 'parent-1',
        cwd: '/workspace/parent',
        model: 'provider/model',
        input: 'question',
        parentEffectId: 'tool-1',
      },
    ])
    expect(run).toHaveBeenCalledWith('question')
    expect(close).toHaveBeenCalledOnce()
  })

  it('passes every spawn override exactly, including a zero budget', async () => {
    const { context, created, run, close } = setup()

    await expect(
      context.subagent.spawn('task', {
        model: 'provider/model',
        budget: 0,
        cwd: '/workspace/child',
        isolation: 'worktree',
      }),
    ).resolves.toEqual({ childKey: 'child-1', worktree: '/tmp/child-1' })
    expect(created).toEqual([
      {
        parent: 'parent-1',
        cwd: '/workspace/child',
        model: 'provider/model',
        budget: 0,
        isolation: 'worktree',
        input: 'task',
        parentEffectId: 'tool-1',
      },
    ])
    expect(run).toHaveBeenCalledWith('task')
    expect(close).not.toHaveBeenCalled()
  })

  it('defaults spawn cwd without manufacturing absent optional fields', async () => {
    const { context, created } = setup()

    await context.subagent.spawn('task')
    expect(created).toEqual([
      { parent: 'parent-1', cwd: '/workspace/parent', input: 'task', parentEffectId: 'tool-1' },
    ])
    expect(Object.keys(created[0] as object).sort()).toEqual(['cwd', 'input', 'parent', 'parentEffectId'])
  })

  it('collect wait timeout does not cancel the child', async () => {
    const cancel = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const child: ChildHandle = {
      key: 'child-1',
      run: async () => ({ text: '', lastSeq: 1 }),
      status: async () => ({ state: 'running', lastSeq: 1 }),
      close,
      cancel,
    }
    const children: ChildrenFactory = {
      create: async () => child,
      get: () => child,
      inspect: async () => ({ state: 'running', lastSeq: 1 }),
    }
    const runtime = new SeamRuntime(fakeSeams(), presetDefaults(), {
      clock: () => 0,
      onFailure: () => undefined,
    })
    const context = buildToolContext(
      {
        sessionKey: 'parent-1',
        lane: 'main',
        turn: 1,
        step: 1,
        depth: 0,
        generationDepth: 0,
        actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        cwd: '/workspace/parent',
        runtime,
        preset: presetDefaults(),
        children,
        fsOps: {
          read: async () => new Uint8Array(),
          write: async () => undefined,
          list: async () => [],
          stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
        },
        netFetch: async () => new Response(''),
        log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
        invoke: async () => ({ content: [] }),
        listTools: () => [],
        appendPlan: async () => 1,
        requestCompaction: () => undefined,
        progress: () => undefined,
        artifactJobEvent: async () => undefined,
        lease: { remainingMs: () => 5 },
      },
      { toolUseId: 'tool-1', name: 'fixture', signal: new AbortController().signal, timeoutMs: 1_000 },
    )
    await expect(context.subagent.collect('child-1', { wait: true })).resolves.toMatchObject({
      childKey: 'child-1',
      status: 'running',
      waitTimedOut: true,
    })
    expect(cancel).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })
})

describe('ToolContext platform view and sandbox enforcement (spec 2026-09-15 §4 rows 1 and 9)', () => {
  it('copies the four platform facts from seams.platform and freezes them', () => {
    const { context } = setup()
    expect(context.platform.shell).toBe('posix')
    expect(context.platform.fs).toEqual({ caseSensitive: true, pathSep: '/' })
    expect(context.platform.terminal).toEqual({ color: false })
    expect(Object.isFrozen(context.platform)).toBe(true)
    expect(Object.isFrozen(context.platform.fs)).toBe(true)
    expect(Object.keys(context.platform.terminal)).toEqual(['color'])
  })

  it('probes capability through the seam at call time and returns a frozen copy', () => {
    const seen: string[] = []
    const { context } = setup(
      fakeSeams({
        platform: {
          capability: (id) => {
            seen.push(id)
            return { level: 'partial', scope: ['probe'], reason: 'fixture' }
          },
        },
      }),
    )
    const report = context.platform.capability('sandbox.l1')
    expect(seen).toEqual(['sandbox.l1'])
    expect(report).toEqual({ level: 'partial', scope: ['probe'], reason: 'fixture' })
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.scope)).toBe(true)
  })

  it('degrades capability() to unavailable/threw instead of throwing when the seam throws (fail-closed, C2)', () => {
    // The public contract (extension-api/src/common.ts) declares capability(id: string) total over
    // any string; the real host backends throw for any id outside their fixed CAPABILITY_IDS list.
    // A third-party author probing an id the host does not recognize must get a report back, not an
    // uncaught exception.
    const { context } = setup(
      fakeSeams({
        platform: {
          capability: () => {
            throw new Error('backend down')
          },
        },
      }),
    )
    expect(() => context.platform.capability('made-up-id')).not.toThrow()
    expect(context.platform.capability('made-up-id')).toEqual({
      level: 'unavailable',
      scope: [],
      reason: 'threw',
    })
  })

  it('fails sandbox closed without an invocation capability and exposes only the public sandbox window', async () => {
    const { context } = setup(
      fakeSeams({ sandbox: { enforcement: () => ({ level: 'partial', scope: ['file'] }) } }),
    )
    expect(context.sandbox.enforcement()).toEqual({ level: 'none', scope: [] })
    expect(Object.isFrozen(context.sandbox.enforcement())).toBe(true)
    expect(Object.keys(context.sandbox).sort()).toEqual(['confine', 'enforcement'])
    await expect(context.sandbox.confine(['echo'])).rejects.toThrow('E_WORKSPACE_CLOSED')
    await expect(context.exec(['echo'])).rejects.toThrow('E_WORKSPACE_CLOSED')
  })

  it('degrades sandbox.enforcement() to none/[] instead of throwing when the seam throws (fail-closed regression, I4)', () => {
    // Regression coverage for Task 2's fix: tool-context.ts's enforcement() routes through
    // SeamRuntime.enforcement() specifically so a throwing sandbox backend cannot crash into tool
    // code. Reverting that call to the raw seam (d.runtime.seams.sandbox.enforcement()) makes this
    // test fail - see the execution record for the observed RED transcript.
    const { context } = setup(
      fakeSeams({
        sandbox: {
          enforcement: () => {
            throw new Error('backend down')
          },
        },
      }),
    )
    expect(() => context.sandbox.enforcement()).not.toThrow()
    expect(context.sandbox.enforcement()).toEqual({ level: 'none', scope: [] })
  })

  it('exposes exactly the contracted key set and no closed seam (spec §6.1)', () => {
    const { context } = setup()
    expect(Object.keys(context).sort()).toEqual([
      'actor',
      'artifacts',
      'authorize',
      'cwd',
      'exec',
      'fs',
      'lease',
      'log',
      'net',
      'plan',
      'platform',
      'progress',
      'projections',
      'requestCompaction',
      'sandbox',
      'session',
      'signal',
      'subagent',
      'timeoutMs',
      'tools',
    ])
  })
})
