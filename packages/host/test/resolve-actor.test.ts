import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTestHost } from '../testkit/index.js'

describe('Host.resolveActor', () => {
  it('delegates credentials and the surface to the fitted principals seam', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-host-actor-'))
    const calls: Array<{ credential: unknown; surface: string }> = []
    const expected = { id: 'approver', org: 'example', role: 'admin', deptPath: [], attrs: {} }
    const { host } = await createTestHost({
      dataDir,
      seams: {
        principals: {
          resolve: async (credential, surface) => {
            calls.push({ credential, surface })
            return expected
          },
        },
      },
    })
    try {
      await expect(host.resolveActor({ kind: 'local' }, 'approval')).resolves.toEqual(expected)
      expect(calls).toEqual([{ credential: { kind: 'local' }, surface: 'approval' }])
    } finally {
      await host.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
