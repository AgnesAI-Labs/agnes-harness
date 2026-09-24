import { appendFileSync, createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import type { SupervisorToWorker } from '../src/supervisor/frames.js'
import { encodeFrame, JsonlDecoder } from '../src/supervisor/framing.js'

// A worker-pool.test.ts-only stand-in for worker/main.ts: it speaks the real internal wire (hello,
// gate fd, command/reply) but never touches @agnes/host, so WorkerPool's process-management and
// crash-breaker behavior can be tested without a real Host assembly. It answers 'ping' with
// `{ ok: true }` and exits non-zero on a 'crash' method - a method that exists only here, not in the
// real WorkerMethod union, purely to give the pool test a deterministic way to make a real child
// process die.

const socketPath = process.env.AGNES_SUPERVISOR_SOCKET
const token = process.env.AGNES_WORKER_TOKEN
const workerKey = process.env.AGNES_WORKER_KEY
const generation = Number(process.env.AGNES_WORKER_GENERATION)
const resourceControl = process.env.AGNES_RESOURCE_CONTROL === '1'
const resourceProbeFile = process.env.AGNES_RESOURCE_PROBE_FILE
const durableFile = process.env.AGNES_WORKER_ROOT
  ? join(process.env.AGNES_WORKER_ROOT, '.fake-worker-sessions.json')
  : process.env.AGNES_PROFILE_FILE
    ? join(dirname(process.env.AGNES_PROFILE_FILE), '.fake-worker-sessions.json')
    : undefined
const durableSeq = new Map<string, number>(
  durableFile && existsSync(durableFile)
    ? Object.entries(JSON.parse(readFileSync(durableFile, 'utf8')) as Record<string, number>)
    : [],
)
const saveDurableSeq = (): void => {
  if (durableFile) writeFileSync(durableFile, JSON.stringify(Object.fromEntries(durableSeq)))
}
let delayedExit = false
if (!socketPath || !token || !workerKey || !Number.isSafeInteger(generation) || generation < 1)
  throw new Error('fake-worker missing required AGNES_* env vars')

const socket = connect(socketPath)
socket.once('close', () => {
  if (delayedExit) {
    // Keep the process alive after transport loss so WorkerPool tests can distinguish link death
    // from the stronger child-exit boundary used by revision cleanup.
    setTimeout(() => undefined, 250)
  }
})
socket.once('connect', () => {
  socket.write(
    encodeFrame({
      kind: 'hello',
      token,
      workerKey,
      workerGeneration: generation,
      profileHash: 'h1',
      ...(resourceControl
        ? {
            workerKind: 'service' as const,
            resources: { snapshotRevision: 'a'.repeat(64), skills: [], mcp: [] },
          }
        : { workerKind: 'session' as const }),
    }),
  )
  // Drains the start-gate pipe so the supervisor's write to it never backs up; this fake worker does
  // not withhold command processing on it (worker-pool.test.ts does not depend on that ordering).
  createReadStream('', { fd: 3 }).once('data', () => undefined)

  const dec = new JsonlDecoder()
  socket.on('data', (chunk: Buffer) => {
    for (const f of dec.feed(chunk) as SupervisorToWorker[]) {
      if (!('kind' in f)) {
        // A runtime target offered while starting: die on it, as a plugin that kills the process would.
        if (process.env.AGNES_FAKE_BOOT === 'exit') process.exit(3)
        if (process.env.AGNES_FAKE_BOOT === 'fail' && 'artifact' in f) {
          const artifact = (f as { artifact: { digest: string; identity: unknown } }).artifact
          socket.write(
            encodeFrame({
              type: 'runtime.apply_failed',
              workerKind: 'session',
              workerKey: '@shared',
              generation,
              digest: artifact.digest,
              identity: artifact.identity,
              phase: 'apply',
              message: 'plugin threw while starting',
            } as never),
          )
        }
        continue
      }
      if (f.kind === 'session.open') {
        if (f.sessionKey.endsWith(':delayed-exit')) delayedExit = true
        socket.write(
          encodeFrame({
            kind: 'reply',
            requestId: f.requestId,
            sessionKey: f.sessionKey,
            result: {
              sessionKey: f.sessionKey,
              writerRunId: `r:${f.sessionKey}`,
              generation: 1,
              lastSeq: durableSeq.get(f.sessionKey) ?? 0,
            },
          }),
        )
        continue
      }
      if (f.kind === 'session.tail' || f.kind === 'session.close') {
        socket.write(
          encodeFrame({ kind: 'reply', requestId: f.requestId, sessionKey: f.sessionKey, result: {} }),
        )
        continue
      }
      if (f.kind !== 'command') continue
      // `f.method` is typed as the real (closed) `WorkerMethod` union, which does not include
      // 'crash' - cast through `string` since this test's whole point is sending a method outside
      // that union (see the file header comment).
      if ((f.method as string) === 'crash') process.exit(1)
      if ((f.method as string) === 'emit-test-event' && 'sessionKey' in f) {
        const seq = Number((f.params as { seq?: unknown }).seq)
        durableSeq.set(f.sessionKey, seq)
        saveDurableSeq()
        socket.write(
          encodeFrame({
            kind: 'event',
            sessionKey: f.sessionKey,
            seq,
            event: { seq, type: 'request/header' },
          }),
        )
      }
      if (resourceControl && String(f.method).startsWith('activation.')) {
        if (resourceProbeFile) appendFileSync(resourceProbeFile, `${String(f.method)}\n`)
        socket.write(
          encodeFrame({
            kind: 'reply',
            requestId: f.requestId,
            error: { code: 'E_PROBE', message: 'resource workers have no Host activation' },
          }),
        )
        continue
      }
      const sessionLastSeq = 'sessionKey' in f ? (durableSeq.get(f.sessionKey) ?? 0) : undefined
      socket.write(
        encodeFrame({
          kind: 'reply',
          requestId: f.requestId,
          ...('sessionKey' in f ? { sessionKey: f.sessionKey } : {}),
          result: {
            ok: true,
            ...(sessionLastSeq === undefined || sessionLastSeq === 0 ? {} : { lastSeq: sessionLastSeq }),
          },
        }),
      )
    }
  })
})
