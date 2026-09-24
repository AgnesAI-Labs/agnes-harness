import { describe, expect, it, vi } from 'vitest'
import {
  dispatchTool,
  type HostToolDispatchInput,
  type HostToolDispatchPort,
} from '../src/effects/tool-dispatch.js'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, openSession, testFsOps } from './helpers/open-session.js'

const result = { content: [{ type: 'text' as const, text: 'ok' }] }

describe('tool dispatch attestation', () => {
  it('bypasses the Host port for workspace tools', async () => {
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

  it('rejects non-wire-safe structured results at runtime', async () => {
    const observation = await dispatchTool({
      name: 'read',
      args: {},
      context: {} as never,
      attempt: 1,
      executionDomain: 'workspace',
      invoke: async () => ({ ...result, structured: { callback: () => undefined } }),
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
      session.executeTool('computer', {}, {} as never, started, async () => result, {
        executionDomain: 'host-computer-use',
        attempt: 1,
      }),
    ).resolves.toMatchObject({ phase: 'not_sent' })
    await expect(
      session.executeTool('computer', {}, {} as never, started, async () => result, {
        executionDomain: 'host-computer-use',
        attempt: 2,
      }),
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
        {} as never,
        { effectId: 'effect-restored', startSeq: 7 as never },
        async () => result,
        { executionDomain: 'host-computer-use', attempt: 2 },
      ),
    ).resolves.toEqual({ phase: 'responded', result })
    expect(attempts).toEqual([2])
    await session.close()
  })
})
