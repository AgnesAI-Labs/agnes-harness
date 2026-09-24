import type { ToolDef } from '@agnes/extension-api'
import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { platformFacts } from '../src/effects/platform-facts.js'
import { HookEngine } from '../src/hooks/engine.js'
import { SessionHookPort } from '../src/hooks/port.js'
import { CORE_DIAG_NAMES, Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { HookRegistry } from '../src/registry/hooks.js'
import { ResourceRegistry } from '../src/registry/resources.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { contextTokens } from '../src/step/gate.js'
import { presetDefaults } from '../src/step/preset.js'
import { noopHooks } from '../src/step/session.js'
import { CoreError } from '../src/types.js'
import type { WorkspaceInvocationPort } from '../src/workspace/runtime.js'
import { testFsPolicy } from '../testkit/fenced-fs.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { opHistory } from './helpers/op-history.js'
import {
  actor,
  noTimers,
  openWorldTool,
  readTool,
  testFsOps,
  testWorkspaceInvocation,
  writeTool,
} from './helpers/open-session.js'

const platform = platformFacts(fakeSeams().platform)
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const base = (over: Partial<Parameters<typeof Kernel.create>[0]> = {}) =>
  Kernel.create({
    storage: new MemoryStorage(),
    seams: fakeSeams(),
    provider: fakeProvider([]),
    contract: { contract_id: null, parser_version: '1' },
    preset: presetDefaults(),
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
    ...over,
  })
const sessionOpts = {
  actor,
  resolvedProfileHash: 'h1',
  cwd: '/w',
  writerRunId: 'r1',
}
const childPreset = { ...presetDefaults(), treeBudgetCredits: 100 }
const modelRecord = (route: string, id: string, slot?: NonNullable<ModelRecord['slot']>): ModelRecord => ({
  id,
  name: id,
  api: 'openai-completions',
  route,
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
  ...(slot ? { slot } : {}),
})

describe('Kernel (I1 assembly)', () => {
  it('refuses to create without every seam, and names the one that is missing', () => {
    for (const name of ['repair', 'ledger', 'principals'] as const) {
      const seams = fakeSeams()
      delete (seams as Record<string, unknown>)[name]
      const err = (() => {
        try {
          base({ seams })
          return null
        } catch (e) {
          return e
        }
      })()
      expect(err).toBeInstanceOf(CoreError)
      expect((err as CoreError).code).toBe('E_SEAM_MISSING')
      expect((err as CoreError).message).toContain(name)
    }
    // A seam present but not an object is as missing as an absent one.
    const notAnObject = fakeSeams()
    ;(notAnObject as Record<string, unknown>).sandbox = 'yes'
    expect(() => base({ seams: notAnObject })).toThrow('E_SEAM_MISSING: sandbox')
  })

  it('opens a session once per key, writes session/start once, and reopens the same ledger after close', async () => {
    // One storage instance across two kernels: SessionLogImpl does not expose the adapter it holds,
    // so a test that wants the same ledger back has to keep hold of the storage itself.
    const storage = new MemoryStorage()
    const k = base({ storage })
    const s = await k.session('k1', sessionOpts)
    expect(await k.session('k1', sessionOpts)).toBe(s)
    expect(k.get('k1')).toBe(s)
    expect(k.get('nope')).toBeUndefined()
    expect((await s.scan({ fromSeq: 1, limit: 5 })).map((e) => e.type)).toEqual(['session/start'])
    await k.close()
    expect(k.sessions.size).toBe(0)
    // Closing the kernel closes the sessions it opened, rather than only dropping the storage:
    // a session left open would keep renewing a lease and would still accept appends.
    expect(s.ac.signal.aborted).toBe(true)
    await expect(
      s.enqueue('next-turn', { content: [{ type: 'text', text: 'late' }], actor }),
    ).rejects.toThrow('E_CLOSED')
    const k2 = base({ storage })
    const again = await k2.session('k1', { ...sessionOpts, writerRunId: 'r2' })
    expect((await again.scan({ fromSeq: 1, limit: 5 })).map((e) => e.type)).toEqual(['session/start'])
    expect(again.lastSeq).toBe(1)
    await k2.close()
  })

  it('two keys get two ledgers, and the tool registry is shared across them', async () => {
    const k = base()
    k.tools.add(readTool(), { source: 'agnes/tools-core', trust: 'builtin' })
    const a = await k.session('a', sessionOpts)
    const b = await k.session('b', { ...sessionOpts, writerRunId: 'r2' })
    expect(a).not.toBe(b)
    expect(a.key).toBe('a')
    expect(b.key).toBe('b')
    expect(a.d.registry).toBe(k.tools)
    expect(b.d.registry).toBe(k.tools)
    await k.close()
  })

  it('delegates session workspace close once and shares the same close promise', async () => {
    const k = base()
    let workspaceCloses = 0
    const workspaceClose = Promise.resolve()
    const workspaceInvocation = { run: vi.fn() } as unknown as WorkspaceInvocationPort
    const session = await k.session('workspace-owner', {
      ...sessionOpts,
      workspaceRuntime: Object.freeze({ fs: testFsOps(), invocation: workspaceInvocation }),
      workspaceLease: {
        close: () => {
          workspaceCloses += 1
          return workspaceClose
        },
      },
    })
    expect(session.d.workspaceInvocation).toBe(workspaceInvocation)
    const first = session.close()
    expect(session.close()).toBe(first)
    await first
    expect(workspaceCloses).toBe(1)
    await k.close()
    expect(workspaceCloses).toBe(1)
  })

  it('binds each session to its workspace runtime filesystem instead of the first assembly root', async () => {
    const firstPolicy = testFsPolicy('/w')
    const secondPolicy = testFsPolicy('/second')
    const firstFs = testFsOps(firstPolicy)
    const secondFs = testFsOps(secondPolicy)
    const firstPort = testWorkspaceInvocation(firstFs)
    const secondPort = testWorkspaceInvocation(
      secondFs,
      fakeSeams({ sandbox: { fsPolicy: () => secondPolicy } }),
      '/second',
    )
    const k = base({ fsOps: firstFs })
    const first = await k.session('first-workspace', {
      ...sessionOpts,
      workspaceRuntime: Object.freeze({ fs: firstFs, invocation: firstPort }),
    })
    const second = await k.session('second-workspace', {
      ...sessionOpts,
      cwd: '/second',
      writerRunId: 'r2',
      workspaceRuntime: Object.freeze({ fs: secondFs, invocation: secondPort }),
      seams: { sandbox: { ...fakeSeams().sandbox, fsPolicy: () => secondPolicy } },
    })

    expect(first.d).not.toHaveProperty('fsOps')
    expect(second.d).not.toHaveProperty('fsOps')
    await expect(secondPort.run((view) => view.fs().stat('.'))).resolves.toMatchObject({ kind: 'file' })
    await expect(secondPort.run((view) => view.fs().stat('/w/from-first-root'))).rejects.toThrow('FS_DENIED')
    await k.close()
  })

  it('the session it assembles runs one full turn end to end', async () => {
    const k = base({ provider: fakeProvider([toolTurn('read', { path: 'README' }), textTurn('summary')]) })
    k.tools.add(readTool(), { source: 'agnes/tools-core', trust: 'builtin' })
    const s = await k.session('k1', sessionOpts)
    await s.enqueue('next-turn', { content: [{ type: 'text', text: 'read README and summarize' }], actor })
    expect((await s.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(s.surface().map((n) => n.kind)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
    await k.close()
  })

  it('agnes resume: a killed session picks up the turn from the ledger', async () => {
    const storage = new MemoryStorage()
    const registry = new ToolRegistry()
    registry.add(readTool(), { source: 'agnes/tools-core', trust: 'builtin' })
    const k = base({ storage, provider: fakeProvider([toolTurn('read', { path: 'a' })]) })
    k.tools.add(readTool(), { source: 'agnes/tools-core', trust: 'builtin' })
    const s = await k.session('k1', sessionOpts)
    await s.enqueue('next-turn', { content: [{ type: 'text', text: 'read a' }], actor })
    await s.step()
    await s.step()
    await s.step()
    expect(s.op()?.phase.kind).toBe('tools')
    // The kill: the lease goes back, the process forgets everything, the ledger stays.
    await k.close()

    const k2 = base({ storage, provider: fakeProvider([textTurn('done')]) })
    k2.tools.add(readTool(), { source: 'agnes/tools-core', trust: 'builtin' })
    const again = await k2.session('k1', { ...sessionOpts, writerRunId: 'r2' })
    expect(again.op()?.phase.kind).toBe('tools')
    expect(again.turn).toBeNull()
    const out = await again.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(out.reason).toBe('completed')
    // One turn across the kill, not two, and the conversation is whole.
    expect(await again.scan({ type: 'turn/start', limit: 10 })).toHaveLength(1)
    expect(again.surface().map((n) => n.kind)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
    // The rebuilt turn re-derived under the nonce the first process stamped (C-21), so the two
    // request headers are comparable rather than trivially different.
    const headers = await again.scan({ type: 'request/header', limit: 10 })
    const nonces = new Set(headers.map((e) => (e.data as { envelopeNonce: string }).envelopeNonce))
    expect(nonces.size).toBe(1)
    await k2.close()
  })

  it('the diagnostic name set is closed and holds the names written outside the kernel', () => {
    expect(new Set(CORE_DIAG_NAMES).size).toBe(CORE_DIAG_NAMES.length)
    expect(CORE_DIAG_NAMES).toHaveLength(22)
    expect(CORE_DIAG_NAMES).toContain('request-media-window')
    expect(CORE_DIAG_NAMES).toContain('registers-rebuilt')
    expect(CORE_DIAG_NAMES).toContain('contribute-conflict')
    expect(CORE_DIAG_NAMES).toContain('manual-compaction')
    expect(CORE_DIAG_NAMES).toContain('context-breakdown')
    expect(CORE_DIAG_NAMES).toContain('tool-policy-refused-on-resume')
    expect(CORE_DIAG_NAMES).toContain('hook-compact-plan-ignored')
  })
})

describe('Kernel default children', () => {
  it('forks an immutable child ledger, runs it, exposes status, and emits lifecycle hooks', async () => {
    const starts: unknown[] = []
    const ends: unknown[] = []
    const storage = new MemoryStorage()
    const open = vi.spyOn(storage, 'open')
    const provider = fakeProvider([textTurn('child says hi')])
    Object.assign(provider, {
      models: () => [
        {
          id: 'm1',
          name: 'm1',
          api: 'openai-completions',
          route: 'default',
          baseUrl: 'https://example.invalid/v1',
          reasoning: false,
          input: ['text'],
          cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 128,
          toolCallFormats: ['native'],
          thinkingReplay: 'native',
          contract_id: null,
        },
      ],
    })
    const k = base({ storage, provider, preset: childPreset })
    k.hooks.on(
      'subagent_start',
      (payload) => {
        starts.push(payload)
      },
      {
        source: 'agnes/child-test',
        trust: 'trusted',
      },
    )
    k.hooks.on(
      'subagent_end',
      (payload) => {
        ends.push(payload)
      },
      {
        source: 'agnes/child-test',
        trust: 'trusted',
      },
    )
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({
      parent: parent.key,
      cwd: parent.d.cwd,
      input: 'what?',
    })
    // Parent open + forkInto's child open. The tracker must attach to that child log instead of
    // opening the same writer a second time (which would also install a second lease timer).
    expect(open).toHaveBeenCalledTimes(2)
    expect(parent.d.children.get?.(child.key)).toBe(child)
    expect(await child.status()).toMatchObject({ state: 'running', lastSeq: 5 })

    await expect(child.run('what?')).resolves.toMatchObject({ text: 'child says hi' })
    expect(await child.status()).toMatchObject({ state: 'done', text: 'child says hi' })
    const types = (await storage.scan(child.key, { fromSeq: 1, limit: 100 })).map((event) => event.type)
    expect(types?.slice(0, 2)).toEqual(['session/start', 'session/start'])
    expect(types).toContain('assistant/message')
    expect(types).toContain('turn/end')
    expect(parent.surface()).toEqual([])
    expect(starts).toEqual([{ childKey: child.key, kind: 'fork', budget: null }])
    expect(ends).toEqual([{ childKey: child.key, outcome: 'completed', credits: 1 }])

    await child.close()
    expect(parent.d.children.get?.(child.key)).toBeUndefined()
    await k.close()
  })

  it('resolves child model selectors from a slot, model id, or route/model pair', async () => {
    const provider = fakeProvider([textTurn('by id'), textTurn('by slot'), textTurn('by pair')])
    Object.assign(provider, {
      models: () => [modelRecord('ds', 'deepseek-v4-pro', 'fast'), modelRecord('anthropic', 'claude/sonnet')],
    })
    const k = base({ provider, preset: childPreset })
    const parent = await k.session('parent', {
      ...sessionOpts,
      preset: {
        ...childPreset,
        model: {
          ...presetDefaults().model,
          route: { primary: 'ds', fast: 'ds' },
          id: { primary: 'deepseek-v4-pro', fast: 'deepseek-v4-pro' },
        },
      },
    })

    for (const [selector, expected] of [
      ['deepseek-v4-pro', { route: 'ds', model: 'deepseek-v4-pro' }],
      ['fast', { route: 'ds', model: 'deepseek-v4-pro' }],
      ['anthropic/claude/sonnet', { route: 'anthropic', model: 'claude/sonnet' }],
    ] as const) {
      const child = await parent.d.children.create({
        parent: parent.key,
        cwd: '/w',
        model: selector,
        input: `use ${selector}`,
      })
      await child.run(`use ${selector}`)
      expect(provider.requests.at(-1)).toMatchObject(expected)
      await child.close()
    }
    await k.close()
  })

  it('fails closed on a foreign parent and modifiers the default factory cannot resolve', async () => {
    const k = base({ preset: childPreset })
    const parent = await k.session('parent', { ...sessionOpts, preset: childPreset })
    await expect(parent.d.children.create({ parent: 'other', cwd: '/w', input: 'x' })).rejects.toThrow(
      'parent mismatch',
    )
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', model: 'unresolved-alias', input: 'x' }),
    ).rejects.toThrow('cannot resolve model unresolved-alias')
    expect(k.sessions.size).toBe(1)
    await k.close()
  })
})

describe('Kernel (fix round 1)', () => {
  it('refuses to hand a cached session to a caller asking for a different actor', async () => {
    const k = base()
    const s = await k.session('k1', sessionOpts)
    // The same question gets the same session back.
    expect(await k.session('k1', sessionOpts)).toBe(s)
    for (const [field, over] of [
      ['actor', { actor: { ...actor, id: 'attacker', role: 'guest' } }],
      ['cwd', { cwd: '/elsewhere' }],
      ['writerRunId', { writerRunId: 'r2' }],
      ['lane', { lane: 'other' }],
    ] as const) {
      const err = await k.session('k1', { ...sessionOpts, ...over }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err, field).toBeInstanceOf(CoreError)
      expect((err as CoreError).message).toContain(field === 'actor' ? 'actor' : field)
    }
    // The session that is actually cached still belongs to the caller that opened it.
    expect(s.d.actor.id).toBe(actor.id)
  })

  it('close() closes every session and the storage even when one of them throws', async () => {
    const storage = new MemoryStorage()
    let storageClosed = false
    const realClose = storage.close.bind(storage)
    storage.close = async () => {
      storageClosed = true
      return realClose()
    }
    const k = base({ storage })
    const a = await k.session('a', sessionOpts)
    const b = await k.session('b', { ...sessionOpts, writerRunId: 'r1' })
    let bClosed = false
    a.close = async () => {
      throw new Error('log refused to close')
    }
    const realB = b.close.bind(b)
    b.close = async () => {
      bClosed = true
      return realB()
    }
    await expect(k.close()).rejects.toThrow('log refused to close')
    expect(bClosed).toBe(true)
    expect(storageClosed).toBe(true)
    expect(k.sessions.size).toBe(0)
  })

  /**
   * The escalation, driven end to end against Kernel + MemoryStorage rather than against the
   * segment functions: one prompt, an open-world tool whose result taints the turn, then a
   * non-read-only, non-destructive tool that asks for nothing in a clean turn and must be asked
   * about here. Before the taint was carried onto the counter, this ran with zero approvals.
   */
  it('drives an open-world result into an escalated approval for the next write', async () => {
    const asked: Array<{ tool: string | undefined; taint: boolean }> = []
    const k = base({
      provider: fakeProvider([
        toolTurn('fetch_page', {}),
        toolTurn('write_note', { text: 'from the page' }),
        textTurn('done'),
      ]),
      seams: fakeSeams({
        approval: {
          ask: async (req) => {
            asked.push({ tool: req.tool?.name, taint: req.taint })
            return 'allowed-once'
          },
          resume: async () => null,
        },
      }),
    })
    k.tools.add(openWorldTool(), { source: 's', trust: 'builtin' })
    k.tools.add(writeTool(), { source: 's', trust: 'builtin' })
    const s = await k.session('taint', sessionOpts)
    const ops = opHistory(s.d.log)
    await s.enqueue('next-turn', { content: [{ type: 'text', text: 'read the page and note it' }], actor })
    const out = await s.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(out.reason).toBe('completed')
    // Exactly one question, and it is the one the untrusted text made necessary.
    expect(asked).toEqual([{ tool: 'write_note', taint: true }])
    const rows = await s.scan({ fromSeq: 1, limit: 300 })
    const untrusted = rows.filter((e) => e.type === 'tool/result' && e.trust === 'untrusted')
    expect(untrusted).toHaveLength(1)
    // The counter carries it too, so a resume that reads only op.state escalates the same way.
    const counters = ops
      .writes()
      .filter((w) => w.data !== null)
      .map((w) => (w.data as { taint: boolean }).taint)
    expect(counters[0]).toBe(false)
    expect(counters.at(-1)).toBe(true)
    expect(counters.indexOf(true)).toBeGreaterThan(0)
    const ask = rows.find((e) => e.type === 'approval/asked')
    expect(ask?.data).toMatchObject({ kind: 'tool', risk: 'destructive' })
    await k.close()
  })
})

describe('Kernel per-session hook factory', () => {
  it('creates an independent port once per session before start and reuses only cached sessions', async () => {
    const seen: string[] = []
    const k = base({
      hooksFactory: (session) => {
        seen.push(session.key)
        expect(session.lastSeq).toBe(0)
        return { ...noopHooks }
      },
    })
    const a = await k.session('a', sessionOpts)
    const b = await k.session('b', sessionOpts)
    expect(await k.session('a', sessionOpts)).toBe(a)
    expect(seen).toEqual(['a', 'b'])
    expect(a.hooks).not.toBe(b.hooks)
    await k.close()
  })

  it('rejects ambiguous legacy hooks plus a factory', () => {
    expect(() => base({ hooks: noopHooks, hooksFactory: () => ({ ...noopHooks }) })).toThrow(
      'choose hooks or hooksFactory',
    )
  })

  it('rejects factory port reuse and releases the failed session writer lease', async () => {
    const shared = { ...noopHooks },
      storage = new MemoryStorage()
    const k = base({ storage, hooksFactory: () => shared })
    await k.session('a', sessionOpts)
    await expect(k.session('b', sessionOpts)).rejects.toThrow('hook factory reused a session port')
    expect(k.get('b')).toBeUndefined()
    const recovery = base({ storage })
    await expect(recovery.session('b', { ...sessionOpts, writerRunId: 'different' })).resolves.toHaveProperty(
      'key',
      'b',
    )
    await recovery.close()
    await k.close()
  })

  it.each(['throw', 'invalid'] as const)(
    'releases the writer lease when hook initialization is %s',
    async (kind) => {
      const storage = new MemoryStorage()
      const k = base({
        storage,
        hooksFactory: () => {
          if (kind === 'throw') throw new Error('factory failure')
          return {} as never
        },
      })
      await expect(k.session('failed', sessionOpts)).rejects.toThrow()
      expect(k.get('failed')).toBeUndefined()
      const recovery = base({ storage })
      await expect(
        recovery.session('failed', { ...sessionOpts, writerRunId: 'recovery' }),
      ).resolves.toHaveProperty('key', 'failed')
      await recovery.close()
      await k.close()
    },
  )

  it('resets only on accepted new turns, not on idle runs', async () => {
    let resets = 0
    const k = base({
      provider: fakeProvider([textTurn('done')]),
      hooksFactory: () => ({
        ...noopHooks,
        resetTurn: () => {
          resets++
        },
      }),
    })
    const s = await k.session('turns', sessionOpts)
    await s.run({ until: 'idle', signal: new AbortController().signal })
    expect(resets).toBe(0)
    for (let i = 1; i <= 2; i++) {
      await s.enqueue('next-turn', { content: [{ type: 'text', text: 'hello' }], actor })
      await s.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(resets).toBe(i)
      await s.run({ until: 'idle', signal: new AbortController().signal })
      expect(resets).toBe(i)
    }
    await k.close()
  })

  it('runs the typed engine and request adapter in an actual kernel session', async () => {
    const provider = fakeProvider([textTurn('done')])
    const identities: string[] = []
    const k = base({
      provider,
      hooksFactory: (session) => {
        const engine = new HookEngine({
          onFailure: () => undefined,
          diag: (name, data) => session.diag(name, data),
          platform,
        })
        engine.on(
          'before_request',
          (_request, context) => {
            identities.push(context.session.key)
            expect(context.signal.aborted).toBe(false)
            return { patch: { maxTokens: 17 } }
          },
          { source: 'agnes/kernel-test', trust: 'trusted' },
        )
        return new SessionHookPort(engine, {
          context: () => ({
            session: { key: session.key, lane: session.lane, workspaceRoot: session.d.cwd },
            signal: session.ac.signal,
            replayed: false,
            // An explicit test grant; host's per-extension lease assembly is a separate acceptance.
            lease: { expiresAt: '2099-01-01T00:00:00Z', scope: {}, budget: { remaining: 1 } },
            log: session.d.logger,
          }),
          budget: () => ({ remaining: 0, cap: 0 }),
          surface: () =>
            session.surface().map((node) => ({
              seq: node.seq,
              type:
                node.kind === 'user'
                  ? 'user/message'
                  : node.kind === 'assistant'
                    ? 'assistant/message'
                    : node.kind === 'tool_result'
                      ? 'tool/result'
                      : 'summary',
              pinned: node.pinned,
            })),
          surfaceDigest: () => ({ nodes: session.surface().length, tokensEstimate: contextTokens(session) }),
          verifierTier: () => session.preset.verifier.defaultTier,
          contextOverflow: (data) => session.diag('hook-context-overflow', data),
          compactPlanIgnored: (data) => session.diag('hook-compact-plan-ignored', data),
        })
      },
    })
    const s = await k.session('actual', sessionOpts)
    await s.enqueue('next-turn', { content: [{ type: 'text', text: 'hello' }], actor })
    expect((await s.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(identities).toEqual(['actual'])
    expect(provider.requests[0]?.sampling?.maxTokens).toBe(17)
    const headers = await s.scan({ type: 'request/header', toSeq: s.lastSeq })
    expect(headers[0]?.data).toMatchObject({
      transforms: [{ event: 'before_request', ext: 'agnes/kernel-test' }],
    })
    await k.close()
  })
})

describe('turn hook registration snapshots', () => {
  const factory =
    (
      registry: HookRegistry,
      resources?: ResourceRegistry,
    ): NonNullable<Parameters<typeof Kernel.create>[0]['hooksFactory']> =>
    (session) =>
      new SessionHookPort(new HookEngine({ onFailure() {}, diag() {}, platform }, registry), {
        ...(resources
          ? {
              discovery: {
                registered: () => resources.snapshot(),
                actor: () => session.d.actor,
                cwd: () => session.d.cwd,
                principals: session.d.runtime,
              },
            }
          : {}),
        context: () => ({
          session: { key: session.key, lane: session.lane, workspaceRoot: session.d.cwd },
          signal: session.ac.signal,
          replayed: false,
          lease: { expiresAt: '2099-01-01T00:00:00Z', scope: {}, budget: { remaining: 1 } },
          log: logger,
        }),
        budget: () => ({ remaining: 10, cap: null }),
        surface: () => [],
        surfaceDigest: () => ({ nodes: 0, tokensEstimate: 0 }),
        verifierTier: () => 0,
        contextOverflow: (data) => session.diag('hook-context-overflow', data),
        compactPlanIgnored: (data) => session.diag('hook-compact-plan-ignored', data),
      })
  const source = { source: 'agnes/snapshot', trust: 'trusted' as const }

  it('keeps accepted-turn members across event types and adopts changes on the next actual turn', async () => {
    const registry = new HookRegistry(),
      provider = fakeProvider([textTurn('done')])
    const dispose = registry.on('before_request', () => ({ patch: { maxTokens: 17 } }), source)
    let changed = false
    registry.on(
      'before_step',
      () => {
        if (!changed) {
          changed = true
          dispose()
          registry.on('before_request', () => ({ patch: { maxTokens: 23 } }), source)
        }
        return {}
      },
      source,
    )
    const k = base({ provider, hooksFactory: factory(registry) }),
      s = await k.session('snapshots', sessionOpts)
    for (let turn = 0; turn < 2; turn++) {
      await s.enqueue('next-turn', { content: [{ type: 'text', text: 'hello' }], actor })
      expect((await s.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
    }
    expect(provider.requests.map((request) => request.sampling?.maxTokens)).toEqual([17, 23])
    expect((await s.scan({ type: 'request/header', toSeq: s.lastSeq })).map((row) => row.data)).toEqual([
      expect.objectContaining({ transforms: [{ event: 'before_request', ext: source.source }] }),
      expect.objectContaining({ transforms: [{ event: 'before_request', ext: source.source }] }),
    ])
    await k.close()
  })

  it('establishes a snapshot on reopening an interrupted turn and preserves it across repeated resume', async () => {
    const storage = new MemoryStorage(),
      first = base({ storage })
    const original = await first.session('recover-hooks', sessionOpts)
    await original.enqueue('next-turn', { content: [{ type: 'text', text: 'hello' }], actor })
    expect((await original.step()).phase).toBe('checkpoint')
    await first.close()
    const registry = new HookRegistry(),
      provider = fakeProvider([textTurn('done')])
    const dispose = registry.on('before_request', () => ({ patch: { maxTokens: 31 } }), source)
    const second = base({ storage, provider, hooksFactory: factory(registry) })
    const restored = await second.session('recover-hooks', { ...sessionOpts, writerRunId: 'r2' })
    await restored.resume()
    dispose()
    registry.on('before_request', () => ({ patch: { maxTokens: 47 } }), source)
    await restored.resume()
    expect((await restored.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(provider.requests[0]?.sampling?.maxTokens).toBe(31)
    await restored.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
    await restored.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(provider.requests[1]?.sampling?.maxTokens).toBe(47)
    await second.close()
  })

  it('emits real new/resume identities once and awaits one bounded shutdown before releasing the log', async () => {
    const storage = new MemoryStorage(),
      registry = new HookRegistry()
    const starts: unknown[] = [],
      shutdowns: unknown[] = []
    let release: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    registry.on(
      'session_start',
      (payload, context) => {
        starts.push({ payload, replayed: context.replayed, key: context.session.key })
      },
      source,
    )
    registry.on(
      'shutdown',
      async (payload, context) => {
        shutdowns.push(payload)
        expect(context.signal.aborted).toBe(false)
        await barrier
      },
      source,
    )
    const k = base({ storage, hooksFactory: factory(registry) })
    const s = await k.session('lifecycle', sessionOpts)
    expect(await k.session('lifecycle', sessionOpts)).toBe(s)
    expect(starts).toEqual([
      { payload: { reason: 'new', preset: s.preset.name, cwd: '/w' }, replayed: false, key: 'lifecycle' },
    ])
    const closing = s.close()
    expect(s.close()).toBe(closing)
    expect(s.ac.signal.aborted).toBe(true)
    let finished = false
    void closing.then(() => {
      finished = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(shutdowns).toEqual([{ reason: 'close' }])
    expect(finished).toBe(false)
    release()
    await closing
    await k.close()
    expect(shutdowns).toHaveLength(1)
    const reopened = base({ storage, hooksFactory: factory(registry) })
    const again = await reopened.session('lifecycle', { ...sessionOpts, writerRunId: 'r2' })
    expect(starts[1]).toEqual({
      payload: { reason: 'resume', preset: again.preset.name, cwd: '/w' },
      replayed: true,
      key: 'lifecycle',
    })
    expect(await again.scan({ type: 'session/start', toSeq: again.lastSeq })).toHaveLength(1)
    await reopened.close()
    expect(shutdowns).toHaveLength(2)
  })

  // An importer fills a brand-new ledger verbatim, and native rows point at each other by sequence
  // number: a hook's row at seq 2 would shift every one of them. A real session never loses its hooks.
  it('skips session_start only for a new session that asks, never for a resumed one', async () => {
    const storage = new MemoryStorage(),
      registry = new HookRegistry()
    const starts: string[] = []
    registry.on('session_start', (payload) => void starts.push(payload.reason), source)
    const k = base({ storage, hooksFactory: factory(registry) })
    const s = await k.session('verbatim', { ...sessionOpts, skipSessionStartHooks: true })
    expect(starts).toEqual([])
    expect(s.lastSeq).toBe(1)
    await k.close()
    const reopened = base({ storage, hooksFactory: factory(registry) })
    await reopened.session('verbatim', { ...sessionOpts, writerRunId: 'r2', skipSessionStartHooks: true })
    expect(starts).toEqual(['resume'])
    await reopened.close()
  })

  it('uses the protocol default shutdown timeout and releases the writer after a hanging cleanup', async () => {
    vi.useFakeTimers()
    try {
      const storage = new MemoryStorage(),
        registry = new HookRegistry()
      let signal: AbortSignal | undefined
      registry.on(
        'shutdown',
        (_p, context) => {
          signal = context.signal
          return new Promise<void>(() => undefined)
        },
        source,
      )
      const k = base({ storage, hooksFactory: factory(registry) }),
        s = await k.session('timeout-close', sessionOpts)
      let finished = false
      const closing = s.close().then(() => {
        finished = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(999)
      expect(finished).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await closing
      expect(signal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      await k.close()
      const next = base({ storage })
      await expect(
        next.session('timeout-close', { ...sessionOpts, writerRunId: 'r2' }),
      ).resolves.toHaveProperty('key', 'timeout-close')
      await next.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases the writer even when a lifecycle port fails', async () => {
    const storage = new MemoryStorage(),
      k = base({
        storage,
        hooksFactory: () => ({
          ...noopHooks,
          shutdown: async () => {
            throw new Error('cleanup failed')
          },
        }),
      })
    await k.session('failed-close', sessionOpts)
    await expect(k.close()).rejects.toThrow()
    const next = base({ storage })
    await expect(next.session('failed-close', { ...sessionOpts, writerRunId: 'r2' })).resolves.toHaveProperty(
      'key',
      'failed-close',
    )
    await next.close()
  })

  it('uses actual resource authorization and a shared context byte budget in a real provider request', async () => {
    const registry = new HookRegistry(),
      resources = new ResourceRegistry(),
      provider = fakeProvider([textTurn('done')])
    resources.register({ id: 'public', kind: 'skill', name: 'Public', description: 'Public' }, source)
    resources.register({ id: 'private', kind: 'skill', name: 'Private', description: 'Private' }, source)
    registry.on('resources_discover', () => ({ additionalContext: 'x'.repeat(8190) }), source)
    registry.on(
      'context',
      (p) => {
        expect(p.sections.find((section) => section.id === 'additional-context')?.content).toBe(
          'x'.repeat(8190),
        )
        return { additionalContext: 'YYYYY' }
      },
      source,
    )
    registry.on('context', () => ({ additionalContext: 'YYYYY' }), source)
    let port: SessionHookPort | undefined
    const build = factory(registry, resources)
    const k = base({
      provider,
      seams: fakeSeams({
        principals: {
          authorize: async (_a, action, target) => ({
            decisionId: target.id,
            effect: action === 'discover' && target.id === 'private' ? 'deny' : 'allow',
            reason: 'policy',
          }),
        },
      }),
      hooksFactory: (session, engine) => {
        port = build(session, engine) as SessionHookPort
        return port
      },
    })
    const session = await k.session('discover', sessionOpts)
    expect(port?.resources().map((resource) => resource.id)).toEqual(['public'])
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hello' }], actor })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(provider.requests[0]?.system).toContain(`${'x'.repeat(8190)}\nY`)
    expect(provider.requests[0]?.system).not.toContain('YY')
    const overflows = await session.scan({ type: 'x/core/hook-context-overflow', toSeq: session.lastSeq })
    expect(overflows.map((row) => row.data)).toEqual([{ ext: source.source, bytes: 5 }])
    await k.close()
    expect(port?.resources()).toEqual([])
  })
})

describe('extension event ledger entry', () => {
  const meta = { source: 'agnes/event-test', trust: 'trusted' as const }
  const type = 'x/agnes/event-test/note'

  it('stamps the actual trigger actor and confines caller fields to detached event data', async () => {
    const k = base(),
      session = await k.session('events', sessionOpts)
    const idle = await session.appendExtensionEvent(type, { note: 'idle' }, meta)
    expect((await session.scan({ fromSeq: idle, toSeq: idle }))[0]?.actor.id).toBe('system')
    const sender = { ...actor, id: 'actual-sender' }
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hello' }], actor: sender })
    await session.step()
    const data = { nested: { value: 1 }, origin: 'system', trust: 'trusted', actor: 'forged' }
    const pending = session.appendExtensionEvent(type, data, meta)
    data.nested.value = 2
    const seq = await pending
    const row = (await session.scan({ fromSeq: seq, toSeq: seq }))[0]
    expect(row).toMatchObject({
      type,
      origin: 'ext:agnes/event-test',
      trust: 'untrusted',
      lane: 'main',
      ignorable: true,
      actor: sender,
      data: { nested: { value: 1 }, origin: 'system', trust: 'trusted', actor: 'forged' },
    })
    expect(session.surface().map((node) => node.seq)).not.toContain(seq)
    await k.close()
  })

  it('enforces the default 200 committed rows across concurrency and reopen, then resets on a new turn', async () => {
    const storage = new MemoryStorage(),
      k = base({ storage }),
      session = await k.session('quota-events', sessionOpts)
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hello' }], actor })
    await session.step()
    const outcomes = await Promise.allSettled(
      Array.from({ length: 205 }, (_, n) => session.appendExtensionEvent(type, { n }, meta)),
    )
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(200)
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(5)
    expect(await session.scan({ type, toSeq: session.lastSeq })).toHaveLength(200)
    await k.close()
    const resumed = base({ storage }),
      again = await resumed.session('quota-events', { ...sessionOpts, writerRunId: 'r2' })
    await again.resume()
    await expect(again.appendExtensionEvent(type, {}, meta)).rejects.toThrow('quota exceeded')
    await again.endTurn('completed')
    await again.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
    await again.step()
    await expect(again.appendExtensionEvent(type, {}, meta)).resolves.toBeGreaterThan(0)
    await resumed.close()
  })

  it('refuses invalid namespace and JSON synchronously without reading accessors or writing rows', async () => {
    const k = base(),
      session = await k.session('invalid-events', sessionOpts),
      before = session.lastSeq
    expect(() => session.appendExtensionEvent('x/other/ext/note', {}, meta)).toThrow()
    expect(() => session.appendExtensionEvent('x/agnes/event-test/Bad', {}, meta)).toThrow()
    expect(() => session.appendExtensionEvent(type, { value: 'x'.repeat(65536) }, meta)).toThrow()
    let reads = 0
    expect(() =>
      session.appendExtensionEvent(
        type,
        {
          get secret() {
            reads++
            return 'private'
          },
        },
        meta,
      ),
    ).toThrow()
    expect(reads).toBe(0)
    expect(session.lastSeq).toBe(before)
    await k.close()
  })

  it('does not spend a committed-event slot when storage refuses the write', async () => {
    const storage = new MemoryStorage(),
      preset = presetDefaults()
    preset.ext.eventsPerTurn = 1
    const k = base({ storage, preset }),
      session = await k.session('refused-event', sessionOpts)
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hello' }], actor })
    await session.step()
    const commit = storage.commit.bind(storage)
    let refuse = true
    storage.commit = async (...args) => {
      if (refuse) {
        refuse = false
        throw new CoreError('E_CAS', 'synthetic refusal')
      }
      return commit(...args)
    }
    await expect(session.appendExtensionEvent(type, {}, meta)).rejects.toThrow('synthetic refusal')
    await expect(session.appendExtensionEvent(type, {}, meta)).resolves.toBeGreaterThan(0)
    await expect(session.appendExtensionEvent(type, {}, meta)).rejects.toThrow('quota exceeded')
    await k.close()
  })
})

it.each(['standard', 'code'] as const)(
  'refuses registered undisclosed model calls before execution in %s',
  async (mode) => {
    let executed = 0,
      hooks = 0
    const hidden = readTool(async () => {
      executed++
      return { content: [] }
    }) as ToolDef
    const classify = vi.fn(() => ({
      isReadOnly: true,
      isDestructive: false,
      replay: 'safe' as const,
      requiresApproval: 'never' as const,
      approvalScopes: [],
    }))
    hidden.policyVersion = 'hidden-v1'
    hidden.classify = classify as NonNullable<ToolDef['classify']>
    if (mode === 'standard') hidden.meta = { ...hidden.meta, deferLoading: true }
    const provider = fakeProvider([toolTurn('read', { path: '/w/a' })])
    const k = base({
      provider,
      ...(mode === 'code' ? { preset: { ...presetDefaults(), disclosure: 'code' as const } } : {}),
      hooks: {
        ...noopHooks,
        async toolCall() {
          hooks++
          return { allow: true }
        },
      },
    })
    k.tools.add(hidden, {
      source: 'fixture/tools',
      trust: 'trusted',
      packageIdentity: 'fixture/tools',
      packageVersion: '1.0.0',
    })
    if (mode === 'code')
      k.tools.add(
        { ...(readTool() as ToolDef), name: 'run_code' },
        { source: 'fixture/code', trust: 'trusted' },
      )
    const s = await k.session('undisclosed', sessionOpts)
    try {
      await s.enqueue('next-turn', { content: [{ type: 'text', text: 'try hidden' }], actor })
      await s.acceptInput()
      await s.runInference()
      await s.runToolsPhase()
      expect(provider.requests[0]?.tools.map((t) => t.name)).toEqual(mode === 'code' ? ['run_code'] : [])
      expect(executed).toBe(0)
      expect(hooks).toBe(0)
      expect(classify).not.toHaveBeenCalled()
      const results = await s.scan({ type: 'tool/result', toSeq: s.lastSeq })
      expect(results).toHaveLength(1)
      expect(results[0]?.data).toMatchObject({ code: 'TOOL_NOT_DISCLOSED', isError: true })
    } finally {
      await k.close()
    }
  },
)
it('keeps refused calls settled across actual Kernel reopen and preserves mixed-batch argument positions', async () => {
  const storage = new MemoryStorage(),
    seen: unknown[] = []
  let hiddenCalls = 0
  const hidden = {
    ...(readTool(async () => {
      hiddenCalls++
      return { content: [] }
    }) as ToolDef),
    name: 'hidden',
  }
  hidden.meta = { ...hidden.meta, deferLoading: true }
  const read = readTool(async (args) => {
    seen.push(args)
    return { content: [] }
  }) as ToolDef
  const script = toolTurn('hidden', { path: '/w/hidden' })
  script.splice(script.length - 1, 0, {
    type: 'toolcall_end',
    call: { toolUseId: '', name: 'read', args: { path: '/w/allowed' }, ordinal: 1 },
    via: 'native',
  })
  const k = base({ storage, provider: fakeProvider([script]) })
  for (const t of [hidden, read]) k.tools.add(t, { source: 'fixture/tools', trust: 'trusted' })
  const s = await k.session('mixed', { ...sessionOpts, workspaceInvocation: testWorkspaceInvocation() })
  await s.enqueue('next-turn', { content: [{ type: 'text', text: 'mixed' }], actor })
  await s.acceptInput()
  await s.runInference()
  expect((await s.scan({ type: 'tool/result', toSeq: s.lastSeq }))[0]?.data).toMatchObject({
    code: 'TOOL_NOT_DISCLOSED',
  })
  expect(hiddenCalls).toBe(0)
  expect(seen).toEqual([])
  await k.close()
  const reopened = base({ storage })
  for (const t of [hidden, read]) reopened.tools.add(t, { source: 'fixture/tools', trust: 'trusted' })
  try {
    const restored = await reopened.session('mixed', {
      ...sessionOpts,
      writerRunId: 'next',
      workspaceInvocation: testWorkspaceInvocation(),
    })
    await restored.step()
    expect(hiddenCalls).toBe(0)
    expect(seen).toEqual([{ path: '/w/allowed' }])
    const results = await restored.scan({ type: 'tool/result', toSeq: restored.lastSeq })
    expect(results).toHaveLength(2)
    expect(results.filter((r) => (r.data as { code?: string }).code === 'TOOL_NOT_DISCLOSED')).toHaveLength(1)
  } finally {
    await reopened.close()
  }
})

it.each(['standard', 'hybrid', 'code'] as const)(
  'keeps %s disclosure consistent despite broader Operation contributions',
  async (mode) => {
    const provider = fakeProvider([textTurn('ok')])
    const k = base({
      provider,
      ...(mode === 'standard' ? {} : { preset: { ...presetDefaults(), disclosure: mode } }),
      operations: [
        {
          name: 'broader',
          slot: 'before-inference',
          replay: 'safe',
          applicable: async () => 'applied',
          run: async () => ({}),
          contribute: () => ({ tools: ['read', 'shell', 'run_code', 'later'] }),
        },
      ],
    })
    for (const name of ['read', 'shell', 'run_code', 'later']) {
      const def = { ...(readTool() as ToolDef), name }
      def.meta = { ...def.meta, deferLoading: name === 'later' }
      k.tools.add(def, { source: 'fixture/tools', trust: 'trusted' })
    }
    try {
      const s = await k.session('policy', sessionOpts)
      await s.enqueue('next-turn', { content: [{ type: 'text', text: 'policy' }], actor })
      await s.acceptInput()
      await s.runInference()
      const expected =
        mode === 'code' ? ['run_code'] : mode === 'hybrid' ? ['read', 'run_code', 'shell'] : ['read', 'shell']
      expect(provider.requests[0]?.tools.map((t) => t.name).sort()).toEqual(expected)
    } finally {
      await k.close()
    }
  },
)
it.each([false, true])(
  'refuses missing or deferred code runtime before provider use (deferred=%s), then recovers on a new turn',
  async (deferred) => {
    const provider = fakeProvider([textTurn('ready')]),
      k = base({ provider, preset: { ...presetDefaults(), disclosure: 'code' } })
    k.tools.add(readTool(), { source: 'fixture/tools', trust: 'trusted' })
    let remove: (() => void) | undefined
    if (deferred) {
      const def = { ...(readTool() as ToolDef), name: 'run_code' }
      def.meta = { ...def.meta, deferLoading: true }
      remove = k.tools.add(def, { source: 'fixture/code', trust: 'trusted' })
    }
    try {
      const s = await k.session('runtime-missing', sessionOpts)
      await s.enqueue('next-turn', { content: [{ type: 'text', text: 'try' }], actor })
      await s.acceptInput()
      expect(await s.runInference()).toEqual({ phase: 'terminal', reason: 'error' })
      expect(provider.calls).toBe(0)
      const rows = await s.scan({ type: 'turn/end', toSeq: s.lastSeq })
      expect(rows[0]?.data).toMatchObject({ reason: 'error', error: { code: 'CODE_RUNTIME_UNAVAILABLE' } })
      remove?.()
      k.tools.add(
        { ...(readTool() as ToolDef), name: 'run_code' },
        { source: 'fixture/code', trust: 'trusted' },
      )
      await s.enqueue('next-turn', { content: [{ type: 'text', text: 'retry' }], actor })
      await s.acceptInput()
      await s.runInference()
      expect(provider.calls).toBe(1)
      expect(provider.requests[0]?.tools.map((t) => t.name)).toEqual(['run_code'])
    } finally {
      await k.close()
    }
  },
)

it('reopens a closed session in the same Kernel only after its shutdown has completed', async () => {
  const k = base()
  const old = await k.session('reopen', sessionOpts)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const closing = new Promise<void>((resolve) => {
    started = resolve
  })
  old.hooks = {
    ...noopHooks,
    shutdown: async () => {
      started()
      await gate
    },
  }
  const closed = old.close()
  await closing
  let settled = false
  const reopened = k.session('reopen', { ...sessionOpts, writerRunId: 'r2' }).then((session) => {
    settled = true
    return session
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  release()
  await closed
  const fresh = await reopened
  expect(fresh).not.toBe(old)
  expect(fresh.writerRunId).toBe('r2')
  expect(k.get('reopen')).toBe(fresh)
  expect(
    (await fresh.scan({ fromSeq: 1, limit: 10 })).filter((e) => e.type === 'session/start'),
  ).toHaveLength(1)
  await k.close()
})
it('does not bypass failed session shutdown when reopening a cached key', async () => {
  const k = base()
  const old = await k.session('failed-reopen', sessionOpts)
  old.hooks = {
    ...noopHooks,
    shutdown: async () => {
      throw new Error('shutdown failed')
    },
  }
  await expect(old.close()).rejects.toThrow('shutdown failed')
  await expect(k.session('failed-reopen', { ...sessionOpts, writerRunId: 'r2' })).rejects.toThrow(
    'shutdown failed',
  )
  expect(k.get('failed-reopen')).toBe(old)
  await expect(k.close()).rejects.toThrow('shutdown failed')
})

describe('Kernel (registries wiring — Task 37b)', () => {
  const meta = (name: string) => ({ source: `agnes/${name}`, trust: 'builtin' as const })

  it('dispatches registered lifecycle hooks once when a session port uses the shared registry', async () => {
    const starts: string[] = [],
      shutdowns: string[] = []
    const kernel = base({
      hooksFactory: (session, engine: HookEngine) =>
        new SessionHookPort(engine, {
          context: () => ({
            session: { key: session.key, lane: session.lane, workspaceRoot: session.d.cwd },
            signal: session.ac.signal,
            replayed: false,
            lease: { expiresAt: '2099-01-01T00:00:00Z', scope: {}, budget: { remaining: 10 } },
            log: logger,
          }),
          budget: () => ({ remaining: 10, cap: null }),
          surface: () => [],
          surfaceDigest: () => ({ nodes: 0, tokensEstimate: 0 }),
          verifierTier: () => 0,
          contextOverflow: () => undefined,
          compactPlanIgnored: () => undefined,
        }),
    })
    kernel.hooks.on(
      'session_start',
      (_payload, context) => {
        starts.push(context.session.key)
      },
      meta('once'),
    )
    kernel.hooks.on(
      'shutdown',
      (_payload, context) => {
        shutdowns.push(context.session.key)
      },
      meta('once'),
    )

    const session = await kernel.session('once', sessionOpts)
    expect(starts).toEqual(['once'])
    await session.close()
    expect(shutdowns).toEqual(['once'])
    await kernel.close()
    expect(starts).toEqual(['once'])
    expect(shutdowns).toEqual(['once'])
  })

  it('keeps lifecycle hook quota independent for each session', async () => {
    const preset = presetDefaults()
    preset.ext.eventsPerTurn = 1
    const kernel = base({ preset })
    const starts: string[] = []
    kernel.hooks.on(
      'session_start',
      (_payload, context) => {
        starts.push(context.session.key)
      },
      meta('quota'),
    )

    await kernel.session('quota-a', sessionOpts)
    await kernel.session('quota-b', { ...sessionOpts, writerRunId: 'r2' })
    expect(starts).toEqual(['quota-a', 'quota-b'])
    await kernel.close()
  })

  // Regression pin for the computed-once-per-Kernel, assembly-time frozen snapshot: each session opened on the same Kernel gets its OWN HookEngine instance
  // (createHookEngine runs again per session), but every one of those instances must be handed the
  // exact same platform object Kernel computed once at construction. A future "fix" that moves the
  // platformFacts(...) call from the constructor into createHookEngine (recomputing it per session)
  // would still pass every existing assertion that checks the platform's *value* - only a reference
  // check across two sessions catches it, which is what this test is for.
  it('hands two sessions on the same Kernel the identical (toBe) platform object, not merely an equal one', async () => {
    const kernel = base()
    const seen: unknown[] = []
    kernel.hooks.on(
      'session_start',
      (_payload, context) => {
        seen.push(context.platform)
      },
      meta('platform-once'),
    )

    await kernel.session('platform-a', sessionOpts)
    await kernel.session('platform-b', { ...sessionOpts, writerRunId: 'r2' })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
    expect(seen[0]).toEqual({
      shell: 'posix',
      fs: { caseSensitive: true, pathSep: '/' },
      terminal: { color: false },
    })
    await kernel.close()
  })

  it('registers core invariants and dispatches session_start (new, then resume) through its own hooks engine', async () => {
    const storage = new MemoryStorage()
    const k = base({ storage })
    expect(k.invariants.packages()).toEqual([{ pkg: '@agnes/core', checks: expect.any(Number) }])
    const seen: unknown[] = []
    k.hooks.on(
      'session_start',
      async (payload, ctx) => {
        seen.push({ ...payload, key: ctx.session.key, replayed: ctx.replayed })
      },
      meta('t'),
    )
    const s = await k.session('k1', sessionOpts)
    expect(seen).toEqual([{ reason: 'new', preset: s.preset.name, cwd: '/w', key: 'k1', replayed: false }])
    await k.close()

    const k2 = base({ storage })
    const replayed: unknown[] = []
    k2.hooks.on(
      'session_start',
      async (payload, ctx) => {
        replayed.push({ ...payload, key: ctx.session.key, replayed: ctx.replayed })
      },
      meta('t'),
    )
    const again = await k2.session('k1', { ...sessionOpts, writerRunId: 'r2' })
    expect(replayed).toEqual([
      { reason: 'resume', preset: again.preset.name, cwd: '/w', key: 'k1', replayed: true },
    ])
    await k2.close()
  })

  it('dispatches resources_discover on resume only, carrying the actor, cwd and currently registered resources', async () => {
    const storage = new MemoryStorage()
    const entry = { id: 'r1', kind: 'skill' as const, name: 'R1', description: 'R1' }
    const first = base({ storage })
    first.resources.register(entry, meta('t'))
    const freshDiscover: unknown[] = []
    first.hooks.on(
      'resources_discover',
      async (p) => {
        freshDiscover.push(p)
        return {}
      },
      meta('t'),
    )
    await first.session('k1', sessionOpts)
    // A brand-new session has nothing to reconcile discovery against yet, so the kernel only fires
    // resources_discover on reopen — mirroring HOOK_TABLE's `replayOnResume` intent for this event.
    expect(freshDiscover).toEqual([])
    await first.close()

    const second = base({ storage })
    second.resources.register(entry, meta('t'))
    const seen: Array<{ actorId: string; cwd: string; registered: string[] }> = []
    second.hooks.on(
      'resources_discover',
      async (p) => {
        seen.push({ actorId: p.actor.id, cwd: p.cwd, registered: p.registered.map((r) => r.id) })
        return {}
      },
      meta('t'),
    )
    await second.session('k1', { ...sessionOpts, writerRunId: 'r2' })
    expect(seen).toEqual([{ actorId: sessionOpts.actor.id, cwd: '/w', registered: ['r1'] }])
    await second.close()
  })

  it('dispatches shutdown through its own hooks engine once per session before it actually closes', async () => {
    const k = base()
    const shutdowns: unknown[] = []
    k.hooks.on(
      'shutdown',
      async (payload, ctx) => {
        shutdowns.push({ ...payload, key: ctx.session.key })
      },
      meta('t'),
    )
    await k.session('k1', sessionOpts)
    await k.close()
    expect(shutdowns).toEqual([{ reason: 'close', key: 'k1' }])
  })

  it('slots and resources registries round-trip register/registrations on the Kernel', () => {
    const k = base()
    const disposeSlot = k.slots.register('status.line', () => ({ text: 's', level: 'info' }), meta('ext-a'))
    const disposeResource = k.resources.register(
      { id: 'skill-1', kind: 'skill', name: 'Skill 1', description: 'desc' },
      meta('ext-a'),
    )
    expect(k.slots.registrations('agnes/ext-a')).toEqual(['slot:status.line'])
    expect(k.resources.registrations('agnes/ext-a')).toEqual(['resource:skill-1'])
    disposeSlot()
    disposeResource()
    expect(k.slots.registrations('agnes/ext-a')).toEqual([])
    expect(k.resources.registrations('agnes/ext-a')).toEqual([])
  })

  it('registrations(source) aggregates tool, hook, slot and resource registrations under one source', () => {
    const k = base()
    k.hooks.on('shutdown', async () => undefined, meta('ext-b'))
    k.slots.register('notification', () => ({ title: 'n', body: 'b' }), meta('ext-b'))
    k.resources.register({ id: 'r2', kind: 'skill', name: 'R2', description: 'd' }, meta('ext-b'))
    k.tools.add(readTool(), meta('ext-b'))
    // Registered under a different source, to prove the aggregation actually filters by source.
    k.hooks.on('shutdown', async () => undefined, meta('other'))
    expect(k.registrations('agnes/ext-b').sort()).toEqual(
      ['tool:read', 'hook:shutdown', 'resource:r2', 'slot:notification'].sort(),
    )
    expect(k.registrations('agnes/other')).toEqual(['hook:shutdown'])
  })

  it('invalidates every live session seam cache after a provider change', async () => {
    const k = base()
    const first = await k.session('cache-a', sessionOpts)
    const second = await k.session('cache-b', { ...sessionOpts, writerRunId: 'r2' })
    const firstInvalidate = vi.spyOn(first.d.runtime, 'invalidate')
    const secondInvalidate = vi.spyOn(second.d.runtime, 'invalidate')

    k.invalidateSeams()

    expect(firstInvalidate).toHaveBeenCalledOnce()
    expect(secondInvalidate).toHaveBeenCalledOnce()
    await k.close()
  })
})
