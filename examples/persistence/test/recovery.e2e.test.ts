import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { persistenceProvider } from '../src/index.js'

it('excludes another process and recovers committed state and leases after a writer is killed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-jsonl-crash-'))
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { pathToFileURL } from 'node:url'
    const { persistenceProvider } = await import(pathToFileURL(process.argv[1]).href)
    const store = await persistenceProvider.open({ dataDir: process.argv[2], clock: () => 1000 })
    await store.open('session', { writerRunId: 'crashed', ttlMs: 100 })
    await store.commit('session', {
      expectedWriterRunId: 'crashed',
      events: [{ id: 'event', ts: '2026-10-07T00:00:00Z', type: 'user/message', data: { text: 'durable' } }],
      opState: { lane: 'main', data: { phase: 'open' } },
    })
    store.metadata.namespace('owner', 'config').set('enabled', true)
    await store.childControl.ensureRootScope('session', 9007199254740993n)
    process.stdout.write('ready\\n')
    setInterval(() => {}, 1000)
  `,
      entry,
      dir,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const exit = once(child, 'exit')
  let stderr = ''
  child.stderr.on('data', (bytes) => {
    stderr += String(bytes)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''
      child.stdout.on('data', (bytes) => {
        output += String(bytes)
        if (output.includes('ready\n')) resolve()
      })
      child.once('error', reject)
      child.once('exit', () => reject(new Error(`writer exited before readiness: ${stderr}`)))
    })
    expect(() => persistenceProvider.open({ dataDir: dir })).toThrow(/already open/)
    child.kill('SIGKILL')
    await exit
    const restored = await persistenceProvider.open({ dataDir: dir, clock: () => 5000 })
    try {
      expect((await restored.scan('session', { limit: 1 }))[0]?.data).toEqual({ text: 'durable' })
      if (!restored.metadata || !restored.reclaim || !restored.childControl)
        throw new Error('Host ports missing')
      expect(restored.metadata.namespace('owner', 'config').get('enabled')).toBe(true)
      expect(await restored.childControl.projectTree('session')).toMatchObject({
        capMicro: 9007199254740993n,
      })
      const lease = restored.reclaim.listExpired(5000).find((row) => row.sessionKey === 'session')
      if (!lease) throw new Error('expired writer lease missing')
      expect(restored.reclaim.claimForReclaim('session', 'stale', lease.until, 5000)).toBeNull()
      expect(restored.reclaim.claimForReclaim('session', lease.runId, lease.until, 5000)).toEqual({
        seq: 1,
        opState: { seq: 1, data: { phase: 'open' } },
      })
      await restored.childControl.clearWriterLease?.('session')
      expect(await restored.open('session', { writerRunId: 'replacement', ttlMs: 100 })).toMatchObject({
        lastSeq: 1,
      })
    } finally {
      await restored.close()
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exit
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)
