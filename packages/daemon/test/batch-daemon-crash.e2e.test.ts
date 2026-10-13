import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BatchStatus } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { batchClient, batchWorkspace, setControl, traceOf } from './batch-daemon-harness.js'

const child = fileURLToPath(new URL('./fixtures/batch-daemon-child.ts', import.meta.url))
const made: string[] = []
const running: ChildProcess[] = []
afterEach(() => {
  for (const daemon of running.splice(0)) daemon.kill('SIGKILL')
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One daemon process; resolves with its socket once it serves. */
async function startDaemon(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<{ process: ChildProcess; socket: string }> {
  const daemon = spawn(process.execPath, ['--import', 'tsx', child, root, '6000'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  running.push(daemon)
  let stderr = ''
  daemon.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const socket = await new Promise<string>((resolve, reject) => {
    let out = ''
    daemon.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const ready = /^ready (.+)$/mu.exec(out)
      if (ready) resolve(ready[1] as string)
    })
    daemon.once('exit', (code) => reject(new Error(`daemon exited (${code}) before serving: ${stderr}`)))
  })
  return { process: daemon, socket }
}

it('finishes every item once after the daemon is killed mid-turn and started again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-batch-crash-'))
  made.push(dir)
  const root = batchWorkspace(dir, ['a.txt', 'b.txt', 'c.txt', 'd.txt'])
  const trace = join(root, 'trace.log')
  const control = join(root, 'control.json')
  const env = { AGNES_BATCH_TRACE: trace, AGNES_BATCH_CONTROL: control }
  setControl(control, { block: true })

  const first = await startDaemon(root, env)
  const client = await batchClient(first.socket)
  const started = await client.call('_agnes/v1/batch.start', {
    cwd: root,
    spec: {
      dir: 'items',
      prompt: 'Look at {{name}}',
      schema: { type: 'object', properties: { item: { type: 'integer' } }, required: ['item'] },
      concurrency: 2,
    },
  })
  const { batchId } = started.result as BatchStatus
  // Two items have read their file and are mid-turn when the daemon dies without any clean-up.
  await vi.waitFor(
    () =>
      expect(
        traceOf(trace)
          .filter((line) => line.startsWith('block '))
          .sort(),
      ).toEqual(['block 1', 'block 2']),
    { timeout: 30_000, interval: 50 },
  )
  client.close()
  first.process.kill('SIGKILL')
  await once(first.process, 'exit')

  // The restarted daemon resumes the batch on its own: the two interrupted jobs are reclaimed when
  // their lease runs out and run again in the same item sessions; the rest start as slots free up.
  setControl(control, { block: false })
  const second = await startDaemon(root, env)
  const again = await batchClient(second.socket)
  let status: BatchStatus | undefined
  await vi.waitFor(
    async () => {
      status = (await again.call('_agnes/v1/batch.status', { batchId })).result as BatchStatus
      expect(status.status).not.toBe('running')
      expect(status.summary).toBeDefined()
    },
    { timeout: 60_000, interval: 200 },
  )
  expect(status).toMatchObject({
    status: 'completed',
    counts: { total: 4, done: 4, failed: 0, cancelled: 0 },
  })
  const rows = readFileSync(join(root, 'agh-batch', batchId, 'results.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { output: unknown }).output)
  expect(rows).toEqual([1, 2, 3, 4].map((item) => ({ item, read: true })))
  const lines = traceOf(trace)
  const times = (line: string) => lines.filter((seen) => seen === line).length
  // Interrupted items ran a second time; items never started before the kill ran once; every item
  // answered exactly once.
  expect([1, 2, 3, 4].map((n) => times(`start ${n}`))).toEqual([2, 2, 1, 1])
  expect([1, 2, 3, 4].map((n) => times(`answer ${n}`))).toEqual([1, 1, 1, 1])
  again.close()
}, 120_000)
