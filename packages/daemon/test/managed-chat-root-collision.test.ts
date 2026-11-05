import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>()),
  randomUUID: () => '00000000-0000-4000-8000-000000000001',
}))
test('an occupied random target is a conflict and remains untouched', async () => {
  const { prepareManagedChatRoot } = await import('../src/supervisor/managed-chat-root.js')
  const base = await mkdtemp(join(tmpdir(), 'managed-collision-'))
  const documents = join(base, 'docs')
  const parent = join(documents, 'Agnes Harness')
  const target = join(parent, 'chats-00000000-0000-4000-8000-000000000001')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await mkdir(target, { mode: 0o700 })
  await writeFile(join(target, 'stranger'), 'unchanged')
  await expect(
    prepareManagedChatRoot({
      dataDir: join(base, 'data'),
      privateRoots: [],
      documentsDirectory: async () => documents,
    }),
  ).rejects.toMatchObject({ code: 'MANAGED_CHAT_ROOT_CONFLICT' })
  expect(await readFile(join(target, 'stranger'), 'utf8')).toBe('unchanged')
  expect(await readdir(target)).toEqual(['stranger'])
})
