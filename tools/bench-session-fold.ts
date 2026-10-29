/** Manual checkpoint read/fold versus full-verify benchmark. Synthetic SQLite only; no daemon/model. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultIds,
  LEDGER_INTEGRITY_ALGORITHM,
  makeVerifiedHead,
  openTracked,
  type PreparedEvent,
  prepareIntegrity,
  type StorageAdapter,
} from '@agnes/core'
import { createSqliteStorage } from '@agnes/host'

const number = (flag: string, fallback: number) => {
  const at = process.argv.indexOf(flag)
  const value = at < 0 ? fallback : Number(process.argv[at + 1])
  if (!Number.isSafeInteger(value) || value < 1 || value % (flag === '--events' ? 4 : 1))
    throw new Error(`Invalid ${flag}`)
  return value
}
const events = number('--events', 30_000)
const runs = number('--runs', 5)
const root = await mkdtemp(join(tmpdir(), 'agh-fold-'))
const ids = defaultIds()
const key = 'synthetic-fold'
const storage = createSqliteStorage({ file: join(root, 'ledger.db'), tablesDir: join(root, 'tables') })
try {
  await storage.open(key, { writerRunId: 'seed', ttlMs: 3_600_000 })
  let state = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null as string | null }
  while (state.lastSeq < events) {
    const batch: PreparedEvent[] = Array.from({ length: Math.min(500, events - state.lastSeq) }, (_, i) => {
      const seq = state.lastSeq + i + 1
      const position = (seq - 1) % 4
      const turn = Math.floor((seq - 1) / 4) + 1
      return {
        id: ids.ulid(),
        ts: '2026-10-19T00:00:00.000Z',
        lane: 'main',
        v: 1,
        actor: { id: 'bench', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        origin: 'principal',
        trust: 'trusted',
        type: ['turn/start', 'user/message', 'assistant/message', 'turn/end'][position]!,
        data:
          position === 0
            ? { turn, trigger: 'prompt' }
            : position === 3
              ? { reason: 'completed', lastAssistantSeq: seq - 1 }
              : {
                  content: [{ type: 'text', text: `Synthetic ${key} message ${turn}` }],
                  ...(position === 2 ? { stopReason: 'end_turn' } : {}),
                },
      }
    })
    const next = prepareIntegrity(
      key,
      batch.map((event, i) => ({ ...event, seq: state.lastSeq + i + 1 })),
      state,
    )
    await storage.commit(key, { events: batch, integrity: next.entries, expectedWriterRunId: 'seed' })
    state = next.state
  }
  await storage.writeVerifiedHead!(
    makeVerifiedHead({
      sessionKey: key,
      throughSeq: state.lastSeq,
      headDigest: state.headDigest!,
      legacyThroughSeq: 0,
      algorithm: LEDGER_INTEGRITY_ALGORITHM,
      verifiedFullAtMs: Date.now(),
      writtenAtMs: Date.now(),
    }),
  )
  await storage.release(key, 'seed')
  const size = await storage.ledgerStats?.(key)
  const measurements = []
  for (let run = 0; run < runs; run++) {
    let readMs = 0
    let folding = true
    const counted: StorageAdapter = Object.create(storage)
    counted.scanIntegrity = async (session, query) => {
      const start = performance.now()
      const rows = await storage.scanIntegrity(session, query)
      if (folding) readMs += performance.now() - start
      return rows
    }
    let background: { ms: number; rows: number; outcome: string } | undefined
    const start = performance.now()
    const { log } = await openTracked({
      storage: counted,
      key,
      writerRunId: `fold-${run}`,
      ttlMs: 60_000,
      ids,
      clock: Date.now,
      onFullVerify: (report) => {
        background = report
      },
    })
    const readFoldMs = performance.now() - start
    folding = false
    if (!log.openStats.checkpoint.used) throw new Error('Benchmark requires a usable checkpoint')
    await log.fullVerified()
    measurements.push({ run, readFoldMs, readMs, background, checkpoint: log.openStats.checkpoint })
    await log.close()
  }
  process.stdout.write(
    `${JSON.stringify({ node: process.version, events, runs, size, measurements }, null, 2)}\n`,
  )
} finally {
  await storage.close()
  await rm(root, { recursive: true, force: true })
}
