import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const entry = fileURLToPath(new URL('./fixtures/resources-pin-process.ts', import.meta.url))

async function waitUntilReady(directory: string, child: ChildProcess, stderr: () => string) {
  const ready = join(directory, 'pin-ready')
  const started = Date.now()
  while (!existsSync(ready)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`holder exited before the pin was durable: ${stderr()}`)
    }
    if (Date.now() - started > 20_000) throw new Error(`pin ready timed out: ${stderr()}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

it.each(['default', 'reference'] as const)(
  '%s keeps the first resource pin after the holder is killed',
  async (provider) => {
    const directory = mkdtempSync(join(tmpdir(), 'resource-pin-kill-'))
    let stderr = ''
    const child = spawn(process.execPath, ['--import', 'tsx', entry, provider, directory, 'hold'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    try {
      await waitUntilReady(directory, child, () => stderr)
      child.kill('SIGKILL')
      const killed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('killed holder did not exit')), 10_000)
          child.once('exit', (code, signal) => {
            clearTimeout(timer)
            resolve({ code, signal })
          })
        },
      )
      expect(killed.signal).toBe('SIGKILL')
      const read = spawnSync(process.execPath, ['--import', 'tsx', entry, provider, directory, 'read'], {
        encoding: 'utf8',
        timeout: 30_000,
      })
      expect(read.status, read.stderr).toBe(0)
      const body = JSON.parse(read.stdout) as {
        retained: { version: string }
        released: { state: string }
      }
      expect(body.retained.version).toBe('1')
      expect(body.released.state).toBe('released')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
