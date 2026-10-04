import type { ToolContext } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { ExecutePermitRegistry } from '../src/effects/execute-permits.js'
import {
  type HumanWaitScope,
  humanWaitParent,
  withManagedHumanWait,
} from '../src/effects/managed-human-wait.js'
import {
  dispatchTool,
  type HostDispatchObservation,
  type HostToolDispatchInput,
  type HostToolDispatchPort,
} from '../src/effects/tool-dispatch.js'
import { dispatchPermittedTool, dispatchToolAttempt } from '../src/effects/tool-execution.js'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, openSession, testFsOps } from './helpers/open-session.js'

const result = { content: [{ type: 'text' as const, text: 'ok' }] }

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}
const managedAttempts = () => {
  let now = 0
  let sequence = 0
  const pending = new Map<number, { at: number; fire(): void }>()
  const timers = {
    setTimeout(fire: () => void, ms: number) {
      const id = ++sequence
      pending.set(id, { at: now + ms, fire })
      return id
    },
    clearTimeout(handle: unknown) {
      pending.delete(handle as number)
    },
  }
  const advance = async (ms: number) => {
    const through = now + ms
    while (true) {
      const next = [...pending].filter(([, item]) => item.at <= through).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      now = next[1].at
      pending.delete(next[0])
      next[1].fire()
      await flush()
    }
    now = through
    await flush()
  }
  const start = (
    execute: (context: ToolContext) => Promise<HostDispatchObservation>,
    options: { timeoutMs?: number; label?: string; parent?: HumanWaitScope; signal?: AbortSignal } = {},
  ) => {
    const context = {} as ToolContext
    const controller = new AbortController()
    let invocation!: Promise<HostDispatchObservation>
    let settled = false
    const observed = dispatchToolAttempt({
      name: options.label ?? 'ordinary-tool',
      executionDomain: 'host-computer-use',
      timeoutMs: options.timeoutMs ?? 100,
      signal: options.signal ?? controller.signal,
      ...(options.parent ? { humanWaitParent: options.parent } : {}),
      timers,
      monotonicClock: () => now,
      createContext: () => context,
      dispatch: execute,
      track: (work) => {
        invocation = work
      },
    })
    void observed.then(() => {
      settled = true
    })
    return { context, controller, observed, invocation, settled: () => settled }
  }
  return { start, advance, pending }
}

describe('managed human wait during tool dispatch', () => {
  it('excludes only actual human wait and resumes the remaining ordinary budget', async () => {
    const h = managedAttempts()
    const preparing = deferred()
    const answer = deferred<string>()
    const work = deferred()
    const attempt = h.start(async (context) => {
      await preparing.promise
      expect(await withManagedHumanWait(context, () => answer.promise)).toBe('answer')
      await work.promise
      return { phase: 'responded', result }
    })
    await h.advance(30)
    preparing.resolve()
    await flush()
    await h.advance(10_000)
    expect(attempt.settled()).toBe(false)
    answer.resolve('answer')
    await flush()
    await h.advance(69)
    expect(attempt.settled()).toBe(false)
    await h.advance(1)
    expect(await attempt.observed).toMatchObject({
      timedOut: true,
      cancelled: false,
      observation: { phase: 'may_have_sent' },
    })
    let drained = false
    void attempt.invocation.then(() => {
      drained = true
    })
    expect(drained).toBe(false)
    work.resolve()
    await attempt.invocation
    await flush()
    expect(drained).toBe(true)
  })

  it('resumes only after the final overlapping wait without resetting previously consumed time', async () => {
    const h = managedAttempts()
    const preparing = deferred()
    const first = deferred()
    const second = deferred()
    const finished = deferred()
    const attempt = h.start(async (context) => {
      await preparing.promise
      await Promise.all([
        withManagedHumanWait(context, () => first.promise),
        withManagedHumanWait(context, () => second.promise),
      ])
      await finished.promise
      return { phase: 'responded', result }
    })
    await h.advance(25)
    preparing.resolve()
    await flush()
    await h.advance(1000)
    first.resolve()
    await flush()
    await h.advance(1000)
    expect(attempt.settled()).toBe(false)
    second.resolve()
    await flush()
    await h.advance(74)
    expect(attempt.settled()).toBe(false)
    await h.advance(1)
    expect((await attempt.observed).timedOut).toBe(true)
    finished.resolve()
    await attempt.invocation
  })

  it.each(['reject', 'throw'] as const)(
    'restores the remaining timer when the trusted answerer %s fails',
    async (kind) => {
      const h = managedAttempts()
      const begin = deferred()
      const answer = deferred()
      const finished = deferred()
      const attempt = h.start(async (context) => {
        await begin.promise
        await expect(
          withManagedHumanWait(context, () => {
            if (kind === 'throw') throw new Error('answerer unavailable')
            return answer.promise
          }),
        ).rejects.toThrow('answerer unavailable')
        await finished.promise
        return { phase: 'responded', result }
      })
      await h.advance(40)
      begin.resolve()
      await flush()
      if (kind === 'reject') {
        await h.advance(1000)
        answer.reject(new Error('answerer unavailable'))
        await flush()
      }
      await h.advance(59)
      expect(attempt.settled()).toBe(false)
      await h.advance(1)
      expect((await attempt.observed).timedOut).toBe(true)
      finished.resolve()
      await attempt.invocation
    },
  )

  it.each(['resolve', 'reject'] as const)(
    'cancels an unanswered request immediately and consumes its late %s',
    async (kind) => {
      const h = managedAttempts()
      const answer = deferred()
      let questionSignal!: AbortSignal
      const attempt = h.start(async (context) => {
        await withManagedHumanWait(context, (signal) => {
          questionSignal = signal
          return answer.promise
        })
        return { phase: 'responded', result }
      })
      await h.advance(1000)
      attempt.controller.abort()
      const observed = await attempt.observed
      expect(observed).toMatchObject({ timedOut: false, cancelled: true })
      expect(questionSignal.aborted).toBe(true)
      expect(h.pending.size).toBe(0)
      if (kind === 'resolve') answer.resolve()
      else answer.reject(new Error('late answer failure'))
      await flush()
      expect(await attempt.observed).toBe(observed)
      await expect(withManagedHumanWait(attempt.context, async () => undefined)).rejects.toThrow('aborted:')
    },
  )

  it('pauses nested ancestors while an independent sibling still times out', async () => {
    const h = managedAttempts()
    const begin = deferred()
    const answer = deferred()
    const childDone = deferred()
    const parentDone = deferred()
    let child!: ReturnType<typeof h.start>
    const parent = h.start(
      async (context) => {
        await begin.promise
        const parentScope = humanWaitParent(context)
        if (!parentScope) throw new Error('Expected managed parent scope')
        child = h.start(
          async (nested) => {
            await withManagedHumanWait(nested, () => answer.promise)
            await childDone.promise
            return { phase: 'responded', result }
          },
          { parent: parentScope, timeoutMs: 40, label: 'child' },
        )
        await child.observed
        await parentDone.promise
        return { phase: 'responded', result }
      },
      { label: 'parent' },
    )
    const siblingDone = deferred()
    const sibling = h.start(async () => {
      await siblingDone.promise
      return { phase: 'responded', result }
    })
    await h.advance(30)
    begin.resolve()
    await flush()
    await h.advance(1000)
    expect((await sibling.observed).timedOut).toBe(true)
    expect(parent.settled()).toBe(false)
    expect(child.settled()).toBe(false)
    answer.resolve()
    await flush()
    await h.advance(39)
    expect(child.settled()).toBe(false)
    childDone.resolve()
    await child.observed
    await h.advance(30)
    expect(parent.settled()).toBe(false)
    await h.advance(1)
    expect((await parent.observed).timedOut).toBe(true)
    parentDone.resolve()
    siblingDone.resolve()
    await Promise.all([parent.invocation, sibling.invocation])
  })

  it('ignores a retired timeout callback while waiting but still enforces the resumed deadline', async () => {
    const h = managedAttempts()
    const begin = deferred()
    const answer = deferred()
    const done = deferred()
    const attempt = h.start(async (context) => {
      await begin.promise
      await withManagedHumanWait(context, () => answer.promise)
      await done.promise
      return { phase: 'responded', result }
    })
    const stale = [...h.pending.values()][0]?.fire
    if (!stale) throw new Error('Expected ordinary execution deadline')
    await h.advance(10)
    begin.resolve()
    await flush()
    stale()
    await h.advance(1000)
    expect(attempt.settled()).toBe(false)
    answer.resolve()
    await flush()
    stale()
    await h.advance(89)
    expect(attempt.settled()).toBe(false)
    await h.advance(1)
    expect((await attempt.observed).timedOut).toBe(true)
    done.resolve()
    await attempt.invocation
  })

  it('does not exempt a tool named Question and rejects unbound wait capabilities', async () => {
    const h = managedAttempts()
    const done = deferred()
    const attempt = h.start(
      async () => {
        await done.promise
        return { phase: 'responded', result }
      },
      { label: 'Question' },
    )
    await expect(withManagedHumanWait({} as ToolContext, async () => undefined)).rejects.toThrow(
      'managed tool attempt',
    )
    await h.advance(100)
    expect((await attempt.observed).timedOut).toBe(true)
    done.resolve()
    await attempt.invocation
  })

  it.each(['answer', 'abort'] as const)(
    'settles only once when %s wins the answer/cancellation race',
    async (winner) => {
      const h = managedAttempts()
      const answer = deferred()
      const attempt = h.start(async (context) => {
        await withManagedHumanWait(context, () => answer.promise)
        return { phase: 'responded', result }
      })
      answer.resolve()
      if (winner === 'abort') attempt.controller.abort()
      await flush()
      const observed = await attempt.observed
      if (winner === 'answer') {
        expect(observed).toMatchObject({
          timedOut: false,
          cancelled: false,
          observation: { phase: 'responded' },
        })
        attempt.controller.abort()
      } else expect(observed).toMatchObject({ timedOut: false, cancelled: true })
      await h.advance(1000)
      expect(await attempt.observed).toBe(observed)
      expect(h.pending.size).toBe(0)
    },
  )

  it('propagates ancestor cancellation through a nested human wait without waiting for an answer', async () => {
    const h = managedAttempts()
    const answer = deferred()
    let questionSignal!: AbortSignal
    let child!: ReturnType<typeof h.start>
    const parent = h.start(async (context) => {
      const parentScope = humanWaitParent(context)
      if (!parentScope) throw new Error('Expected managed parent scope')
      child = h.start(
        async (nested) => {
          await withManagedHumanWait(nested, (signal) => {
            questionSignal = signal
            return answer.promise
          })
          return { phase: 'responded', result }
        },
        { parent: parentScope },
      )
      await child.observed
      return { phase: 'responded', result }
    })
    await h.advance(1000)
    parent.controller.abort()
    expect(await parent.observed).toMatchObject({ cancelled: true, timedOut: false })
    expect(questionSignal.aborted).toBe(true)
    await child.observed
    await parent.invocation
    expect(h.pending.size).toBe(0)
    answer.reject(new Error('late nested answer'))
    await flush()
  })
})

describe('tool dispatch attestation', () => {
  it('consumes the same durable attempt only once without a Native session', async () => {
    const invoke = vi.fn(async () => result)
    const input = {
      name: 'write',
      args: {},
      context: {} as never,
      executionDomain: 'workspace' as const,
      effectId: 'effect-1',
      startSeq: 1,
      attempt: 1 as const,
      owner: {},
      permits: new ExecutePermitRegistry(),
      invoke,
    }
    expect(await dispatchPermittedTool(input)).toEqual({ phase: 'responded', result })
    expect(() => dispatchPermittedTool(input)).toThrow('strict order')
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('returns a single transport observation without retrying or bypassing workspace admission', async () => {
    const dispatch = vi.fn(async () => ({ phase: 'not_sent' as const, error: 'not accepted' }))
    const input = {
      name: 'write',
      executionDomain: 'host-computer-use' as const,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      createContext: () => ({}) as never,
      dispatch,
    }
    expect(await dispatchToolAttempt(input)).toMatchObject({ observation: { phase: 'not_sent' } })
    expect(dispatch).toHaveBeenCalledOnce()
    const denied = await dispatchToolAttempt({
      ...input,
      executionDomain: 'workspace',
      workspaceInvocation: {
        run: async () => {
          throw new Error('workspace closed')
        },
      },
    })
    expect(denied.observation).toMatchObject({ phase: 'may_have_sent', error: new Error('workspace closed') })
    expect(dispatch).toHaveBeenCalledOnce()
  })

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
