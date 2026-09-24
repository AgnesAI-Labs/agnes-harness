import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Kernel, presetDefaults } from '@agnes/core'
import { fakeProvider, fakeSeams, fencedFs, noTimers, testFsPolicy, textTurn } from '@agnes/core/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../src/adapters/storage-sqlite.js'

const workerEntry = fileURLToPath(new URL('./fixtures/child-crash-worker.ts', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('child crash restart against sqlite', () => {
  it('keeps the same childKey inspectable after SIGKILL and refuses a stale generation write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-child-crash-'))
    dirs.push(dir)
    const dbFile = join(dir, 'sessions.db')
    const readyFile = join(dir, 'ready.json')
    const child = spawn(process.execPath, ['--import', 'tsx', workerEntry, dbFile, readyFile], {
      windowsHide: true,
      stdio: 'ignore',
      env: process.env,
    })
    try {
      await waitForFile(readyFile)
      const payload = JSON.parse(readFileSync(readyFile, 'utf8')) as {
        liveKey: string
        cancelledKey: string
        rootTaskId: string
      }
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
      })
      child.kill('SIGKILL')
      await exited

      const storage = createSqliteStorage({ file: dbFile, tablesDir: join(dir, 'tables') })
      expect(await storage.lookupByKey(payload.liveKey)).toMatchObject({
        childKey: payload.liveKey,
        cwd: '/w',
      })
      expect((await storage.lookupByKey(payload.liveKey))?.state).not.toBe('cancelled')
      expect((await storage.lookupByKey(payload.cancelledKey))?.state).toBe('cancelled')

      const provider = fakeProvider([textTurn('resumed')])
      Object.assign(provider, {
        models: () => [
          {
            id: 'm1',
            name: 'm1',
            api: 'openai-completions',
            route: 'default',
            baseUrl: 'https://example.invalid/v1',
            reasoning: false,
            input: ['text'],
            cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 128,
            toolCallFormats: ['native'],
            thinkingReplay: 'native',
            contract_id: null,
          },
        ],
      })
      const k = Kernel.create({
        storage,
        seams: fakeSeams(),
        provider,
        contract: { contract_id: null, parser_version: '1' },
        preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 2, maxFanOut: 4 },
        fsOps: fencedFs(
          {
            read: async () => new Uint8Array(),
            write: async () => undefined,
            list: async () => [],
            stat: async () => ({ kind: 'file' as const, size: 0, mtimeMs: 0 }),
          },
          testFsPolicy('/w'),
        ),
        netFetch: async () => new Response(''),
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
        timers: noTimers,
        clock: () => Date.now(),
      })
      const parent = await k.session('parent', {
        actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r1',
      })
      await expect(parent.d.children.inspect?.(payload.liveKey)).resolves.toMatchObject({
        state: 'running',
      })
      await expect(parent.d.children.inspect?.(payload.cancelledKey)).resolves.toMatchObject({
        state: 'error',
      })
      await expect(parent.d.children.resume?.(payload.liveKey)).rejects.toMatchObject({
        code: 'E_UNSUPPORTED',
      })
      await storage.bumpWriterGeneration?.(payload.rootTaskId)
      await storage.bumpWriterGeneration?.(payload.rootTaskId)
      const stale = await storage.reserve({
        rootTaskId: payload.rootTaskId,
        scopeIds: [`root:${payload.rootTaskId}`],
        qMicro: 1n,
        effectId: 'old-writer',
        requestHash: 'h',
        writerGeneration: 1,
      })
      expect(stale).toMatchObject({ ok: false, reason: 'invalid' })
      await k.close()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }, 20_000)
})
