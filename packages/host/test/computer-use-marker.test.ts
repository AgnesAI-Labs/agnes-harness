import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readComputerUseTombstone } from '../src/computer-use-marker.js'

vi.mock('../src/adapters/platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/platform.js')>()
  return { ...actual, createPlatform: () => ({ ...actual.createPlatform(), os: 'win32' as const }) }
})
vi.mock('@agnes/system-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/system-node')>()
  return { ...actual, windowsEnsurePrivateDirectorySync: vi.fn(), windowsReadPrivateFileSync: vi.fn() }
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('reading a Computer Use reclaim tombstone', () => {
  it('does not create or re-protect marker directories when there is no marker to read', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agnes-cu-marker-read-'))
    roots.push(dataDir)
    await expect(readComputerUseTombstone(dataDir, 'a'.repeat(64))).resolves.toBeUndefined()
    expect(windowsEnsurePrivateDirectorySync).not.toHaveBeenCalled()
  })
})
