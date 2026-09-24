import type { InferenceEvent, Provider } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import type { RegisterMap } from '../src/log/storage.js'
import type { SessionImpl } from '../src/step/session.js'
import type { Seq } from '../src/types.js'
import { sentFor } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

/** A model that says it sent the request and never answers, so the turn stays in inference. */
const hanging = (): Provider => ({
  models: () => [],
  async *infer(req): AsyncIterable<InferenceEvent> {
    yield sentFor(req)
    await new Promise<void>(() => undefined)
  },
})

/** Opens a session and leaves its turn open in the inference phase. */
async function inInference(storage = new MemoryStorage()) {
  const h = await openSession({ provider: hanging(), storage })
  await h.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
  expect(await h.session.step()).toEqual({ phase: 'checkpoint' })
  expect(await h.session.step()).toEqual({ phase: 'inference' })
  return h
}

type Historical = { projectHistoricalUI(cut: Seq, opts: object): Promise<{ opState: unknown }> }
const historical = (session: SessionImpl) => session as unknown as Historical

describe('the UI summary of the running operation', () => {
  it('shows a cut before the head as running, whatever phase that cut was in', async () => {
    const h = await inInference()
    const cut = h.session.lastSeq
    await h.session.diag('invariant', { note: 'moves the head past the cut' })
    const view = await h.session.projectUI(cut)
    expect(view.opState).toMatchObject({ turn: 1, phase: 'running' })
  })

  it('reads the live register for a historical projection taken at the head', async () => {
    const h = await inInference()
    const view = await historical(h.session).projectHistoricalUI(h.session.lastSeq, {})
    expect(view.opState).toEqual({ turn: 1, step: 0, phase: 'inference' })
  })

  it('does not read the register when a commit lands while the history is being read', async () => {
    const storage = new MemoryStorage()
    const h = await inInference(storage)
    const cut = h.session.lastSeq
    let release!: () => void
    let held: Promise<void> | undefined = new Promise<void>((resolve) => {
      release = resolve
    })
    const scan = storage.scan.bind(storage)
    storage.scan = async (k, q) => {
      if (held) await held
      return scan(k, q)
    }
    const projecting = historical(h.session).projectHistoricalUI(cut, {})
    await new Promise((r) => setTimeout(r, 5))
    held = undefined
    await h.session.diag('invariant', { note: 'lands during the scan' })
    release()
    expect((await projecting).opState).toMatchObject({ turn: 1, phase: 'running' })
  })

  it('knows the running operation on open, before any new commit, without a UI checkpoint', async () => {
    const h = await inInference()
    const events = await h.log.scan({ fromSeq: 1, toSeq: h.log.lastSeq })
    const registers = await h.storage.registers('k')
    const reopened = await openSession({
      provider: hanging(),
      storage: MemoryStorage.fromEvents('k', events, {
        opCells: registers.filter((row) => row.register === 'op.state'),
      }),
      key: 'k',
      writerRunId: 'r2',
    })
    const view = await reopened.session.projectUI()
    expect(view.opState).toEqual({ turn: 1, step: 0, phase: 'inference' })
  })

  it('keeps and shows the program counter when open discards a drifted register table', async () => {
    const h = await inInference()
    const events = await h.log.scan({ fromSeq: 1, toSeq: h.log.lastSeq })
    const registers = await h.storage.registers('k')
    const drifted = registers.find((row) => row.register !== 'op.state')
    if (!drifted) throw new Error('expected a register besides the program counter')
    const storage = MemoryStorage.fromEvents('k', events, {
      opCells: registers
        .filter((row) => row.register === 'op.state')
        .map((row) => ({ ...row, data: { ...(row.data as object), step: 7 } })),
    })
    // A folded register whose table row lies: the open rebuilds the table from the fold.
    ;(storage as unknown as { book(key: string): { registers: RegisterMap } })
      .book('k')
      .registers.apply({ ...drifted, seq: drifted.seq + 100 })
    const reopened = await openSession({ provider: hanging(), storage, key: 'k', writerRunId: 'r2' })
    // The fold has no program counter to rebuild, so the cell the store holds is kept and shown.
    expect(reopened.log.registerRow(drifted.register, drifted.key)?.seq).toBe(drifted.seq)
    expect(reopened.session.op()?.step).toBe(7)
    expect((await reopened.session.projectUI()).opState).toEqual({ turn: 1, step: 7, phase: 'inference' })
  })
})
