import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntimeTarget } from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-seam-facade-'))
  dirs.push(dir)
  return dir
}
const emptyTarget = () =>
  buildRuntimeTarget({
    rows: [],
    resources: { mcp: [], skills: {} },
    resourceRevision: '0'.repeat(64),
    compositeRevision: '0'.repeat(64),
  })
// The previous tree is retired AFTER applyRuntimeTarget resolves (runtime-state.ts `#retire`), so a
// test that asserts immediately would win the race and prove nothing.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('dynamic seams after a post-boot applyRuntimeTarget', () => {
  it('keeps the principals seam alive after one apply', async () => {
    const { host } = await createTestHost({ dataDir: scratch() })
    try {
      await expect(host.resolveActor({ kind: 'local' }, 'session')).resolves.toBeTruthy()
      await expect(host.applyRuntimeTarget(emptyTarget())).resolves.toMatchObject({ ok: true })
      await settle()
      await expect(host.resolveActor({ kind: 'local' }, 'session')).resolves.toBeTruthy()
    } finally {
      await host.close().catch(() => undefined)
    }
  })

  it('keeps the principals seam alive after two back-to-back applies', async () => {
    const { host } = await createTestHost({ dataDir: scratch() })
    try {
      await host.applyRuntimeTarget(emptyTarget())
      await host.applyRuntimeTarget(emptyTarget())
      await settle()
      await expect(host.resolveActor({ kind: 'local' }, 'session')).resolves.toBeTruthy()
    } finally {
      await host.close().catch(() => undefined)
    }
  })
})
