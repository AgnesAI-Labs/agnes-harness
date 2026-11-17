import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

const calls = vi.hoisted(() => ({ created: [] as string[], protected: [] as string[] }))
vi.mock('@agnes/host', () => ({ createPlatform: () => ({ os: 'win32' }) }))
vi.mock('@agnes/system-node', () => ({
  createPrivateDirectorySync: (path: string) => {
    calls.created.push(path)
    mkdirSync(path, { mode: 0o700 })
  },
  windowsProtectPrivateDirectorySync: (path: string) => {
    calls.protected.push(path)
  },
  windowsEnsurePrivateDirectorySync: (path: string) => {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  },
}))
test('Windows candidates use exclusive native private creation and validate parent protection', async () => {
  const { prepareManagedChatRoot } = await import('../src/supervisor/managed-chat-root.js')
  const base = await mkdtemp(join(tmpdir(), 'managed-win-sim-'))
  const documents = join(base, 'docs')
  await mkdir(documents)
  const result = await prepareManagedChatRoot({
    dataDir: join(base, 'data'),
    privateRoots: [],
    documentsDirectory: async () => documents,
  })
  expect(calls.created).toContain(result.root)
  expect(calls.protected).toContain(join(result.root, '..'))
})
