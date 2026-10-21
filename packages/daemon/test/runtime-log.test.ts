import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openRuntimeLog, workerStderrEvidence } from '../src/supervisor/runtime-log.js'

it('bounds and rotates runtime facts, omits worker text and detaches the crash listener', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agh-runtime-log-'))
  const source = new EventEmitter()
  try {
    const evidence = workerStderrEvidence()
    evidence.push(Buffer.from('private-fixture ERR_MODULE_'))
    evidence.push(Buffer.from('NOT_FOUND private-fixture'))
    evidence.push(Buffer.alloc(100_000))
    expect(evidence.snapshot()).toEqual({ bytes: 65536, code: 'ERR_MODULE_NOT_FOUND' })
    const log = openRuntimeLog(directory, source as unknown as Pick<NodeJS.Process, 'on' | 'off'>, 300)
    log.record({
      kind: 'worker.log',
      level: 'info',
      message: 'Default composition prewarm ready rssBefore=100 rssAfter=200',
    })
    const diagnostic = JSON.parse(
      readFileSync(join(directory, 'audit/runtime.jsonl'), 'utf8').trim().split('\n').at(-1)!,
    )
    expect(diagnostic.detail).toEqual({ prewarm: 'ready', rssBefore: 100, rssAfter: 200, level: 'info' })
    expect(source.listenerCount('uncaughtExceptionMonitor')).toBe(1)
    for (let i = 0; i < 20; i++)
      log.record({
        kind: 'worker.stderr',
        detail: { bytes: 65536, message: 'private-fixture', path: '/private/fixture', code: 'UNTRUSTED' },
      })
    log.record({ kind: 'worker.exited', detail: { exitCode: 7, signal: 'SIGTERM' } })
    source.emit('uncaughtExceptionMonitor', new Error('private-fixture'), 'uncaughtException')
    await log.close()
    await log.close()
    expect(source.listenerCount('uncaughtExceptionMonitor')).toBe(0)
    const file = join(directory, 'audit', 'runtime.jsonl')
    const bytes = readFileSync(file, 'utf8') + readFileSync(`${file}.1`, 'utf8')
    expect(bytes).toContain('daemon.stopped')
    expect(bytes).toContain('daemon.crashed')
    expect(bytes).toContain('worker.exited')
    expect(bytes).not.toContain('private-fixture')
    expect(bytes).not.toContain('UNTRUSTED')
    expect(statSync(file).size).toBeLessThan(600)
    expect(statSync(`${file}.1`).size).toBeLessThan(600)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
