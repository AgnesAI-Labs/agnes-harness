import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallContext } from '@agnes/extension-api/runtime'
import { describe, expect, it } from 'vitest'
import { createWorkspaceService } from '../../src/runtime/providers/workspace.js'
import { openWorkspaceStore } from '../../src/runtime/workspace-leases.js'

const child = fileURLToPath(new URL('./workspace-ownership-child.ts', import.meta.url))
const root = fileURLToPath(new URL('../../../..', import.meta.url))

function hold(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const subprocess: ChildProcess = spawn(process.execPath, ['--import', 'tsx', child, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let lease: string | undefined
    const finish = (error?: Error, lease?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(lease ?? '')
    }
    const timer = setTimeout(() => {
      subprocess.kill('SIGKILL')
      finish(new Error(`ownership child timed out\n${stderr}\n${stdout}`))
    }, 15_000)
    const output = subprocess.stdout
    const errors = subprocess.stderr
    if (output === null || errors === null) {
      finish(new Error('ownership child pipes are missing'))
      return
    }
    output.setEncoding('utf8')
    errors.setEncoding('utf8')
    output.on('data', (chunk: string) => {
      stdout += chunk
      if (lease !== undefined || !stdout.includes('READY\n')) return
      const match = stdout.match(/LEASE (.+)\n/)
      lease = match?.[1]
      subprocess.kill('SIGKILL')
      if (!lease) finish(new Error(`missing lease line\n${stdout}`))
    })
    errors.on('data', (chunk: string) => {
      stderr += chunk
    })
    subprocess.on('error', (error) => finish(error))
    subprocess.on('close', (code, signal) => {
      if (signal === 'SIGKILL' && lease !== undefined) {
        finish(undefined, lease)
        return
      }
      finish(new Error(`ownership child exited ${code ?? 'null'}\n${stderr}\n${stdout}`))
    })
  })
}

function call(invocationId: string): CallContext {
  return {
    principalRef: 'actor-2',
    scope: { kind: 'workspace', installationId: 'install-1', runtimeId: 'runtime-1', workspaceId: 'ws-1' },
    bindingId: 'binding-1',
    invocationId,
    deadline: '2030-01-01T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-1',
    signal: new AbortController().signal,
  }
}

describe('workspace ownership across a killed process', () => {
  it('keeps the exclusive lease and the work file after the holder is killed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workspace-kill-'))
    const store = join(directory, 'store')
    const work = join(directory, 'work')
    const handles: ReturnType<typeof openWorkspaceStore>[] = []
    try {
      const expiresAt = await hold([store, work])
      expect(expiresAt).toMatch(/Z$/)
      expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('kept')
      const expiry = Date.parse(expiresAt)
      const live = openWorkspaceStore({ directory: store, now: () => expiry - 1 })
      handles.push(live)
      const holder = createWorkspaceService({
        store: live,
        authorityId: 'authority-1',
        tenantId: 'tenant-1',
        generation: 2,
      })
      const conflict = await holder.acquire(
        { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
        call('after-kill'),
      )
      expect(conflict.ok).toBe(false)
      if (!conflict.ok) expect(conflict.error.detailCode).toBe('revision_conflict')
      holder.close()
      live.close()
      const later = openWorkspaceStore({ directory: store, now: () => expiry })
      handles.push(later)
      const next = createWorkspaceService({
        store: later,
        authorityId: 'authority-1',
        tenantId: 'tenant-1',
        generation: 2,
      })
      const reclaimed = await next.acquire(
        { workspaceId: 'ws-1', mode: 'write', expectedRevision: null },
        call('after-expiry'),
      )
      expect(reclaimed.ok).toBe(true)
      expect(readFileSync(join(work, 'notes.txt'), 'utf8')).toBe('kept')
      next.close()
      later.close()
    } finally {
      for (const handle of handles) handle.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 20_000)
})
