import type { InferenceEvent, Provider } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import type { RegisterRow } from '../src/log/storage.js'
import { openTracked, registerRows, verifyRegisters } from '../src/reduce/tracker.js'
import { sentFor } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

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
  it('keeps a program counter whose value changed at the same seq: the fold has none to rebuild it from', async () => {
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
    expect(opened.registersRebuilt).toBe(false)
    expect(opened.log.registerRow('op.state')?.data).toMatchObject({ step: 41 })
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
})
