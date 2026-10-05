import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { attempt } from './fixtures/usage-ledger.js'

const entry = fileURLToPath(new URL('./fixtures/usage-ledger-process.ts', import.meta.url))
function run(dir: string, stage: string) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', entry, dir, stage], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (bytes) => {
        stdout += String(bytes)
      })
      child.stderr.on('data', (bytes) => {
        stderr += String(bytes)
      })
      child.on('error', reject)
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
    },
  )
}
describe('Usage ledger recovery across process death', () => {
  it.each(['usage-disconnect', 'ledger-disconnect', 'ledger-failure'])(
    'recovers %s without a duplicate C33 fact or original ledger row',
    async (stage) => {
      const dir = mkdtempSync(join(tmpdir(), 'host-usage-ledger-cold-'))
      try {
        const killed = await run(dir, stage)
        expect(killed.signal, killed.stderr).toBe('SIGKILL')
        const recovered = await run(dir, 'recover')
        expect(recovered.code, recovered.stderr).toBe(0)
        const result = JSON.parse(recovered.stdout)
        expect(result.pendingBefore).toEqual([attempt()])
        expect(result.replies.every((reply: { ok: boolean }) => reply.ok)).toBe(true)
        expect(result.replies[0]).toEqual(result.replies[1])
        expect(result.facts).toBe(2)
        expect(result.rows).toMatchObject([
          { effect_id: 'effect-attempt-1' },
          { effect_id: 'effect-attempt-2' },
        ])
        expect(result.pendingAfter).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
