import type { InferenceEvent, OpState, Provider } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { sentFor } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

const hanging = (): Provider => ({
  models: () => [],
  async *infer(req): AsyncIterable<InferenceEvent> {
    yield sentFor(req)
    await new Promise<void>(() => undefined)
  },
})

describe('the program counter a session steps from', () => {
  it('is the log register cell, not the value folded from the ledger', async () => {
    const h = await openSession({ provider: hanging() })
    await h.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    expect(await h.session.step()).toEqual({ phase: 'checkpoint' })
    expect(await h.session.step()).toEqual({ phase: 'inference' })
    const folded = h.session.op()
    if (!folded) throw new Error('expected an open operation')
    const planted: NonNullable<OpState> = { ...folded, step: folded.step + 7 }
    const rows = h.log
      .allRegisters()
      .map((row) => (row.register === 'op.state' ? { ...row, seq: row.seq + 100, data: planted } : row))
    h.log.replaceRegisterCache(rows)
    expect(h.session.op()).toEqual(planted)
    expect(h.session.opSeq()).toBe(h.log.registerRow('op.state')?.seq)
    expect(h.session.opSeq()).not.toBe(h.session.state.registers.opState.get('main')?.seq)
  })
})
