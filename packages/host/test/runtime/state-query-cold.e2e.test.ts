import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { originalNativeFixture } from './fixtures/native-state-read-fixture.js'

const script = fileURLToPath(new URL('./fixtures/state-query-process.ts', import.meta.url))
const run = (args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 90_000,
  })

describe.skipIf(typeof process.getuid !== 'function')('State read service across a killed process', () => {
  it('refuses the old process snapshot after SIGKILL and re-reads byte-identical envelopes', async () => {
    const first = await originalNativeFixture()
    try {
      const created = await first.fixture.coordinator.coordinate(
        first.fixture.draft(),
        first.fixture.context(),
      )
      expect(created).toMatchObject({ ok: true, value: { state: 'created' } })
      await first.reader.close()
      first.identity.close()
      await first.fixture.close()
      const killed = run([first.deploymentDirectory, 'open'])
      expect(killed.error).toBeUndefined()
      expect(killed.signal).toBe('SIGKILL')
      const { snapshot, items } = JSON.parse(killed.stdout) as { snapshot: unknown; items: unknown[] }
      expect(items.length).toBeGreaterThan(0)
      const reread = run([first.deploymentDirectory, 'read', JSON.stringify(snapshot)])
      expect(reread.error).toBeUndefined()
      expect(reread.status, reread.stderr).toBe(0)
      const out = JSON.parse(reread.stdout) as { oldSnapshotError: string; items: unknown[] }
      expect(out.oldSnapshotError).toBe('resync_required')
      expect(out.items).toEqual(items)
      expect(JSON.stringify(out.items)).toBe(JSON.stringify(items))
    } finally {
      rmSync(first.directory, { recursive: true, force: true })
    }
  }, 240_000)
})
