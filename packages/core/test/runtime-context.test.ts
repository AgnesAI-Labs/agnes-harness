import { describe, expect, it } from 'vitest'
import type { Operation } from '../src/step/session.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

const sig = () => new AbortController().signal

/**
 * An operation that contributes an environment snapshot, the way a real package's does. The
 * snapshot is read through a callback so a case can change it between turns without rebuilding the
 * session -- and so the operation is written as one object literal, contextually typed by the
 * `Operation` return annotation, rather than spread out of another one (a spread widens `slot` off
 * the union and stops narrowing).
 */
const environment = (snapshot: () => Record<string, unknown>): Operation => ({
  name: 'environment',
  slot: 'before-inference',
  replay: 'safe',
  applicable: async () => 'applied',
  run: async () => ({}),
  contribute: () => ({ runtimeContext: snapshot() }),
})

/**
 * The text of every environment-snapshot row on the ledger, newest last. Filtered by the message's
 * own prefix, not by `kind` alone: the stop gate and the truncated-output path write harness notes
 * on the same message kind, and those are not what this counts.
 */
const snapshots = (rows: Array<{ data: unknown }>): string[] => {
  const out: string[] = []
  for (const row of rows) {
    const data = row.data as { kind?: unknown; content?: Array<{ text?: unknown }> }
    if (data.kind !== 'runtime_context') continue
    const text = data.content?.[0]?.text
    if (typeof text === 'string' && text.startsWith('[runtime context]')) out.push(text)
  }
  return out
}

describe('runtime context notification', () => {
  it('persists live contributions with requests and deduplicates across a reopened session', async () => {
    let state = 'running'
    const operation: Operation = {
      ...environment(() => ({})),
      contribute: () => ({
        promptSections: [
          {
            id: 'receipts',
            order: 112,
            source: 'fixture',
            text: state,
            delivery: 'live-note',
          },
        ],
      }),
    }
    const provider = fakeProvider([textTurn('a')])
    let opened = await openSession({ provider, operations: [operation] })
    const ask = async () => {
      await opened.session.enqueue('next-turn', { content: [{ type: 'text', text: 'continue' }], actor })
      expect((await opened.session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    }
    await ask()
    await ask()
    state = 'completed'
    await ask()
    await opened.session.close()
    opened = await openSession({
      provider,
      operations: [operation],
      storage: opened.storage,
      writerRunId: 'r2',
    })
    await ask()
    const notes = (await opened.log.scan({ type: 'user/message', limit: 100 })).filter((row) => {
      const data = row.data as { kind?: string; content?: Array<{ text?: string }> }
      return data.kind === 'runtime_context' && data.content?.[0]?.text?.startsWith('[live context ')
    })
    expect(notes).toHaveLength(2)
    expect(new Set(provider.requests.map((request) => request.system)).size).toBe(1)
    const headers = await opened.log.scan({ type: 'request/header', limit: 100 })
    expect(headers).toHaveLength(4)
    expect(
      new Set(headers.map((row) => (row.data as { prompt_prefix_hash: string }).prompt_prefix_hash)).size,
    ).toBe(1)
    await opened.session.close()
  })

  it('sends the snapshot once and not again while nothing about it changes', async () => {
    const { session, log } = await openSession({
      provider: fakeProvider([textTurn('a')]),
      operations: [environment(() => ({ cwd: '/w', model: 'm1', preset: 'standard' }))],
    })
    for (const text of ['one', 'two', 'three']) {
      await session.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
      expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    }
    // Three turns, one snapshot. The dedup state has to survive a turn boundary, and the only
    // place it can survive one is the surface the model is rebuilt from.
    expect(snapshots(await log.scan({ type: 'user/message', limit: 100 }))).toHaveLength(1)
  })

  it('sends a fresh snapshot on the turn the environment actually changes', async () => {
    let cwd = '/w'
    const { session, log } = await openSession({
      provider: fakeProvider([textTurn('a')]),
      operations: [environment(() => ({ cwd }))],
    })
    const ask = async (text: string) => {
      await session.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
      await session.run({ until: 'turn-end', signal: sig() })
      return snapshots(await log.scan({ type: 'user/message', limit: 100 }))
    }
    await ask('one')
    expect(await ask('two')).toHaveLength(1)

    cwd = '/elsewhere'
    const rows = await ask('three')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toContain('/elsewhere')
  })
})
