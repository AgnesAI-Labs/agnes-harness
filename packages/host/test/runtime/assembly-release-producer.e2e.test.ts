import { type ChildProcess, fork } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { producerDeploymentFixture, writeProducerJson } from './fixtures/release-producer-input.js'

function message(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture message timeout')), 45_000)
    const received = (value: Record<string, unknown>) => {
      clearTimeout(timer)
      child.off('exit', exited)
      resolve(value)
    }
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer)
      child.off('message', received)
      reject(new Error(`fixture exited ${code}/${signal}`))
    }
    child.once('message', received)
    child.once('exit', exited)
    child.once('error', reject)
  })
}
it.runIf(process.platform !== 'win32')(
  'cold reads the original atomic publication after SIGKILL without re-resolving or resubmitting',
  async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'producer-kill-'))
    const children: ChildProcess[] = []
    try {
      const deployment = join(root, 'deployment')
      mkdirSync(deployment, { mode: 0o700 })
      const fixture = await producerDeploymentFixture(deployment)
      const producer = fixture.release.bindings.find(
        (row) => row.descriptor.contract === 'agh.assembly',
      )?.binding
      const transactionId = `publish:${fixture.release.releaseSetId}`
      writeProducerJson(root, 'child-lock.json', { producer, transactionId })
      const path = fileURLToPath(new URL('./fixtures/release-producer-process.ts', import.meta.url))
      const start = (mode: string) => {
        const child = fork(path, [mode, root], {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        })
        children.push(child)
        return child
      }
      const writer = start('publish')
      const committed = await message(writer)
      expect(committed.committed).toBe(true)
      const exit = new Promise<NodeJS.Signals | null>((resolve) =>
        writer.once('exit', (_code, signal) => resolve(signal)),
      )
      writer.kill('SIGKILL')
      expect(await exit).toBe('SIGKILL')
      rmSync(deployment, { recursive: true })
      const reader = start('recover')
      const original = await message(reader)
      expect(original.pid).not.toBe(committed.pid)
      expect(original.changes).toBe(0)
      expect(original.result).toMatchObject({
        ok: true,
        value: {
          receipt: { transactionId },
          facts: { release: fixture.release, binding: { releaseSetId: fixture.release.releaseSetId } },
        },
      })
      await new Promise<void>((resolve) => {
        if (reader.exitCode !== null) resolve()
        else reader.once('exit', () => resolve())
      })
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  },
  90_000,
)
