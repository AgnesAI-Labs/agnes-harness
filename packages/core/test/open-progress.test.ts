import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { type OpenProgress, SessionLogImpl } from '../src/log/session-log.js'
import { openTracked } from '../src/reduce/tracker.js'
import type { EventInput } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const timers = { setTimeout: () => 0, clearTimeout: () => undefined }
const note = (i: number): EventInput => ({
  actor,
  origin: 'principal',
  trust: 'trusted',
  type: 'user/message',
  data: { content: [{ type: 'text', text: `row ${i}` }] },
})
const base = (storage: MemoryStorage, writerRunId: string) => ({
  storage,
  key: 'k',
  writerRunId,
  ttlMs: 60_000,
  ids: defaultIds(),
  clock: () => Date.parse('2026-10-13T00:00:00.000Z'),
  timers,
})

async function ledger(rows: number): Promise<MemoryStorage> {
  const storage = new MemoryStorage()
  const writer = await SessionLogImpl.open(base(storage, 'w1'))
  for (let i = 0; i < rows; i += 100)
    await writer.append(Array.from({ length: Math.min(100, rows - i) }, (_, j) => note(i + j)))
  await writer.close()
  return storage
}

describe('open progress', () => {
  it('reports verify progress by seq through openTracked, ending at the head', async () => {
    const storage = await ledger(1200)
    const seen: OpenProgress[] = []
    const { log } = await openTracked({ ...base(storage, 'w2'), progress: (p) => seen.push(p) })
    const verify = seen.filter((p) => p.phase === 'verify')
    expect(verify.length).toBeGreaterThan(1)
    for (let i = 1; i < verify.length; i++)
      expect(verify[i]?.done).toBeGreaterThan(verify[i - 1]?.done as number)
    expect(verify.every((p) => p.total === 1200)).toBe(true)
    expect(verify.at(-1)).toEqual({ phase: 'verify', done: 1200, total: 1200 })
    await log.close()
  })

  it('reports progress on a plain open with no replay attached', async () => {
    const storage = await ledger(300)
    const seen: OpenProgress[] = []
    const log = await SessionLogImpl.open({ ...base(storage, 'w2'), progress: (p) => seen.push(p) })
    expect(seen.at(-1)).toEqual({ phase: 'verify', done: 300, total: 300 })
    await log.close()
  })

  it('opens even when the progress listener throws', async () => {
    const storage = await ledger(10)
    const log = await SessionLogImpl.open({
      ...base(storage, 'w2'),
      progress: () => {
        throw new Error('listener broke')
      },
    })
    expect(log.lastSeq).toBe(10)
    await log.close()
  })
})
