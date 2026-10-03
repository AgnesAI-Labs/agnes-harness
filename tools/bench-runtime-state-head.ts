// Times one session's state head checks.
// createRun compares a cached head and checks only the new commit.
// open always re-reads that session, including after the head is already cached.
//
//   tsx tools/bench-runtime-state-head.ts latency
//   tsx tools/bench-runtime-state-head.ts build --events <n> --file <path>
//   tsx tools/bench-runtime-state-head.ts open --file <path>
//   tsx tools/bench-runtime-state-head.ts opens --file <path> --runs <n>
//   tsx tools/bench-runtime-state-head.ts rss-unit
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import type {
  CallContext,
  RunAdmission,
  StateAuthorityRef,
} from '../packages/extension-api/src/runtime/index.ts'
import { createRuntimeStateStore } from '../packages/host/src/runtime/providers/state.ts'
import { RuntimeStateDatabase } from '../packages/host/src/runtime/state/transactions.ts'
import { createAdmissionAcceptanceIssuer } from '../packages/host/test/helpers/runtime-admission-issuer.ts'
import { jcs } from '../packages/protocol/src/jcs.ts'

const authority: StateAuthorityRef = {
  authorityId: 'authority-bench',
  tenantId: 'tenant-bench',
  authorityEpoch: 1,
}
const admittedAt = '2026-04-01T00:00:00.000Z'

function digestOf(value: unknown): string {
  return createHash('sha256').update(jcs(value)).digest('hex')
}

function inline(value: unknown) {
  const canonical = jcs(value)
  const schemaDocument = { $id: 'agh.test/json@1', type: 'object' }
  return {
    kind: 'inline' as const,
    schema: { typeId: 'agh.test/json@1', revision: 1, digest: digestOf(schemaDocument) },
    value,
    digest: digestOf(value),
    bytes: Buffer.byteLength(canonical),
  }
}

function context(): CallContext {
  return {
    principalRef: 'principal-bench',
    scope: { installationId: 'install-bench', kind: 'installation' as const },
    bindingId: 'binding-bench',
    invocationId: 'invocation-bench',
    deadline: '2026-05-01T00:00:00.000Z',
    traceRef: 'trace-bench',
    authorizationRef: 'auth-bench',
    signal: new AbortController().signal,
  }
}

function admission(index: number): RunAdmission {
  const ticketId = `ticket-${index}`
  const text = `bench-${index}`
  return {
    ticketId,
    fingerprint: digestOf({ ticketId, text }),
    releaseSetId: 'release-bench',
    bindingId: 'binding-bench',
    packagePinReceipt: inline({ pin: 'package' }),
    runId: `run-${index}`,
    sessionId: 'session-bench',
    lane: 'main',
    workspaceId: 'workspace-bench',
    input: inline({ text }),
    admittedAt,
    deadline: '2026-05-01T00:00:00.000Z',
    conversation: null,
  }
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function requiredFlag(name: string): string {
  const value = flag(name)
  if (!value) throw new Error(`${name} is required`)
  return value
}

function positive(name: string, fallback: number): number {
  const raw = flag(name)
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function openStore(file: string) {
  const options = { file, authority, now: () => Date.parse(admittedAt) }
  const database = new RuntimeStateDatabase(options)
  try {
    const issuer = createAdmissionAcceptanceIssuer(database, authority, options.now, context())
    try {
      const store = createRuntimeStateStore(options, database)
      return {
        store,
        issue: issuer.issue,
        ready: issuer.ready,
        close() {
          issuer.close()
          store.close()
        },
      }
    } catch (error) {
      issuer.close()
      throw error
    }
  } catch (error) {
    database.close()
    throw error
  }
}

function eventCount(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    return row.n
  } finally {
    db.close()
  }
}

function mean(samples: readonly number[]): number {
  const total = samples.reduce((sum, sample) => sum + sample, 0)
  return samples.length === 0 ? 0 : total / samples.length
}

/** Nearest-rank percentile. A window of 10 uses the largest sample as P95. */
function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] ?? 0
}

function memory() {
  const usage = process.memoryUsage()
  return {
    rssBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    maxRss: process.resourceUsage().maxRSS,
  }
}

async function writeRuns(file: string, runs: number): Promise<void> {
  const opened = openStore(file)
  try {
    for (let index = 1; index <= runs; index += 1) {
      const input = admission(index)
      const issued = await opened.issue(input, context())
      const created = await opened.store.createRun(input, issued)
      if (!created.ok) throw new Error(`createRun ${index} failed: ${created.error.detailCode}`)
      if (index % 5_000 === 0) console.error(`wrote ${index} runs`)
    }
  } finally {
    opened.close()
  }
}

async function latency(): Promise<void> {
  const runs = positive('--runs', 300)
  const directory = mkdtempSync(join(tmpdir(), 'agnes-state-head-'))
  const file = join(directory, 'state.sqlite')
  const opened = openStore(file)
  const samples: number[] = []
  try {
    for (let index = 1; index <= runs; index += 1) {
      const input = admission(index)
      const issued = await opened.issue(input, context())
      const started = performance.now()
      const created = await opened.store.createRun(input, issued)
      samples.push(performance.now() - started)
      if (!created.ok) throw new Error(`createRun ${index} failed: ${created.error.detailCode}`)
    }
    const readStarted = performance.now()
    const read = await opened.store.open(
      {
        requestId: 'bench-read',
        authority,
        sessionId: 'session-bench',
        mode: 'read',
        writerId: null,
        ttlMs: null,
      },
      context(),
    )
    const readOpenMs = performance.now() - readStarted
    if (!read.ok) throw new Error(`read open failed: ${read.error.detailCode}`)
    const writeStarted = performance.now()
    const write = await opened.store.open(
      {
        requestId: 'bench-write',
        authority,
        sessionId: 'session-bench',
        mode: 'write',
        writerId: 'writer-bench',
        ttlMs: 1_000,
      },
      context(),
    )
    const writeOpenMs = performance.now() - writeStarted
    if (!write.ok) throw new Error(`write open failed: ${write.error.detailCode}`)
    const windows = [
      [1, 10],
      [141, 150],
      [291, 300],
    ] as const
    console.log(
      JSON.stringify({
        mode: 'latency',
        runs,
        events: eventCount(file),
        note: 'readOpen and writeOpen still verify the whole session after the head cache is warm',
        windows: windows.map(([from, to]) => {
          const slice = samples.slice(from - 1, to)
          return {
            from,
            to,
            meanMs: mean(slice),
            p95Ms: percentile(slice, 95),
            minMs: Math.min(...slice),
            maxMs: Math.max(...slice),
          }
        }),
        readOpenMs,
        writeOpenMs,
      }),
    )
  } finally {
    opened.close()
  }
}

async function build(): Promise<void> {
  const events = positive('--events', 10_000)
  const file = requiredFlag('--file')
  if (events < 2) throw new Error('--events must include the format event and one commit')
  const started = performance.now()
  await writeRuns(file, events - 1)
  console.log(
    JSON.stringify({ mode: 'build', file, events: eventCount(file), buildMs: performance.now() - started }),
  )
}

async function openOnce(file: string, requestId: string): Promise<number> {
  const openedStore = openStore(file)
  try {
    await openedStore.ready
    const started = performance.now()
    const opened = await openedStore.store.open(
      {
        requestId,
        authority,
        sessionId: 'session-bench',
        mode: 'read',
        writerId: null,
        ttlMs: null,
      },
      context(),
    )
    const openMs = performance.now() - started
    if (!opened.ok) throw new Error(`open failed: ${opened.error.detailCode}`)
    return openMs
  } finally {
    openedStore.close()
  }
}

async function open(): Promise<void> {
  const file = requiredFlag('--file')
  const before = memory()
  const openMs = await openOnce(file, 'bench-cold-open')
  const after = memory()
  const events = eventCount(file)
  console.log(
    JSON.stringify({
      mode: 'open',
      file,
      events,
      openMs,
      eventsPerSecond: events / (openMs / 1000),
      before,
      after,
      rssDeltaBytes: after.rssBytes - before.rssBytes,
    }),
  )
}

/** One untimed open, then `--runs` timed opens. Each open builds its own store and verifies fully. */
async function opens(): Promise<void> {
  const file = requiredFlag('--file')
  const runs = positive('--runs', 5)
  const events = eventCount(file)
  const prepareStarted = performance.now()
  const prepared = openStore(file)
  try {
    await prepared.ready
  } finally {
    prepared.close()
  }
  const prepareMs = performance.now() - prepareStarted
  const before = memory()
  await openOnce(file, 'bench-warmup-open')
  const samples: number[] = []
  const rssAfter: number[] = []
  for (let index = 1; index <= runs; index += 1) {
    samples.push(await openOnce(file, `bench-open-${index}`))
    rssAfter.push(memory().rssBytes)
  }
  const after = memory()
  const medianMs = percentile(samples, 50)
  const p95Ms = percentile(samples, 95)
  console.log(
    JSON.stringify({
      mode: 'opens',
      file,
      events,
      runs,
      prepareMs,
      note: 'prepareMs includes source installation and issuer readiness before the first open. The warmup open is outside the samples. Each sample is a new store and a full session verify.',
      samplesMs: samples,
      medianMs,
      p95Ms,
      minMs: Math.min(...samples),
      maxMs: Math.max(...samples),
      medianEventsPerSecond: events / (medianMs / 1000),
      p95EventsPerSecond: events / (p95Ms / 1000),
      before,
      after,
      rssAfter,
      rssDeltaBytes: after.rssBytes - before.rssBytes,
      maxRssDelta: after.maxRss - before.maxRss,
    }),
  )
}

function rssUnit(): void {
  const before = memory()
  const retained: Buffer[] = []
  for (let index = 0; index < 64; index += 1) retained.push(Buffer.alloc(1024 * 1024, 1))
  const after = memory()
  console.log(
    JSON.stringify({
      mode: 'rss-unit',
      allocatedBytes: retained.length * 1024 * 1024,
      before,
      after,
      maxRssDelta: after.maxRss - before.maxRss,
      rssDeltaBytes: after.rssBytes - before.rssBytes,
    }),
  )
}

const command = process.argv[2]
if (command === 'latency') await latency()
else if (command === 'build') await build()
else if (command === 'open') await open()
else if (command === 'opens') await opens()
else if (command === 'rss-unit') rssUnit()
else
  throw new Error(
    'usage: latency | build --events <n> --file <path> | open --file <path> | opens --file <path> --runs <n> | rss-unit',
  )
