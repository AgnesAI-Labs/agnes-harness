import { type ChildProcess, fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createReleaseProducer } from '../../src/runtime/assembly/release-producer.js'
import {
  producerDeploymentFixture,
  producerTestContext,
  writeProducerJson,
} from './fixtures/release-producer-input.js'
import { producerCommitFixture } from './fixtures/release-producer-port.js'

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

it.runIf(process.platform !== 'win32')(
  'leaves reclaimable unreferenced objects after SIGKILL between retention and the maintenance commit',
  async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'producer-orphan-'))
    let writer: ChildProcess | undefined
    let database: ReturnType<typeof producerCommitFixture> | undefined
    try {
      const deployment = join(root, 'deployment')
      mkdirSync(deployment, { mode: 0o700 })
      const fixture = await producerDeploymentFixture(deployment)
      const binding = fixture.release.bindings.find(
        (row) => row.descriptor.contract === 'agh.assembly',
      )?.binding
      if (!binding) throw new Error('selected producer missing')
      const transactionId = `publish:${fixture.release.releaseSetId}`
      writeProducerJson(root, 'child-lock.json', { producer: binding, transactionId })
      const path = fileURLToPath(new URL('./fixtures/release-producer-process.ts', import.meta.url))
      writer = fork(path, ['staged', root], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
      expect((await message(writer)).staged).toBe(true)
      const exited = new Promise<void>((resolve) => writer?.once('exit', () => resolve()))
      writer.kill('SIGKILL')
      await exited
      rmSync(deployment, { recursive: true })
      database = producerCommitFixture(join(root, 'publication.sqlite'), binding, { readonly: true })
      expect(database.db.prepare('SELECT count(*) AS n FROM records').get()?.n).toBe(0)
      expect(await database.port.readPublication(transactionId, producerTestContext())).toBeNull()
      const producer = createReleaseProducer(deployment, database.port)
      expect((await producer.recover(transactionId, producerTestContext())).ok).toBe(false)
      await producer.dispose()
      expect(database.changes()).toBe(0)
      // Synthetic trusted reconciler proves this isolated publication namespace empty before unpinning.
      const pins = new DatabaseSync(join(database.objectDirectory, 'artifacts', 'blob-service.db'))
      const roots = pins.prepare('SELECT pin_id, revision FROM roots WHERE active=1').all()
      const orphan = pins.prepare('SELECT digest FROM blobs WHERE deleted=0 LIMIT 1').get()
      expect(roots.length).toBeGreaterThan(0)
      for (const row of roots)
        expect(
          (
            await database.blob.unpin(
              { pinId: row.pin_id, expectedRevision: row.revision },
              producerTestContext(),
            )
          ).ok,
        ).toBe(true)
      pins.close()
      const gc = await database.blob.gc(
        { scopeRef: producerTestContext().scope, dryRun: false, cursor: null, limit: 10000 },
        producerTestContext(),
      )
      expect(gc.ok).toBe(true)
      if (gc.ok) expect(gc.value.deletedRefs.length).toBeGreaterThan(0)
      const digest = String(orphan?.digest)
      expect(
        existsSync(join(database.objectDirectory, 'artifacts', 'sha256', digest.slice(0, 2), digest)),
      ).toBe(false)
      expect(await database.port.readPublication(transactionId, producerTestContext())).toBeNull()
    } finally {
      if (writer?.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL')
      database?.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
  90000,
)
