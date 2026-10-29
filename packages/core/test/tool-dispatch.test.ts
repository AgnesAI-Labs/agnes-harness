import { presetDefaults } from '@agnes/core-common/step/preset'
import {
  dispatchTool,
  type HostToolDispatchInput,
  type HostToolDispatchPort,
} from '@agnes/core-effects/effects/tool-dispatch'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { describe, expect, it, vi } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, openSession, testFsOps } from './helpers/open-session.js'

const result = { content: [{ type: 'text' as const, text: 'ok' }] }

describe('tool dispatch attestation', () => {
  it.each([
    ['ordinary result', result],
    [
      'projection-backed answer',
      {
        ...result,
        details: Object.assign(Object.create(null), {
          answers: Object.assign(Object.create(null), { format: 'Markdown' }),
        }),
      },
    ],
  ])('bypasses the Host port for workspace tools with %s', async (_name, result) => {
    const hostPort: HostToolDispatchPort = { dispatch: vi.fn() }
    const invoke = vi.fn(async () => result)

    await expect(
      dispatchTool({
        name: 'read',
        args: {},
        context: {} as never,
        attempt: 1,
        executionDomain: 'workspace',
        hostPort,
        invoke,
      }),
    ).resolves.toEqual({ phase: 'responded', result })
    expect(invoke).toHaveBeenCalledOnce()
    expect(hostPort.dispatch).not.toHaveBeenCalled()
  })

  it.each([
    { code: 'INVALID_PARAMS', message: 'invalid', issues: [{ path: '$.x' }] },
    { code: 'INVALID_PARAMS', message: 'invalid', expected: 1 },
    { code: 'INVALID_PARAMS', message: 'invalid', effect: 'none' },
    { code: 'INVALID_PARAMS', message: 'x'.repeat(4097) },
    {
      code: 'INVALID_PARAMS',
      message: 'invalid',
      issues: Array(9).fill({ path: '$.x', expected: 'string' }),
    },
    new Error('INVALID_PARAMS'),
  ])('keeps an invalid platform preflight diagnostic uncertain (%#)', async (diagnostic) => {
    const invoke = vi.fn(async () => result)
    const observation = await dispatchTool({
      name: 'synthetic_write',
      args: {},
      context: {} as never,
      attempt: 1,
      executionDomain: 'workspace',
      invoke,
      hostPort: { preflight: async () => diagnostic, dispatch: vi.fn() },
    })
    expect(observation.phase).toBe('may_have_sent')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not classify an author throw by its error code after platform preflight passes', async () => {
    const claim = Object.assign(new Error('invalid'), {
      code: 'INVALID_PARAMS',
      path: '$.x',
      expected: 'string',
      effect: 'none',
    })
    const observation = await dispatchTool({
      name: 'synthetic_write',
      args: {},
      context: {} as never,
      attempt: 1,
      executionDomain: 'workspace',
      invoke: async () => {
        throw claim
      },
      hostPort: { preflight: async () => undefined, dispatch: vi.fn() },
    })
    expect(observation).toEqual({ phase: 'may_have_sent', error: claim })
  })

  it('does not let a tool result forge a dispatch phase', async () => {
    const forged = { ...result, phase: 'not_sent', error: new Error('forged') }
    const observation = await dispatchTool({
      name: 'read',
      args: {},
      context: {} as never,
      attempt: 1,
      executionDomain: 'workspace',
      invoke: async () => forged as never,
    })

    expect(observation.phase).toBe('may_have_sent')
  })

  it.each([
    { callback: () => undefined },
    Object.assign(Object.create(null), { callback: () => undefined }),
    new Date(),
    new (class Payload {
      value = 'not a JSON dictionary'
    })(),
  ])('rejects non-wire-safe structured results at runtime (%#)', async (structured) => {
    const observation = await dispatchTool({
      name: 'read',
      args: {},
      context: {} as never,
      attempt: 1,
      executionDomain: 'workspace',
      invoke: async () => ({ ...result, structured }),
    })

    expect(observation.phase).toBe('may_have_sent')
  })

  it('preserves the closed deferred-job marker and rejects malformed markers', async () => {
    const deferred = { ...result, deferred: { jobId: 'job-1' } }
    await expect(
      dispatchTool({
        name: 'delegate',
        args: {},
        context: {} as never,
        attempt: 1,
        executionDomain: 'workspace',
        invoke: async () => deferred,
      }),
    ).resolves.toEqual({ phase: 'responded', result: deferred })

    for (const marker of [{}, { jobId: '' }, { jobId: 'job-1', extra: true }]) {
      const observation = await dispatchTool({
        name: 'delegate',
        args: {},
        context: {} as never,
        attempt: 1,
        executionDomain: 'workspace',
        invoke: async () => ({ ...result, deferred: marker }) as never,
      })
      expect(observation.phase).toBe('may_have_sent')
    }
  })

  it('downgrades port throws and malformed observations to may_have_sent', async () => {
    const thrown = new Error('transport vanished')
    const throwing = await dispatchTool({
      name: 'computer',
      args: {},
      context: {} as never,
      attempt: 1,
      executionDomain: 'host-computer-use',
      hostPort: { dispatch: async () => Promise.reject(thrown) },
      invoke: async () => result,
    })
    expect(throwing).toEqual({ phase: 'may_have_sent', error: thrown })

    const malformed = await dispatchTool({
      name: 'computer',
      args: {},
      context: {} as never,
      attempt: 1,
      executionDomain: 'host-computer-use',
      hostPort: { dispatch: async () => ({ phase: 'responded', result: { content: 'bad' } }) },
      invoke: async () => result,
    })
    expect(malformed.phase).toBe('may_have_sent')
  })

  it('accepts not_sent only from the trusted port, including a zero-byte connection failure', async () => {
    const safe = await dispatchTool({
      name: 'computer',
      args: {},
      context: {} as never,
      attempt: 1,
      executionDomain: 'host-computer-use',
      hostPort: { dispatch: async () => ({ phase: 'not_sent', error: new Error('offline') }) },
      invoke: async () => result,
    })
    expect(safe.phase).toBe('not_sent')

    const zeroByteAfterEntry = await dispatchTool({
      name: 'computer',
      args: {},
      context: {} as never,
      attempt: 1,
      executionDomain: 'host-computer-use',
      hostPort: {
        dispatch: async (input) => {
          await input.invoke()
          return { phase: 'not_sent', error: new Error('late') }
        },
      },
      invoke: async () => result,
    })
    expect(zeroByteAfterEntry.phase).toBe('not_sent')
  })

  it('rejects result content that cannot be committed to the ledger envelope', async () => {
    const text = await dispatchTool({
      name: 'read',
      args: {},
      context: {} as never,
      attempt: 1,
      executionDomain: 'workspace',
      invoke: async () => ({ content: [{ type: 'text', text: 'x'.repeat(1_048_577) }] }),
    })
    expect(text.phase).toBe('may_have_sent')

    const mime = await dispatchTool({
      name: 'read',
      args: {},
      context: {} as never,
      attempt: 1,
      executionDomain: 'workspace',
      invoke: async () => ({
        content: [
          {
            type: 'ref',
            ref: { sha256: 'a'.repeat(64), size: 1, mime: 'x'.repeat(129) },
          },
        ],
      }),
    })
    expect(mime.phase).toBe('may_have_sent')
  })
})

describe('session dispatch plumbing', () => {
  it('passes the Kernel-owned Host port into each assembled session', async () => {
    const hostToolDispatch: HostToolDispatchPort = {
      dispatch: async () => ({ phase: 'not_sent', error: new Error('unused') }),
    }
    const kernel = Kernel.create({
      loops: defaultLoops(),
      storage: new MemoryStorage(),
      seams: fakeSeams(),
      provider: fakeProvider([]),
      contract: { contract_id: null, parser_version: '1' },
      preset: presetDefaults(),
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      timers: noTimers,
      hostToolDispatch,
    })
    const session = await kernel.session('dispatch-kernel', {
      actor,
      resolvedProfileHash: 'profile-hash',
      cwd: '/w',
      writerRunId: 'writer-1',
    })

    expect(session.d.hostToolDispatch).toBe(hostToolDispatch)
    expect(() => session.assertToolDispatchAvailable('host-computer-use')).not.toThrow()
    await kernel.close()
  })

  it('exposes a pre-effect guard for a missing Host port', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    expect(() => session.assertToolDispatchAvailable('workspace')).not.toThrow()
    expect(() => session.assertToolDispatchAvailable('host-computer-use')).toThrow(/dispatch port/)
    await session.close()
  })

  it('binds attempts into the permit and Host port input', async () => {
    const attempts: number[] = []
    const hostToolDispatch: HostToolDispatchPort = {
      async dispatch(input: HostToolDispatchInput) {
        attempts.push(input.attempt)
        if (input.attempt === 1) return { phase: 'not_sent', error: new Error('not started') }
        return { phase: 'responded', result: await input.invoke() }
      },
    }
    const { session } = await openSession({ provider: fakeProvider([]), hostToolDispatch })
    const started = { effectId: 'effect-1', startSeq: 1 as never }

    await expect(
      session.executeTool(
        'computer',
        {},
        { signal: new AbortController().signal, session: { toolUseId: 'computer-1' } } as never,
        started,
        async () => result,
        {
          executionDomain: 'host-computer-use',
          attempt: 1,
        },
      ),
    ).resolves.toMatchObject({ phase: 'not_sent' })
    await expect(
      session.executeTool(
        'computer',
        {},
        { signal: new AbortController().signal, session: { toolUseId: 'computer-1' } } as never,
        started,
        async () => result,
        {
          executionDomain: 'host-computer-use',
          attempt: 2,
        },
      ),
    ).resolves.toEqual({ phase: 'responded', result })
    expect(attempts).toEqual([1, 2])
    await session.close()
  })

  it('restores a consumed attempt without minting dispatch authority', async () => {
    const attempts: number[] = []
    const hostToolDispatch: HostToolDispatchPort = {
      async dispatch(input) {
        attempts.push(input.attempt)
        return { phase: 'responded', result: await input.invoke() }
      },
    }
    const { session } = await openSession({ provider: fakeProvider([]), hostToolDispatch })
    session.restoreToolDispatchAttempt('effect-restored', 7 as never, 1)

    await expect(
      session.executeTool(
        'computer',
        {},
        { signal: new AbortController().signal, session: { toolUseId: 'computer-restored' } } as never,
        { effectId: 'effect-restored', startSeq: 7 as never },
        async () => result,
        { executionDomain: 'host-computer-use', attempt: 2 },
      ),
    ).resolves.toEqual({ phase: 'responded', result })
    expect(attempts).toEqual([2])
    await session.close()
  })
})

describe('tool result budget', () => {
  const dispatchWorkspace = (output: unknown, outputMaxBytes = 1024) =>
    dispatchTool({
      name: 'read',
      args: {},
      context: { outputMaxBytes } as never,
      attempt: 1,
      executionDomain: 'workspace',
      invoke: async () => output as never,
    })

  it('bounds the total text across blocks before the result is accepted', async () => {
    const chunk = 'x'.repeat(1_048_576)
    const observation = await dispatchWorkspace({
      content: Array.from({ length: 128 }, () => ({ type: 'text', text: chunk })),
    })
    expect(observation.phase).toBe('responded')
    if (observation.phase !== 'responded') return
    const text = observation.result.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(text.length).toBeLessThan(1024 + 200)
    expect(text).toContain('[output truncated')
  })

  it('caps block count and replaces over-deep or over-large structured data with a marker', async () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 100; i++) deep = { next: deep }
    const observation = await dispatchWorkspace({
      content: Array.from({ length: 1000 }, () => ({ type: 'text', text: '' })),
      structured: deep,
      details: { blob: 'y'.repeat(1_000_000) },
    })
    expect(observation.phase).toBe('responded')
    if (observation.phase !== 'responded') return
    expect(observation.result.content.length).toBeLessThanOrEqual(256)
    expect(observation.result.structured).toEqual({ truncated: true })
    expect(observation.result.details).toEqual({ truncated: true })
  })

  it('counts multi-byte text as UTF-8 bytes, not characters', async () => {
    const observation = await dispatchWorkspace(
      {
        content: [
          { type: 'text', text: '中'.repeat(4096) },
          { type: 'text', text: '文'.repeat(4096) },
        ],
      },
      4096,
    )
    expect(observation.phase).toBe('responded')
    if (observation.phase !== 'responded') return
    const [first, second] = observation.result.content
    expect(first?.type === 'text' && Buffer.byteLength(first.text)).toBeLessThanOrEqual(4096)
    expect(second?.type === 'text' && second.text.startsWith('[output truncated')).toBe(true)
  })

  it('replaces structured data that is over the byte cap only once JSON escaping is counted', async () => {
    const observation = await dispatchWorkspace({
      content: [],
      structured: { quotes: '"'.repeat(200_000) },
    })
    expect(observation.phase).toBe('responded')
    if (observation.phase !== 'responded') return
    expect(observation.result.structured).toEqual({ truncated: true })
  })

  it('rejects a very wide array without enumerating it', async () => {
    const wide = new Proxy([] as unknown[], {
      get: (target, key) => (key === 'length' ? 5_000_000 : Reflect.get(target, key)),
    })
    let reads = 0
    const counted = new Proxy(wide, {
      get: (target, key, receiver) => {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++
        return Reflect.get(target, key, receiver)
      },
    })
    const observation = await dispatchWorkspace({ content: [], structured: counted })
    expect(observation.phase).toBe('responded')
    if (observation.phase !== 'responded') return
    expect(observation.result.structured).toEqual({ truncated: true })
    expect(reads).toBeLessThanOrEqual(50_001)
  })

  it('leaves an in-budget result untouched', async () => {
    const small = { content: [{ type: 'text', text: 'ok' }], structured: { a: 1 } }
    const observation = await dispatchWorkspace(small)
    expect(observation).toEqual({ phase: 'responded', result: small })
  })
})
