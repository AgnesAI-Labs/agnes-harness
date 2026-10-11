import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openRuntimeLog, RUNTIME_LOG } from '../src/runtime-log.js'
import { runAgnesd } from '../src/supervisor/supervisor.js'

const state = vi.hoisted(() => ({ close: undefined as (() => Promise<void>) | undefined }))
vi.mock('../src/supervisor/lifecycle.js', async (original) => ({
  ...(await original<typeof import('../src/supervisor/lifecycle.js')>()),
  installSignals: (close: () => Promise<void>) => {
    state.close = close
    return () => {}
  },
}))
vi.mock('../src/supervisor/stop-request.js', async (original) => ({
  ...(await original<typeof import('../src/supervisor/stop-request.js')>()),
  watchWindowsStopRequest: () => () => {},
}))

type Row = { at: string; kind: string; detail?: Record<string, unknown> }
// Assembled at run time so no credential-shaped literal sits in this file for the secrets guard.
const FAKE_TOKEN = ['sk', 'live', '0123456789abcdef'].join('-')
const rows = (file: string): Row[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agnes-runtime-log-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('runtime log', () => {
  it('keeps lifecycle records and worker log lines, redacted and bounded, and nothing else', async () => {
    const source = new EventEmitter()
    const log = openRuntimeLog(dir, source as never)
    log.record({ kind: 'worker.log', sessionKey: 's-1', level: 'info', message: 'session woke in 12 ms' })
    log.record({ kind: 'worker.log', sessionKey: 's-1', level: 'debug', message: 'chatter' })
    log.record({ kind: 'worker.log', sessionKey: 's-1', level: 'warn', message: 'x'.repeat(5000) })
    log.record({
      kind: 'worker.exited',
      detail: {
        worker: '@shared',
        code: 134,
        signal: null,
        sessions: ['s-1', 's-2'],
        stderr: ['FATAL ERROR: Reached heap limit', `Authorization: Bearer ${FAKE_TOKEN}`],
      },
    })
    log.record({
      kind: 'session.interrupted',
      detail: { session: 's-1', reason: 'frame exceeds byte limit' },
    })
    log.record({ kind: 'daemon.request_failed', detail: { method: 'x' } })
    log.record({ kind: 'daemon.notice', notice: {} })
    log.record('not a record')
    await log.close()

    const written = rows(join(dir, 'audit', RUNTIME_LOG))
    expect(written.map((row) => row.kind)).toEqual([
      'daemon.started',
      'worker.log',
      'worker.log',
      'worker.exited',
      'session.interrupted',
      'daemon.stopped',
    ])
    expect(written[0]?.detail).toMatchObject({ pid: process.pid, node: process.versions.node })
    expect(written[1]?.detail).toEqual({ session: 's-1', level: 'info', message: 'session woke in 12 ms' })
    expect(written[2]?.detail?.message).toBe(`${'x'.repeat(2000)}…`)
    // One stderr line at a time: a secret-looking line is dropped, the rest survive.
    expect(written[3]?.detail).toMatchObject({
      worker: '@shared',
      code: 134,
      sessions: ['s-1', 's-2'],
      stderr: ['FATAL ERROR: Reached heap limit', '<redacted>'],
    })
    expect(JSON.stringify(written)).not.toContain(FAKE_TOKEN)
  })

  it('records an uncaught exception before the process ends, and detaches on close', async () => {
    const source = new EventEmitter()
    const log = openRuntimeLog(dir, source as never)
    source.emit(
      'uncaughtExceptionMonitor',
      new TypeError('cannot read properties of undefined'),
      'unhandledRejection',
    )
    log.error('listener', new Error('listen EADDRINUSE'))
    await log.close()
    expect(source.listenerCount('uncaughtExceptionMonitor')).toBe(0)
    const written = rows(join(dir, 'audit', RUNTIME_LOG))
    expect(written.map((row) => row.kind)).toEqual([
      'daemon.started',
      'daemon.crashed',
      'daemon.error',
      'daemon.stopped',
    ])
    expect(written[1]?.detail).toMatchObject({
      origin: 'unhandledRejection',
      name: 'TypeError',
      message: 'cannot read properties of undefined',
    })
    expect(Array.isArray(written[1]?.detail?.stack)).toBe(true)
    expect(written[2]?.detail).toMatchObject({ during: 'listener', message: 'listen EADDRINUSE' })
  })

  it('is written by the daemon beside the request audit, which keeps only failed requests', async () => {
    const root = join(dir, 'home')
    createPrivateDirectorySync(root)
    let audit: ((record: unknown) => void) | undefined
    let dataDir = ''
    await runAgnesd(
      { profile: 'local-dev', home: root, workspace: root },
      {
        startProduction: async (options: {
          audit?: (record: unknown) => void
          config: { dataDir: string }
        }) => {
          audit = options.audit
          dataDir = options.config.dataDir
          return {
            socketPath: join(root, 'daemon.sock'),
            owner: { pid: process.pid, generation: 1 },
            close: async () => {},
          } as never
        },
        publishDiscovery: async () => undefined as never,
        removeDiscovery: async () => {},
      },
    )
    audit?.({
      kind: 'worker.exited',
      detail: { worker: '@shared', code: 1, signal: null, sessions: ['s-1'] },
    })
    audit?.({
      kind: 'daemon.request_failed',
      detail: { diagnosticId: 'd-1', method: 'm', errorCode: 'UNKNOWN' },
    })
    await state.close?.()
    expect(rows(join(dataDir, 'audit', RUNTIME_LOG)).map((row) => row.kind)).toEqual([
      'daemon.started',
      'worker.exited',
      'daemon.stopped',
    ])
    expect(rows(join(dataDir, 'audit', 'daemon.jsonl')).map((row) => row.kind)).toEqual([
      'daemon.request_failed',
    ])
  })

  it('says why the daemon did not start', async () => {
    const root = join(dir, 'home')
    createPrivateDirectorySync(root)
    const failure = new Error('injected startup failure')
    let dataDir = ''
    await expect(
      runAgnesd(
        { profile: 'local-dev', home: root, workspace: root },
        {
          startProduction: async (options: { config: { dataDir: string } }) => {
            dataDir = options.config.dataDir
            throw failure
          },
          publishDiscovery: async () => undefined as never,
          removeDiscovery: async () => {},
        },
      ),
    ).rejects.toBe(failure)
    const written = rows(join(dataDir, 'audit', RUNTIME_LOG))
    expect(written.map((row) => row.kind)).toEqual(['daemon.started', 'daemon.error', 'daemon.stopped'])
    expect(written[1]?.detail).toMatchObject({ during: 'startup', message: 'injected startup failure' })
  })
})
