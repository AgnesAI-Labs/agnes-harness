import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntimeInboxFixture } from '@agnes/extension-api/testkit'
import { describe, expect, it } from 'vitest'
import { openInteractionStore } from './interaction.js'

const provider = fileURLToPath(new URL('./interaction.ts', import.meta.url))
const root = fileURLToPath(new URL('../../../..', import.meta.url))

type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

/** Runs the provider CLI; `onOutput` sees stdout so far and may kill the child. */
function runChild(
  args: readonly string[],
  onOutput?: (stdout: string, child: ChildProcess) => void,
): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', provider, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      if (settled) return
      settled = true
      reject(new Error(`interaction child timed out\n${stderr}\n${stdout}`))
    }, 15_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      onOutput?.(stdout, child)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

describe('reference interaction durability', () => {
  it('keeps committed answers and wakes across a kill, drops the open write and wakes the waiter once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reference-interaction-kill-'))
    const database = join(directory, 'interaction.sqlite')
    const inbox = createRuntimeInboxFixture()
    let woken = 0
    try {
      const held = await runChild(['hold', database], (stdout, child) => {
        if (stdout.includes('\n')) child.kill('SIGKILL')
      })
      expect(held.signal).toBe('SIGKILL')
      expect(held.stdout).toMatch(/^READY \S+ \S+\n$/)
      const [, a, b] = held.stdout.trim().split(' ')
      const key = `${a}@2`
      const read = async () => {
        const result = await runChild(['read', database, a ?? '', b ?? ''])
        expect(result.code).toBe(0)
        return JSON.parse(result.stdout)
      }
      expect(await read()).toEqual({
        a: 'answered@2',
        b: 'pending@1',
        responses: ['accepted', 'not-accepted'],
        wakes: [`${key} pending`],
      })

      inbox.registerWaiter(key, () => void woken++)
      const delivered = await runChild(['deliver', database], (stdout, child) => {
        if (!stdout.includes(`DELIVERED ${key}\n`)) return
        // The wake reached the inbox; the child dies before it records the acknowledgement.
        inbox.notify(key)
        child.kill('SIGKILL')
      })
      expect(delivered.signal).toBe('SIGKILL')
      expect(woken).toBe(1)
      expect((await read()).wakes).toEqual([`${key} pending`])

      const store = openInteractionStore(database)
      try {
        const sink = async (wake: { deliveryKey: string }) => ({
          ok: true as const,
          value: { deliveryId: inbox.notify(wake.deliveryKey).deliveryId },
        })
        expect(await store.flush(sink)).toEqual({ acked: 1, retrying: 0, dead: 0 })
        expect(await store.flush(sink)).toEqual({ acked: 0, retrying: 0, dead: 0 })
        const status = store.responseStatus('resp-a')
        expect(status.ok && status.value.status).toBe('applied')
      } finally {
        store.close()
      }
      expect(woken).toBe(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
