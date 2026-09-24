import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { presetDefaults } from '../src/step/preset.js'
import type { QuietGate } from '../src/step/session.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, openSession, testFsOps } from './helpers/open-session.js'

const catalogue = (): ModelRecord => ({
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
})

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const signal = () => new AbortController().signal

describe('Core quiet gate', () => {
  it('shares one gate with descendants without reporting a child yield as globally quiet', async () => {
    const trace: Array<{ kind: 'step' | 'turn'; key: string; stepping: number }> = []
    let stepping = 0
    const quiet: QuietGate = {
      enter: () => {
        stepping++
      },
      leave: () => {
        stepping--
      },
      yieldPoint: async (kind, key) => {
        trace.push({ kind, key, stepping })
      },
    }
    const kernel = Kernel.create({
      storage: new MemoryStorage(),
      seams: fakeSeams(),
      provider: Object.assign(fakeProvider([textTurn('child says hi')]), { models: () => [catalogue()] }),
      contract: { contract_id: null, parser_version: '1' },
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 2 },
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      logger,
      timers: noTimers,
      clock: () => 1_757_203_200_000,
      quiet,
    })
    const session = await kernel.session('parent', {
      actor,
      resolvedProfileHash: 'h1',
      cwd: '/w',
      writerRunId: 'r1',
    })
    const child = await session.d.children.create({
      parent: session.key,
      cwd: '/w',
      input: 'what?',
    })
    let parentEdges = 0
    session.step = async () => {
      if (parentEdges++ === 0) {
        await child.run('what?')
        return { phase: 'checkpoint' }
      }
      return { phase: 'terminal', reason: 'completed' }
    }

    await expect(session.run({ until: 'turn-end', signal: signal() })).resolves.toMatchObject({
      reason: 'completed',
    })

    expect(trace.every((point) => point.key === 'parent')).toBe(true)
    expect(trace.some((point) => point.stepping >= 1)).toBe(true)
    const rootYields = trace.filter((point) => point.stepping === 0)
    expect(rootYields).not.toHaveLength(0)
    expect(rootYields.at(-1)).toMatchObject({ kind: 'turn', stepping: 0 })
    expect(stepping).toBe(0)
    await kernel.close()
  })

  it('balances enter and leave on a thrown step and still reaches the turn yield', async () => {
    const calls: string[] = []
    let stepping = 0
    const { session } = await openSession({
      provider: fakeProvider([textTurn('unused')]),
      quiet: {
        enter: () => {
          stepping++
          calls.push('enter')
        },
        leave: () => {
          stepping--
          calls.push('leave')
        },
        yieldPoint: async (kind) => {
          calls.push(`yield:${kind}`)
        },
      },
    })
    session.step = async () => {
      throw new Error('broken phase')
    }

    await expect(session.run({ until: 'turn-end', signal: signal() })).resolves.toMatchObject({
      reason: 'error',
      error: { code: 'E_STEP_FAILED', message: 'broken phase' },
    })
    expect(calls).toEqual(['enter', 'leave', 'yield:turn'])
    expect(stepping).toBe(0)
  })

  it('surfaces a yield failure and still runs the turn-finally yield', async () => {
    const failed = new Error('reconciler unavailable')
    const calls: string[] = []
    let stepping = 0
    const { session } = await openSession({
      provider: fakeProvider([textTurn('unused')]),
      quiet: {
        enter: () => {
          stepping++
          calls.push('enter')
        },
        leave: () => {
          stepping--
          calls.push('leave')
        },
        yieldPoint: async (kind) => {
          calls.push(`yield:${kind}`)
          if (kind === 'step') throw failed
        },
      },
    })
    session.step = async () => ({ phase: 'checkpoint' })

    await expect(session.run({ until: 'turn-end', signal: signal() })).rejects.toBe(failed)
    expect(calls).toEqual(['enter', 'leave', 'yield:step', 'yield:turn'])
    expect(stepping).toBe(0)
  })

  it('waits for a blocked quiet entry before starting the next step', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const { session } = await openSession({
      provider: fakeProvider([textTurn('unused')]),
      quiet: {
        enter: () => {
          if (!first) return
          first = false
          return held
        },
        leave: () => undefined,
        yieldPoint: async () => undefined,
      },
    })
    let stepped = false
    session.step = async () => {
      stepped = true
      return { phase: 'terminal', reason: 'completed' }
    }
    const running = session.run({ until: 'turn-end', signal: signal() })
    await Promise.resolve()
    expect(stepped).toBe(false)
    release()
    await running
    expect(stepped).toBe(true)
  })

  it.each([
    {
      name: 'deferred poll',
      outcome: { phase: 'deferred' as const },
      operation: { phase: { kind: 'deferred' as const } },
    },
    {
      name: 'inference retry',
      outcome: { phase: 'inference' as const },
      operation: {
        phase: {
          kind: 'inference' as const,
          gen: { status: 'retry_wait' as const, notBefore: '2025-09-07T00:00:01.000Z' },
        },
      },
    },
  ])('yields the step boundary before a $name sleep', async ({ outcome, operation }) => {
    const calls: string[] = []
    let edges = 0
    const { session } = await openSession({
      provider: fakeProvider([textTurn('unused')]),
      clock: () => 1_757_203_200_000,
      timers: {
        setTimeout: (fn, ms) => {
          calls.push(`sleep:${ms}`)
          queueMicrotask(fn)
          return 0
        },
        clearTimeout: () => undefined,
      },
      quiet: {
        enter: () => {
          calls.push('enter')
        },
        leave: () => calls.push('leave'),
        yieldPoint: async (kind) => {
          calls.push(`yield:${kind}`)
        },
      },
    })
    session.step = async () => {
      edges++
      return edges === 1 ? outcome : { phase: 'terminal', reason: 'completed' }
    }
    session.op = () => (edges === 1 ? (operation as never) : null)

    await expect(session.run({ until: 'turn-end', signal: signal() })).resolves.toMatchObject({
      reason: 'completed',
    })
    const stepYield = calls.indexOf('yield:step')
    const sleep = calls.findIndex((call) => call.startsWith('sleep:'))
    expect(stepYield).toBeGreaterThan(-1)
    expect(sleep).toBeGreaterThan(stepYield)
    expect(calls.at(-1)).toBe('yield:turn')
  })

  it('keeps the run loop compatible when no quiet gate is configured', async () => {
    const { session } = await openSession({ provider: fakeProvider([textTurn('hi')]) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'x' }], actor })
    await expect(session.run({ until: 'turn-end', signal: signal() })).resolves.toMatchObject({
      reason: 'completed',
    })
  })
})
