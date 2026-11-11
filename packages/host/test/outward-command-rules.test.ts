import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { outwardCheckpointEnforced } from '@agnes/core/command-table'
import { afterEach, expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('a session the host opens with outward command rules enforces them; one opened without does not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-outward-rules-'))
  roots.push(root)
  const { host } = await createTestHost({ dataDir: root, disableSessionTitle: true })
  try {
    const managed = await host.createSession({ key: 'managed', cwd: root, outwardCommandRules: true })
    const plain = await host.createSession({ key: 'plain', cwd: root })
    expect(outwardCheckpointEnforced(managed.toolPolicy())).toBe(true)
    expect(outwardCheckpointEnforced(plain.toolPolicy())).toBe(false)
    await managed.close()
    await plain.close()
  } finally {
    await host.close()
  }
})
