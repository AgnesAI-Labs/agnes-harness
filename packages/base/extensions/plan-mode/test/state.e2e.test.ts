import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import { applyPlanCommand, clearPlanMode, planModePath, readPlanMode } from '../src/state.js'

it.each(['ordinary', 'dead-owner'] as const)(
  'clears the same reviewed plan at most once across real processes: %s',
  async (lockState) => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-plan-cas-'))
    const children: ChildProcess[] = []
    try {
      applyPlanCommand(root, '/plan exact revision')
      const revision = readPlanMode(root).revision!
      let abandonedLock: string | undefined
      if (lockState === 'dead-owner') {
        const exited = spawnSync(process.execPath, ['--eval', ''], { timeout: 5_000 })
        expect(exited.status).toBe(0)
        expect(() => process.kill(exited.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        abandonedLock = JSON.stringify({ pid: exited.pid, startToken: `0-${randomUUID()}` })
        writeFileSync(`${planModePath(root)}.lock`, abandonedLock)
        // Reclaiming a dead lock itself must not clear or rewrite the plan.
        expect(clearPlanMode(root, 'unreviewed', 'stale')).toBe(false)
        expect(readPlanMode(root)).toMatchObject({ active: true, revision })
        writeFileSync(`${planModePath(root)}.lock`, abandonedLock)
      }
      const contenders = ['first', 'second'].map((plan) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '--eval',
            `const { clearPlanMode } = await import(process.argv[1]);
         console.log('ready');
         process.stdin.once('data', () => {
           try { console.log(JSON.stringify({ cleared: clearPlanMode(process.argv[2], process.argv[3], process.argv[4]) })); }
           catch (error) { if (error.code !== 'EEXIST') throw error; console.log(JSON.stringify({ cleared: false })); }
           process.stdin.destroy();
         });`,
            new URL('../src/state.ts', import.meta.url).href,
            root,
            revision,
            plan,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        )
        children.push(child)
        let stderr = ''
        let cleared: boolean | undefined
        child.stderr?.on('data', (data) => {
          stderr += data
        })
        let ready!: () => void
        const started = new Promise<void>((resolve, reject) => {
          ready = resolve
          child.once('error', reject)
          child.once('exit', () => reject(new Error(stderr || 'plan contender exited before ready')))
        })
        createInterface({ input: child.stdout! }).on('line', (line) => {
          if (line === 'ready') ready()
          else cleared = (JSON.parse(line) as { cleared: boolean }).cleared
        })
        const completed = new Promise<boolean>((resolve, reject) => {
          child.once('error', reject)
          child.once('exit', (code) =>
            code === 0 && cleared !== undefined
              ? resolve(cleared)
              : reject(new Error(stderr || `plan contender exited ${code}`)),
          )
        })
        // Observe startup failures even before the barrier has released the contenders.
        void completed.catch(() => undefined)
        return { child, started, completed }
      })
      await Promise.all(contenders.map((contender) => contender.started))
      for (const contender of contenders) contender.child.stdin?.end('clear')
      expect((await Promise.all(contenders.map((contender) => contender.completed))).sort()).toEqual([
        false,
        true,
      ])
      expect(readPlanMode(root)).toMatchObject({
        active: false,
        pendingPlan: expect.stringMatching(/^(first|second)$/),
      })
      if (abandonedLock) {
        applyPlanCommand(root, '/plan another plan')
        writeFileSync(`${planModePath(root)}.lock`, abandonedLock)
        expect(applyPlanCommand(root, '/plan off')).toMatchObject({ active: false })
        expect(readPlanMode(root).active).toBe(false)
      }
    } finally {
      await Promise.all(
        children
          .filter((child) => child.exitCode === null && child.signalCode === null)
          .map(
            (child) =>
              new Promise<void>((resolve) => {
                child.once('exit', () => resolve())
                child.kill()
              }),
          ),
      )
      rmSync(root, { recursive: true, force: true })
    }
  },
  30_000,
)
