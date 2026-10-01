import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const provider = fileURLToPath(new URL('./sample-provider.ts', import.meta.url))
const root = fileURLToPath(new URL('../../..', import.meta.url))

function runChild(
  args: readonly string[],
  onReady?: (child: ChildProcess) => void,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', provider, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: { code: number | null; signal: NodeJS.Signals | null }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, stdout, stderr })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      if (!settled) {
        settled = true
        reject(new Error(`sample child timed out\n${stderr}\n${stdout}`))
      }
    }, 15_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (onReady !== undefined && stdout.includes('READY\n')) onReady(child)
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
    child.on('exit', (code, signal) => finish({ code, signal }))
  })
}

describe('sample provider durability', () => {
  it('keeps a committed note after the process is killed and drops the open write', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reference-kill-'))
    const database = join(directory, 'notes.sqlite')
    try {
      const held = await runChild(['hold', database, 'kept', 'body', 'pending', 'nope'], (child) =>
        child.kill('SIGKILL'),
      )
      expect(held.signal).toBe('SIGKILL')
      const kept = await runChild(['read', database, 'kept'])
      const pending = await runChild(['read', database, 'pending'])
      expect(kept.stdout).toBe('FOUND 1 body\n')
      expect(pending.stdout).toBe('MISSING\n')
      expect(kept.code).toBe(0)
      expect(pending.code).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
