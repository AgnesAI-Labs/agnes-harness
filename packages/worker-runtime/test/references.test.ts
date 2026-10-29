import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostSession } from '@agnes/host'
import { fileReferenceBrowse, parentFileReferenceBrowse } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { commandReferences, fuzzyRank, searchReferenceFiles } from '../src/references.js'
import { readWorkspaceReference } from '../src/workspace-files.js'

it('parses file browsing without claiming another provider query', () => {
  expect(fileReferenceBrowse('')).toEqual({ path: '', filter: '' })
  expect(fileReferenceBrowse('file "my folder/ma')).toEqual({ path: 'my folder', filter: 'ma' })
  expect(fileReferenceBrowse('src\\ma')).toEqual({ path: 'src', filter: 'ma' })
  expect(fileReferenceBrowse('src//ma')).toEqual({ path: 'src', filter: 'ma' })
  expect(fileReferenceBrowse('file foo bar/')).toBeUndefined()
  expect(fileReferenceBrowse('src/\nsecret')).toBeUndefined()
  expect(fileReferenceBrowse('session src/')).toBeUndefined()
  expect(fileReferenceBrowse('../secret/')).toBeUndefined()
  expect(fileReferenceBrowse('C:\\secret\\')).toBeUndefined()
  expect(parentFileReferenceBrowse('src/deep/')).toBe('src/')
  expect(parentFileReferenceBrowse('file "my folder/')).toBe('file "')
})

it('removes a cancelled worker reference request without affecting other runs', async () => {
  const aborts = new Map<string, AbortController>()
  const session = {
    key: 'one',
    d: {
      actor: { id: 'reader' },
      workspaceInvocation: {
        run: (invoke: (view: unknown) => unknown) => invoke({ root: '/unused', fs: () => ({}) }),
      },
    },
    referenceResolvers: {
      search: (_query: string, context: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
        }),
    },
    referenceSessions: {},
    referenceLimits: {},
  } as unknown as HostSession
  const pending = commandReferences(session, 'search', 'x', 'reference:one', aborts)
  const rejected = expect(pending).rejects.toBeDefined()
  const other = commandReferences(session, 'search', 'y', 'reference:two', aborts)
  const otherRejected = expect(other).rejects.toBeDefined()
  expect(aborts.has('reference:one')).toBe(true)
  aborts.get('reference:one')?.abort()
  await rejected
  expect(aborts.has('reference:one')).toBe(false)
  expect(aborts.has('reference:two')).toBe(true)
  aborts.get('reference:two')?.abort()
  await otherRejected
})

it('searches the ignored workspace tree fuzzily and re-reads exact source versions with authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-ref-'))
  const privateRoot = join(root, 'private-state')
  const authority = {
    stat: async (path: string) => {
      if (path.includes('denied')) throw new Error('Permission denied')
    },
  }
  try {
    await mkdir(privateRoot)
    vi.stubEnv('AGH_HOME', privateRoot)
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'build'))
    await mkdir(join(root, '.agh/secrets'), { recursive: true })
    await writeFile(join(root, '.aghignore'), 'private.txt\n')
    await writeFile(join(root, '.gitignore'), '*.log\nbuild/\n')
    await writeFile(join(root, 'src', '.gitignore'), 'hidden.txt\n')
    for (const path of [
      'private.txt',
      '.agh/secrets/key.txt',
      'a.log',
      'build/leak.txt',
      'src/main.ts',
      'src/hidden.txt',
      'denied.txt',
      'private-state/secret.txt',
    ])
      await writeFile(join(root, path), 'before')
    let linkCreated = true
    try {
      await symlink(join(root, 'src', 'main.ts'), join(root, 'escape'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      linkCreated = false
    }
    const signal = new AbortController().signal
    const all = await searchReferenceFiles(root, authority, '', signal)
    expect(all.items.map((item) => item.id)).not.toContain('src/main.ts')
    expect(
      (await searchReferenceFiles(root, authority, 'src/', signal)).items.map((item) => item.id),
    ).toEqual(['src/.gitignore', 'src/main.ts'])
    expect(
      (await searchReferenceFiles(root, authority, 'src/ma', signal)).items.map((item) => item.id),
    ).toEqual(['src/main.ts'])
    for (const path of [
      'private.txt',
      '.agh/secrets/key.txt',
      'a.log',
      'build/leak.txt',
      'src/hidden.txt',
      'denied.txt',
      'private-state/secret.txt',
      ...(linkCreated ? ['escape'] : []),
    ])
      expect(all.items.map((item) => item.id)).not.toContain(path)
    expect(
      (await searchReferenceFiles(root, authority, 'smts', signal)).items.map((item) => item.id),
    ).toEqual(['src/main.ts'])
    await writeFile(join(root, 'src', 'fresh.ts'), 'new')
    expect(
      (await searchReferenceFiles(root, authority, 'fresh', signal)).items.map((item) => item.id),
    ).toEqual(['src/fresh.ts'])
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(searchReferenceFiles(root, authority, 'smts', cancelled.signal)).rejects.toBeDefined()
    const unreadableNestedIgnore = {
      stat: async (path: string) => {
        if (path.endsWith('src\\.gitignore') || path.endsWith('src/.gitignore'))
          throw new Error('Permission denied')
      },
    }
    const partial = await searchReferenceFiles(root, unreadableNestedIgnore, 'smts', signal)
    expect(partial.items).toEqual([])
    expect(partial.truncated).toBe(true)
    const deniedDirectory = {
      stat: async (path: string) => {
        if (path === join(root, 'src')) throw new Error('Permission denied')
      },
    }
    expect((await searchReferenceFiles(root, deniedDirectory, 'smts', signal)).items).toEqual([])
    expect(fuzzyRank('src/main.ts', 'missing')).toBeUndefined()
    await writeFile(join(root, 'src/main.ts'), 'after')
    const read = await readWorkspaceReference(root, 'src/main.ts', authority, 1024)
    expect(read).toMatchObject({ text: 'after', hash: createHash('sha256').update('after').digest('hex') })
    for (const path of [
      '../outside',
      '/etc/passwd',
      'private.txt',
      '.agh/secrets/key.txt',
      'a.log',
      'build/leak.txt',
      'src/hidden.txt',
      ...(linkCreated ? ['escape'] : []),
      'denied.txt',
      'private-state/secret.txt',
    ])
      await expect(readWorkspaceReference(root, path, authority, 1024)).rejects.toBeDefined()
    await writeFile(join(root, 'binary.dat'), Buffer.from([65, 0, 66]))
    await expect(readWorkspaceReference(root, 'binary.dat', authority, 1024)).rejects.toThrow('Binary')
    await writeFile(join(root, 'binary.dat'), Buffer.from([0xff, 0xff]))
    await expect(readWorkspaceReference(root, 'binary.dat', authority, 1024)).rejects.toThrow('Binary')
    const unreadableIgnore = {
      stat: async (path: string) => {
        if (path.endsWith('.gitignore')) throw new Error('Permission denied')
      },
    }
    await expect(searchReferenceFiles(root, unreadableIgnore, '', signal)).rejects.toBeDefined()
    await expect(readWorkspaceReference(root, 'src/main.ts', unreadableIgnore, 1024)).rejects.toBeDefined()
    await writeFile(join(root, 'large.txt'), 'x'.repeat(2048))
    await expect(readWorkspaceReference(root, 'large.txt', authority, 1024)).rejects.toThrow(
      'source read limit',
    )
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
