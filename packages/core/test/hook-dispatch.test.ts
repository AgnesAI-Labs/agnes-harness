import type { HookEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { type DispatchEntry, HookDispatch } from '../src/hooks/dispatch.js'

const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
const setup = (eventsPerTurn?: number) => {
  let next = 0
  const timers = new Map<number, { fn: () => void; ms: number }>()
  const diagnostics: unknown[] = []
  const failures: unknown[] = []
  const dispatcher = new HookDispatch({
    ...(eventsPerTurn === undefined ? {} : { eventsPerTurn }),
    timers: {
      setTimeout: (fn, ms) => {
        timers.set(++next, { fn, ms })
        return next
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number)
      },
    },
    diag: (name, data) => {
      diagnostics.push({ name, ...data })
    },
    onFailure: (failure) => {
      failures.push(failure)
    },
  })
  return { dispatcher, timers, diagnostics, failures, signal: new AbortController().signal }
}
const entry = <T>(invoke: DispatchEntry<T>['invoke'], source = 'agnes/test'): DispatchEntry<T> => ({
  source,
  invoke,
})

describe('HookDispatch table-driven scheduling', () => {
  it.each([
    ['session_start', 500, false],
    ['resources_discover', 1000, false],
    ['before_step', 1000, true],
    ['context', 1500, true],
    ['before_request', 1500, true],
    ['before_provider_headers', 500, true],
    ['request_error', 500, false],
    ['tool_call', 2000, true],
    ['tool_result', 2000, false],
    ['turn_stopping', 1000, false],
    ['approval_request', 1000, true],
    ['before_compact', 3000, true],
    ['compact', 1000, false],
    ['subagent_start', 200, false],
    ['subagent_end', 200, false],
    ['format_deviation', 500, false],
    ['shutdown', 1000, false],
  ] satisfies Array<[HookEvent, number, boolean]>)(
    '%s enforces its specified timeout and fail policy',
    async (event, deadline, closed) => {
      const { dispatcher, signal, timers, failures } = setup()
      const run = dispatcher.run(event, [entry(() => new Promise(() => undefined))], signal)
      await tick()
      expect([...timers.values()].map((timer) => timer.ms)).toEqual([deadline])
      for (const timer of [...timers.values()]) timer.fn()
      await expect(run).resolves.toMatchObject({ kind: closed ? 'rejected' : 'ok' })
      await tick()
      expect(failures).toHaveLength(1)
      expect(timers.size).toBe(0)
    },
  )

  it('uses the default 200 observe dispatch quota, reports once, and resets per turn', async () => {
    const { dispatcher, signal, diagnostics } = setup()
    let called = 0
    const entries = [entry(() => ++called)]
    for (let i = 0; i < 203; i++) await dispatcher.run('format_deviation', entries, signal)
    expect(called).toBe(200)
    expect(diagnostics).toEqual([{ name: 'hook-quota', event: 'format_deviation' }])
    await dispatcher.run('tool_call', entries, signal)
    await dispatcher.run('context', entries, signal)
    expect(called).toBe(202)
    dispatcher.resetTurn()
    await dispatcher.run('format_deviation', entries, signal)
    expect(called).toBe(203)
  })

  it('keeps session quotas separate and honors explicit zero', async () => {
    const a = setup(0),
      b = setup(1)
    let n = 0
    await a.dispatcher.run('session_start', [entry(() => n++)], a.signal)
    await b.dispatcher.run('session_start', [entry(() => n++)], b.signal)
    expect(n).toBe(1)
  })

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid quota %s', (eventsPerTurn) => {
    expect(() => setup(eventsPerTurn)).toThrow('invalid hook event quota')
  })

  it('starts parallel observers together, awaits all, and returns registration order', async () => {
    const { dispatcher, signal, timers } = setup()
    const seen: string[] = []
    let release!: (value: string) => void
    const run = dispatcher.run(
      'session_start',
      [
        entry(() => {
          seen.push('a')
          return new Promise<string>((r) => {
            release = r
          })
        }, 'agnes/a'),
        entry(() => {
          seen.push('b')
          return 'second'
        }, 'agnes/b'),
      ],
      signal,
    )
    let done = false
    void run.then(() => {
      done = true
    })
    await tick()
    expect(seen).toEqual(['a', 'b'])
    expect(done).toBe(false)
    release('first')
    await expect(run).resolves.toEqual({
      kind: 'ok',
      results: [
        { source: 'agnes/a', value: 'first' },
        { source: 'agnes/b', value: 'second' },
      ],
    })
    expect(timers.size).toBe(0)
  })

  it('emit returns without waiting but bounds and aborts a stuck observer', async () => {
    const { dispatcher, signal, timers, failures } = setup()
    let handlerSignal: AbortSignal | undefined
    await expect(
      dispatcher.run(
        'subagent_start',
        [
          entry((ctx) => {
            handlerSignal = ctx.signal
            return new Promise(() => undefined)
          }),
        ],
        signal,
      ),
    ).resolves.toEqual({ kind: 'ok', results: [] })
    expect([...timers.values()].map((t) => t.ms)).toEqual([200])
    for (const timer of [...timers.values()]) timer.fn()
    await tick()
    expect(handlerSignal?.aborted).toBe(true)
    expect(timers.size).toBe(0)
    expect(failures).toHaveLength(1)
  })

  it('serial directives inspect later handlers after allow and stop on the first deny', async () => {
    const { dispatcher, signal } = setup()
    const seen: number[] = []
    const result = await dispatcher.run(
      'tool_call',
      [true, false, true].map((allow, i) =>
        entry(() => {
          seen.push(i)
          return { allow }
        }),
      ),
      signal,
      { terminal: (value) => !value.allow },
    )
    expect(seen).toEqual([0, 1])
    expect(result).toMatchObject({
      kind: 'ok',
      results: [{ value: { allow: true } }, { value: { allow: false } }],
    })
  })

  it('waterfall commits each bounded result before invoking the next handler', async () => {
    const { dispatcher, signal } = setup()
    let accumulated = 1
    await dispatcher.run('context', [entry(() => accumulated + 2), entry(() => accumulated * 3)], signal, {
      commit: (value) => {
        accumulated = value
      },
    })
    expect(accumulated).toBe(9)
  })

  it('closed transform failure rejects and never calls the next handler', async () => {
    const { dispatcher, signal, failures } = setup()
    let later = false
    const result = await dispatcher.run(
      'context',
      [
        entry(() => {
          throw new Error('secret credential')
        }),
        entry(() => {
          later = true
        }),
      ],
      signal,
    )
    expect(result).toEqual({ kind: 'rejected', source: 'agnes/test', reason: 'hook execution failed' })
    expect(later).toBe(false)
    expect(JSON.stringify(failures)).not.toContain('secret credential')
  })

  it('open transform failure preserves previous state and invokes the next handler', async () => {
    const { dispatcher, signal, failures } = setup()
    let value = 1
    const result = await dispatcher.run(
      'resources_discover',
      [
        entry(() => {
          throw new Error('failure')
        }),
        entry(() => value + 1),
      ],
      signal,
      {
        commit: (next) => {
          value = next
        },
      },
    )
    expect(result).toMatchObject({ kind: 'ok', results: [{ value: 2 }] })
    expect(value).toBe(2)
    expect(failures).toHaveLength(1)
  })

  it('timeout rejects by the actual context table deadline and prevents late commits', async () => {
    const { dispatcher, signal, timers } = setup()
    let resolve!: (value: number) => void
    let committed = 0
    const run = dispatcher.run(
      'context',
      [
        entry(
          () =>
            new Promise<number>((r) => {
              resolve = r
            }),
        ),
      ],
      signal,
      {
        commit: (value) => {
          committed = value
        },
      },
    )
    await tick()
    expect([...timers.values()].map((t) => t.ms)).toEqual([1500])
    for (const timer of [...timers.values()]) timer.fn()
    await expect(run).resolves.toMatchObject({ kind: 'rejected' })
    resolve(42)
    await tick()
    expect(committed).toBe(0)
    expect(timers.size).toBe(0)
  })

  it('contains transform validation failure under the event fail policy', async () => {
    const { dispatcher, signal } = setup()
    const result = await dispatcher.run('before_request', [entry(() => ({}))], signal, {
      commit: () => {
        throw new Error('invalid patch')
      },
    })
    expect(result).toMatchObject({ kind: 'rejected' })
  })

  it('does not retain an invalid open directive result when its terminal validator throws', async () => {
    const { dispatcher, signal } = setup()
    const result = await dispatcher.run('turn_stopping', [entry(() => 1), entry(() => 2)], signal, {
      terminal: (value) => {
        if (value === 1) throw new Error('invalid directive')
        return true
      },
    })
    expect(result).toEqual({ kind: 'ok', results: [{ source: 'agnes/test', value: 2 }] })
  })

  it('does not invoke handlers when already aborted, or after abort wins the microtask race', async () => {
    for (const before of [true, false]) {
      const { dispatcher, timers } = setup()
      const controller = new AbortController()
      let n = 0
      if (before) controller.abort()
      const run = dispatcher.run('tool_call', [entry(() => n++)], controller.signal)
      if (!before) controller.abort()
      await expect(run).resolves.toMatchObject({ kind: 'rejected' })
      expect(n).toBe(0)
      expect(timers.size).toBe(0)
    }
  })

  it('replays only flagged events and carries the flag in invocation context', async () => {
    const { dispatcher, signal } = setup()
    const seen: boolean[] = []
    const entries = [
      entry((ctx) => {
        seen.push(ctx.replayed)
      }),
    ]
    await dispatcher.run('session_start', entries, signal)
    await dispatcher.run('session_start', entries, signal, { replayed: true })
    await dispatcher.run('tool_call', entries, signal, { replayed: true })
    expect(seen).toEqual([false, true])
  })

  it.each(['throw', 'reject', 'hang'] as const)(
    'diagnostic sinks that %s cannot escape or hold a closed decision',
    async (kind) => {
      const sink = () => {
        if (kind === 'throw') throw new Error('sink secret')
        if (kind === 'reject') return Promise.reject(new Error('sink secret'))
        return new Promise(() => undefined)
      }
      const dispatcher = new HookDispatch({ diag: sink, onFailure: sink })
      await expect(
        dispatcher.run(
          'tool_call',
          [
            entry(() => {
              throw new Error('handler secret')
            }),
          ],
          new AbortController().signal,
        ),
      ).resolves.toEqual({ kind: 'rejected', source: 'agnes/test', reason: 'hook execution failed' })
      await tick()
    },
  )

  it('snapshots entries before callbacks mutate the registration list', async () => {
    const { dispatcher, signal } = setup()
    const seen: string[] = []
    const entries: DispatchEntry<void>[] = [
      entry(() => {
        entries.pop()
        seen.push('a')
      }),
      entry(() => {
        seen.push('b')
      }),
    ]
    await dispatcher.run('session_start', entries, signal)
    expect(seen).toEqual(['a', 'b'])
  })
})
