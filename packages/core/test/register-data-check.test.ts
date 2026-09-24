import type { InferenceEvent, Provider } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import type { RegisterRow } from '../src/log/storage.js'
import { openTracked, registerRows, verifyRegisters } from '../src/reduce/tracker.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { classifyToolRecovery } from '../src/step/tool-recovery.js'
import { fakeProvider, sentFor, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession, shellTool } from './helpers/open-session.js'

const hanging = (): Provider => ({
  models: () => [],
  async *infer(req): AsyncIterable<InferenceEvent> {
    yield sentFor(req)
    await new Promise<void>(() => undefined)
  },
})

const say = (text: string) => ({ content: [{ type: 'text' as const, text }], actor })

/** The same program-counter cell at the same seq, with its value rewritten. */
const rewriteOp = (rows: RegisterRow[], edit: (data: Record<string, unknown>) => Record<string, unknown>) =>
  rows.map((row) =>
    row.register === 'op.state' && row.data
      ? { ...row, data: edit(structuredClone(row.data) as never) }
      : row,
  )

const reopenTracked = (storage: MemoryStorage) =>
  openTracked({
    storage,
    key: 'k',
    writerRunId: 'r2',
    ttlMs: 60_000,
    ids: defaultIds(),
    clock: () => 1_757_203_200_000,
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
  })

describe('the register check on open compares cell values, not only seqs', () => {
  it('rebuilds a program counter whose value changed at the same seq', async () => {
    const h = await openSession({ provider: hanging() })
    await h.session.enqueue('next-turn', say('go'))
    await h.session.step()
    await h.session.step()
    const events = await h.log.scan({ fromSeq: 1, toSeq: h.log.lastSeq })
    const registers = rewriteOp(await h.storage.registers('k'), (op) => ({ ...op, step: 41 }))
    const opened = await reopenTracked(
      MemoryStorage.fromEvents('k', events, {
        opCells: registers.filter((row) => row.register === 'op.state'),
      }),
    )
    expect(opened.registersRebuilt).toBe(true)
    expect(opened.log.registerRow('op.state')?.data).toMatchObject({ step: 0 })
  })

  it('reports a changed value in any register as a mismatch', async () => {
    const h = await openSession({ provider: hanging() })
    await h.session.enqueue('next-turn', say('go'))
    await h.session.step()
    const rows = registerRows(h.tracker.state)
    const other = rows.find((row) => row.register !== 'op.state')
    if (!other) throw new Error('expected a register besides the program counter')
    const changed = rows.map((row) => (row === other ? { ...row, data: { planted: true } } : row))
    expect(verifyRegisters(h.tracker, rows).ok).toBe(true)
    expect(verifyRegisters(h.tracker, changed)).toMatchObject({ ok: false })
  })

  it('recovers a dispatched call rewritten to approved at the same seq as dispatched, and never reruns it', async () => {
    let runs = 0
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const registry = new ToolRegistry()
    registry.add(
      shellTool(async () => {
        runs++
        started()
        await new Promise<void>(() => undefined)
        return { content: [{ type: 'text' as const, text: 'never' }] }
      }),
      { source: 's', trust: 'builtin' },
    )
    const first = await openSession({
      provider: fakeProvider([toolTurn('shell', { cmd: 'rm -rf x' })]),
      registry,
    })
    await first.session.enqueue('next-turn', say('delete it'))
    void first.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await running
    expect(runs).toBe(1)
    const events = await first.log.scan({ fromSeq: 1, toSeq: first.log.lastSeq })
    const stored = await first.storage.registers('k')
    const calls = (op: Record<string, unknown>) =>
      (op.phase as { batch: { calls: Array<{ status: string }> } }).batch.calls
    const opRow = stored.find((row) => row.register === 'op.state')
    expect(calls(opRow?.data as never).map((call) => call.status)).toEqual(['dispatched'])
    const registers = rewriteOp(stored, (op) => {
      for (const call of calls(op)) call.status = 'approved'
      return op
    })

    const again = new ToolRegistry()
    again.add(
      shellTool(async () => {
        runs++
        return { content: [{ type: 'text' as const, text: 'ran twice' }] }
      }),
      { source: 's', trust: 'builtin' },
    )
    const reopened = await openSession({
      provider: fakeProvider([textTurn('done')]),
      registry: again,
      storage: MemoryStorage.fromEvents('k', events, {
        opCells: registers.filter((row) => row.register === 'op.state'),
      }),
      key: 'k',
      writerRunId: 'r2',
    })
    // The session steps from the fold's value, so recovery classifies a call that went out, not
    // one that is still waiting to go out.
    const reopenedCall = calls(reopened.session.op() as never)[0] as Parameters<
      typeof classifyToolRecovery
    >[0]['call']
    expect(reopenedCall.status).toBe('dispatched')
    expect(
      classifyToolRecovery({
        mode: 'resume',
        call: reopenedCall,
        policy: (reopenedCall as never as { resolvedPolicy: never }).resolvedPolicy,
        policyBinding: 'trusted',
        hasMatchingResult: false,
      }),
    ).toBe('unknown')
    await reopened.session.resume()
    await reopened.session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(runs).toBe(1)
  })
})
