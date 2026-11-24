import { mkdir, mkdtemp, readFile, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'

test('prepares a stable external root and isolates data directories', async () => {
  const { prepareManagedChatRoot } = await import('../src/supervisor/managed-chat-root.js')
  const base = await mkdtemp(join(tmpdir(), 'managed-root-'))
  const documents = join(base, 'redirected-documents')
  await mkdir(documents)
  const input = {
    dataDir: join(base, 'data'),
    privateRoots: [join(base, 'data')],
    documentsDirectory: async () => documents,
  }
  const first = await prepareManagedChatRoot(input)
  expect(first.root.startsWith(join(await realpath(documents), 'Agnes Harness', 'chats-'))).toBe(true)
  expect(
    await prepareManagedChatRoot({
      ...input,
      documentsDirectory: async () => {
        throw Error('unavailable')
      },
    }),
  ).toEqual(first)
  expect((await prepareManagedChatRoot({ ...input, dataDir: join(base, 'other') })).root).not.toBe(first.root)
  expect(JSON.parse(await readFile(join(first.root, '.agh-managed-root.json'), 'utf8')).id).toBe(first.id)
  const { chmod, lstat, writeFile } = await import('node:fs/promises')
  const metadataPath = join(await realpath(input.dataDir), 'managed-chat-root.json')
  const rootInfo = await lstat(first.root, { bigint: true })
  const saved = JSON.parse(await readFile(metadataPath, 'utf8')) as { directoryIdentity: string }
  await chmod(metadataPath, 0o600)
  await writeFile(
    metadataPath,
    JSON.stringify({ ...saved, directoryIdentity: `${rootInfo.dev + 3n}:${rootInfo.ino}` }),
    { mode: 0o600 },
  )
  expect(await prepareManagedChatRoot(input)).toEqual(first)
  expect(JSON.parse(await readFile(metadataPath, 'utf8'))).toMatchObject({
    directoryIdentity: `${rootInfo.dev}:${rootInfo.ino}`,
    state: 'ready',
  })
})

test('registered roots refuse replacement and never recreate missing directories', async () => {
  const { prepareManagedChatRoot } = await import('../src/supervisor/managed-chat-root.js')
  const base = await mkdtemp(join(tmpdir(), 'managed-root-'))
  const documents = join(base, 'docs')
  await mkdir(documents)
  const input = { dataDir: join(base, 'data'), privateRoots: [], documentsDirectory: async () => documents }
  const first = await prepareManagedChatRoot(input)
  const { copyFile, rename, rm } = await import('node:fs/promises')
  await rename(first.root, `${first.root}-old`)
  await symlink(`${first.root}-old`, first.root)
  await expect(prepareManagedChatRoot(input)).rejects.toThrow()
  await rm(first.root)
  await mkdir(first.root, { mode: 0o700 })
  await copyFile(
    join(`${first.root}-old`, '.agh-managed-root.json'),
    join(first.root, '.agh-managed-root.json'),
  )
  await expect(prepareManagedChatRoot(input)).rejects.toThrow()
})

test.each(['after-mkdir', 'after-marker', 'after-prepared', 'before-ready'] as const)(
  'recovers only registered candidates after %s interruption',
  async (point) => {
    const { prepareManagedChatRoot } = await import('../src/supervisor/managed-chat-root.js')
    const { readdir } = await import('node:fs/promises')
    const base = await mkdtemp(join(tmpdir(), 'managed-root-'))
    const documents = join(base, 'docs')
    await mkdir(documents)
    const input = { dataDir: join(base, 'data'), privateRoots: [], documentsDirectory: async () => documents }
    await expect(
      prepareManagedChatRoot({
        ...input,
        checkpoint: (stage) => {
          if (stage === point) throw Error('interrupted')
        },
      }),
    ).rejects.toMatchObject({ cause: { message: 'interrupted' } })
    const before = await readdir(join(documents, 'Agnes Harness'))
    const reopened = await prepareManagedChatRoot(input)
    const registered = point === 'after-prepared' || point === 'before-ready'
    expect(before.includes(basename(reopened.root))).toBe(registered)
    expect((await readdir(join(documents, 'Agnes Harness'))).length).toBe(registered ? 1 : 2)
  },
)

test('refuses documents overlapping a protected root without falling back', async () => {
  const { prepareManagedChatRoot } = await import('../src/supervisor/managed-chat-root.js')
  const base = await mkdtemp(join(tmpdir(), 'managed-root-'))
  await expect(
    prepareManagedChatRoot({
      dataDir: join(base, 'data'),
      privateRoots: [base],
      documentsDirectory: async () => base,
    }),
  ).rejects.toThrow()
})

test.skipIf(process.platform === 'win32')(
  'refuses a POSIX writable-by-others managed parent without touching its files',
  async () => {
    const { prepareManagedChatRoot } = await import('../src/supervisor/managed-chat-root.js')
    const { chmod, writeFile, readdir } = await import('node:fs/promises')
    const base = await mkdtemp(join(tmpdir(), 'managed-root-'))
    const documents = join(base, 'docs')
    const parent = join(documents, 'Agnes Harness')
    await mkdir(parent, { recursive: true })
    await chmod(parent, 0o777)
    await writeFile(join(parent, 'stranger'), 'preserve')
    await expect(
      prepareManagedChatRoot({
        dataDir: join(base, 'data'),
        privateRoots: [],
        documentsDirectory: async () => documents,
      }),
    ).rejects.toThrow()
    expect(await readFile(join(parent, 'stranger'), 'utf8')).toBe('preserve')
    expect(await readdir(parent)).toEqual(['stranger'])
  },
)
