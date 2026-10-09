import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fuzzyRank, searchReferenceFiles } from '../src/references.js'
import { readWorkspaceReference } from '../src/workspace-files.js'

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
    await symlink('/etc/passwd', join(root, 'escape'))
    const signal = new AbortController().signal
    const all = await searchReferenceFiles(root, authority, '', signal)
    expect(all.items.map((item) => item.id)).toContain('src/main.ts')
    for (const path of [
      'private.txt',
      '.agh/secrets/key.txt',
      'a.log',
      'build/leak.txt',
      'src/hidden.txt',
      'denied.txt',
      'private-state/secret.txt',
      'escape',
    ])
      expect(all.items.map((item) => item.id)).not.toContain(path)
    expect(
      (await searchReferenceFiles(root, authority, 'smts', signal)).items.map((item) => item.id),
    ).toEqual(['src/main.ts'])
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
      'escape',
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
