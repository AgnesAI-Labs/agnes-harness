import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  type IntegrityState,
  type PreparedEvent,
  prepareIntegrity,
  type StorageAdapter,
  verifyLedger,
} from '../packages/core/src/index.js'
import { createSqliteStorage } from '../packages/host/src/index.js'

const readNumber = (flag: string, fallback: number): number => {
  const index = process.argv.indexOf(flag)
  const value = index < 0 ? fallback : Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`)
  return value
}

const eventCount = readNumber('--events', 10_000)
const runs = readNumber('--runs', 5)
const batches = [1, 8, 32]
const actor = { id: 'bench', org: 'local', role: 'owner', deptPath: [], attrs: {} }

function event(seq: number): PreparedEvent {
  return {
    ts: '2026-09-12T00:00:00.000Z',
    id: `event-${seq}`,
    lane: 'main',
    v: 1,
    actor,
    origin: 'principal',
    trust: 'trusted',
    type: 'user/message',
    data: { content: [{ type: 'text', text: `benchmark-${seq}` }] },
  }
}

type Store = 'memory' | 'sqlite'
type Measurement = {
  store: Store
  mode: 'legacy' | 'protected'
  batch: number
  appendMs: number
  verifyMs: number | null
  canonicalBytes: number
}

async function openStorage(store: Store): Promise<{ storage: StorageAdapter; cleanup: () => Promise<void> }> {
  if (store === 'memory') {
    const storage = new (await import('../packages/core/src/index.js')).MemoryStorage()
    return { storage, cleanup: () => storage.close() }
  }
  const dir = mkdtempSync(join(tmpdir(), 'agnes-integrity-bench-'))
  const storage = createSqliteStorage({ file: join(dir, 'ledger.db'), tablesDir: join(dir, 'tables') })
  return {
    storage,
    cleanup: async () => {
      await storage.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function measure(store: Store, mode: 'legacy' | 'protected', batch: number): Promise<Measurement> {
  const { storage, cleanup } = await openStorage(store)
  try {
    await storage.open('benchmark', { writerRunId: 'bench', ttlMs: 3_600_000 })
    let state: IntegrityState = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null }
    let canonicalBytes = 0
    const started = performance.now()
    while (state.lastSeq < eventCount) {
      const count = Math.min(batch, eventCount - state.lastSeq)
      const events = Array.from({ length: count }, (_, index) => event(state.lastSeq + index + 1))
      if (mode === 'protected') {
        const assigned = events.map((item, index) => ({ ...item, seq: state.lastSeq + index + 1 }))
        const next = prepareIntegrity('benchmark', assigned, state)
        canonicalBytes += next.canonicalBytes
        await storage.commit('benchmark', {
          events,
          integrity: next.entries,
          expectedWriterRunId: 'bench',
        })
        state = next.state
      } else {
        await storage.commit('benchmark', { events, expectedWriterRunId: 'bench' })
        state = { ...state, lastSeq: state.lastSeq + count, legacyThroughSeq: state.lastSeq + count }
      }
    }
    const appendMs = performance.now() - started
    let verifyMs: number | null = null
    if (mode === 'protected') {
      const verifyStarted = performance.now()
      await verifyLedger(storage, 'benchmark', eventCount)
      verifyMs = performance.now() - verifyStarted
    }
    return { store, mode, batch, appendMs, verifyMs, canonicalBytes }
  } finally {
    await cleanup()
  }
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * p) - 1] as number
}

// Warm each implementation and JIT path outside the measured samples.
for (const store of ['memory', 'sqlite'] as const) {
  await measure(store, 'legacy', 32)
  await measure(store, 'protected', 32)
}

const measurements: Measurement[] = []
for (const store of ['memory', 'sqlite'] as const) {
  for (const batch of batches) {
    for (let run = 0; run < runs; run++) {
      measurements.push(await measure(store, 'legacy', batch))
      measurements.push(await measure(store, 'protected', batch))
    }
  }
}

const summary = []
for (const store of ['memory', 'sqlite'] as const) {
  for (const batch of batches) {
    const legacy = measurements.filter((m) => m.store === store && m.batch === batch && m.mode === 'legacy')
    const protectedRows = measurements.filter(
      (m) => m.store === store && m.batch === batch && m.mode === 'protected',
    )
    const legacyP95 = percentile(
      legacy.map((m) => m.appendMs / eventCount),
      0.95,
    )
    const protectedP95 = percentile(
      protectedRows.map((m) => m.appendMs / eventCount),
      0.95,
    )
    const verifyP95 = percentile(
      protectedRows.map((m) => (m.verifyMs as number) / eventCount),
      0.95,
    )
    summary.push({
      store,
      batch,
      events: eventCount,
      runs,
      canonicalBytes: protectedRows[0]?.canonicalBytes,
      legacyP95MsPerEvent: legacyP95,
      protectedP95MsPerEvent: protectedP95,
      addedP95MsPerEvent: protectedP95 - legacyP95,
      regressionPercent: ((protectedP95 - legacyP95) / legacyP95) * 100,
      verifyP95EventsPerSecond: 1000 / verifyP95,
    })
  }
}

process.stdout.write(`${JSON.stringify({ node: process.version, summary }, null, 2)}\n`)
