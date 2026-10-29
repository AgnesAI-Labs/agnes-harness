import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runComputerUseRescue } from '../../src/computer-use/rescue.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
  'Computer Use standalone rescue',
  () => {
    it('reads an empty store without assembling Host or starting a driver', async () => {
      const dataDir = resolve(await mkdtemp(join(tmpdir(), 'agnes-cu-rescue-')))
      roots.push(dataDir)
      await expect(runComputerUseRescue({ action: 'status', dataDir })).resolves.toEqual({
        schemaVersion: 1,
        action: 'status',
        platform: process.platform,
        status: 'empty',
        generation: 0,
      })
    })

    it('rejects a non-canonical data directory before reading activation state', async () => {
      await expect(runComputerUseRescue({ action: 'status', dataDir: '.' })).rejects.toThrow(/canonical/)
    })
  },
)
