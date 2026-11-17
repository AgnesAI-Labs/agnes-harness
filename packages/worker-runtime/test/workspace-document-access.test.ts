import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  authorizeWorkspaceReferenceCandidates,
  listWorkspace,
  readWorkspace,
} from '../src/workspace-files.js'

it('admits only the bound legacy root for document reads and hides the managed marker', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agh-doc-scope-')))
  vi.stubEnv('AGH_HOME', home)
  const root = join(home, 'chats')
  await mkdir(root)
  const rootInfo = await lstat(root, { bigint: true })
  const legacyDirectoryIdentity = `${rootInfo.dev}:${rootInfo.ino}`
  await writeFile(join(root, 'note.txt'), 'legacy text')
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]))
  await writeFile(join(root, '.agh-managed-root.json'), '{}')
  const authority = {
    stat: async () => undefined,
    readScope: { root, legacyManagedRoot: root, legacyDirectoryIdentity },
  }
  try {
    await expect(readWorkspace(root, 'note.txt', { stat: authority.stat })).rejects.toMatchObject({
      data: { code: 'WORKSPACE_PATH_DENIED' },
    })
    expect((await readWorkspace(root, 'note.txt', authority)).text).toBe('legacy text')
    const binary = await readWorkspace(root, 'binary.bin', authority)
    expect(binary.binary).toBe(true)
    expect(binary.text).toBeUndefined()
    expect((await listWorkspace(root, '', authority, false)).entries.map((e) => e.name)).toEqual([
      'binary.bin',
      'note.txt',
    ])
    expect(
      (
        await authorizeWorkspaceReferenceCandidates(
          root,
          authority,
          new AbortController().signal,
          ['note.txt', '.agh-managed-root.json'],
          10,
        )
      ).paths,
    ).toEqual(['note.txt'])
    await expect(readWorkspace(root, '.agh-managed-root.json', authority)).rejects.toBeDefined()
    await expect(readWorkspace(root, '../secret', authority)).rejects.toBeDefined()
    await symlink(join(home, 'secret'), join(root, 'link'))
    await writeFile(join(home, 'secret'), 'secret')
    await expect(readWorkspace(root, 'link', authority)).rejects.toBeDefined()
    await expect(
      readWorkspace(root, 'note.txt', {
        ...authority,
        readScope: { root: home, legacyManagedRoot: root, legacyDirectoryIdentity },
      }),
    ).rejects.toBeDefined()
  } finally {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})

it('rechecks scope and fs permission on every session document call and cached reference read', async () => {
  const { createWorkspaceInvocationPort } = await import('@agnes/core')
  const { sessionWorkspaceFiles, readWorkspaceReference } = await import('../src/workspace-files.js')
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agh-doc-session-')))
  vi.stubEnv('AGH_HOME', home)
  const root = join(home, 'chats')
  await mkdir(root)
  const rootInfo = await lstat(root, { bigint: true })
  const legacyDirectoryIdentity = `${rootInfo.dev}:${rootInfo.ino}`
  await writeFile(join(root, 'note.txt'), 'session text')
  let allowed = true
  let grant = true
  const port = createWorkspaceInvocationPort(() => ({
    source: {
      root,
      approval: { ask: async () => undefined },
      checkpoint: {},
      hookSandbox: {},
      documentReadScope: () => ({
        root,
        ...(grant ? { legacyManagedRoot: root, legacyDirectoryIdentity } : {}),
      }),
      fs: {
        stat: async () => {
          if (!allowed) throw new Error('revoked')
        },
      },
    } as never,
    release() {},
  }))
  const session = { d: { workspaceInvocation: port } } as never
  try {
    expect(await sessionWorkspaceFiles(session, 'list', '')).toMatchObject({
      entries: [{ name: 'note.txt' }],
    })
    expect(await sessionWorkspaceFiles(session, 'read', 'note.txt')).toMatchObject({ text: 'session text' })
    const cached = await port.run((view) =>
      authorizeWorkspaceReferenceCandidates(
        root,
        { stat: view.fs().stat, readScope: view.documentReadScope() },
        new AbortController().signal,
        ['note.txt'],
        10,
      ),
    )
    allowed = false
    await expect(sessionWorkspaceFiles(session, 'read', 'note.txt')).rejects.toBeDefined()
    await expect(
      port.run((view) =>
        readWorkspaceReference(
          root,
          cached.paths[0] ?? 'missing',
          { stat: view.fs().stat, readScope: view.documentReadScope() },
          1024,
        ),
      ),
    ).rejects.toBeDefined()
    allowed = true
    grant = false
    await expect(sessionWorkspaceFiles(session, 'list', '')).rejects.toBeDefined()
  } finally {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})

it('refuses prefix collisions, root swaps and a directory swapped during fs authorization', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agh-doc-swap-')))
  vi.stubEnv('AGH_HOME', home)
  const root = join(home, 'chats')
  const backup = join(home, 'chats-backup')
  await mkdir(join(root, 'dir'), { recursive: true })
  await mkdir(backup)
  await writeFile(join(root, 'dir', 'note'), 'original')
  await writeFile(join(backup, 'note'), 'private')
  const rootInfo = await lstat(root, { bigint: true })
  const legacyDirectoryIdentity = `${rootInfo.dev}:${rootInfo.ino}`
  const scope = { root, legacyManagedRoot: root, legacyDirectoryIdentity }
  try {
    await expect(
      readWorkspace(backup, 'note', { stat: async () => {}, readScope: scope }),
    ).rejects.toBeDefined()
    let swapped = false
    await expect(
      readWorkspace(root, 'dir/note', {
        readScope: scope,
        stat: async () => {
          if (!swapped) {
            swapped = true
            await rename(join(root, 'dir'), join(root, 'old-dir'))
            await symlink(backup, join(root, 'dir'), 'dir')
          }
        },
      }),
    ).rejects.toBeDefined()
    await rename(root, join(home, 'saved'))
    await symlink(backup, root, 'dir')
    await expect(listWorkspace(root, '', { stat: async () => {}, readScope: scope })).rejects.toBeDefined()
  } finally {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})

it('passes one invocation document scope to workspace upload and changes', async () => {
  const { randomUUID } = await import('node:crypto')
  const { readdir, stat } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  const { createWorkspaceInvocationPort } = await import('@agnes/core')
  const { sessionFileUpload, closeSessionFileUploads } = await import('../src/file-upload.js')
  const { sessionWorkspaceChanges } = await import('../src/workspace-changes.js')
  const { sessionReferences } = await import('../src/references.js')
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agh-doc-entry-')))
  vi.stubEnv('AGH_HOME', home)
  const root = join(home, 'chats')
  await mkdir(root)
  const rootInfo = await lstat(root, { bigint: true })
  const legacyDirectoryIdentity = `${rootInfo.dev}:${rootInfo.ino}`
  let granted = true
  const port = createWorkspaceInvocationPort(() => ({
    source: {
      root,
      documentReadScope: () => ({
        root,
        ...(granted ? { legacyManagedRoot: root, legacyDirectoryIdentity } : {}),
      }),
      approval: { ask: async () => undefined },
      checkpoint: {},
      hookSandbox: {},
      fs: {
        stat,
        write: async (path: string, bytes: Uint8Array) => {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, bytes)
        },
        list: async (path: string) => (await readdir(path)).map((name) => ({ name })),
        authorizeWrite: async () => {},
        authorizeRemove: async () => {},
        rm,
      },
    } as never,
    release() {},
  }))
  await writeFile(join(root, 'note.txt'), 'reference content')
  const session = {
    referenceResolvers: {
      resolve: async (_input: unknown, context: { files: { read(path: string): Promise<unknown> } }) =>
        context.files.read('note.txt'),
    },
    referenceSessions: {},
    referenceLimits: { maxSourceBytes: 1024 },
    key: 'scope-session',
    lastSeq: 0,
    scan: async () => [],
    d: { actor: { id: 'reader' }, workspaceInvocation: port },
  } as never
  const upload = {
    sessionId: 'scope-session',
    uploadId: randomUUID(),
    operation: 'start' as const,
    name: 'note.txt',
    mimeType: 'text/plain',
    size: 4,
  }
  try {
    expect(await sessionFileUpload(session, upload)).toMatchObject({ offset: 0 })
    expect((await sessionWorkspaceChanges(session, {})).files).toEqual([])
    expect(await sessionReferences(session, 'resolve', [])).toMatchObject({ text: 'reference content' })
    granted = false
    await expect(sessionFileUpload(session, { ...upload, uploadId: randomUUID() })).rejects.toBeDefined()
    await expect(sessionWorkspaceChanges(session, {})).rejects.toBeDefined()
  } finally {
    await closeSessionFileUploads(session)
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})

it('rejects a running legacy scope after same-path replacement by another real directory', async () => {
  const { lstat } = await import('node:fs/promises')
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agh-doc-identity-')))
  vi.stubEnv('AGH_HOME', home)
  const root = join(home, 'chats')
  await mkdir(root)
  await writeFile(join(root, 'note'), 'original')
  const identity = await lstat(root, { bigint: true })
  const readScope = {
    root,
    legacyManagedRoot: root,
    legacyDirectoryIdentity: `${identity.dev}:${identity.ino}`,
  }
  const authority = { readScope, stat: async () => {} }
  try {
    expect((await readWorkspace(root, 'note', authority)).text).toBe('original')
    await expect(
      readWorkspace(root, 'note', { stat: authority.stat, readScope: { root, legacyManagedRoot: root } }),
    ).rejects.toBeDefined()
    await rename(root, join(home, 'original'))
    await mkdir(root)
    await writeFile(join(root, 'note'), 'replacement')
    await expect(readWorkspace(root, 'note', authority)).rejects.toBeDefined()
    await expect(listWorkspace(root, '', authority, false)).rejects.toBeDefined()
  } finally {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})

it('checks legacy directory identity outside AGH_HOME while retaining ordinary public workspace reads', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agh-doc-external-data-')))
  const home = join(base, 'home')
  const root = join(base, 'external-data', 'chats')
  await mkdir(home)
  await mkdir(root, { recursive: true })
  vi.stubEnv('AGH_HOME', home)
  await writeFile(join(root, 'note'), 'original')
  const identity = await lstat(root, { bigint: true })
  const readScope = {
    root,
    legacyManagedRoot: root,
    legacyDirectoryIdentity: `${identity.dev}:${identity.ino}`,
  }
  const authority = { stat: async () => {}, readScope }
  try {
    expect((await readWorkspace(root, 'note', authority)).text).toBe('original')
    await rename(root, join(base, 'original'))
    await mkdir(root)
    await writeFile(join(root, 'note'), 'replacement')
    await expect(readWorkspace(root, 'note', authority)).rejects.toBeDefined()
    await expect(listWorkspace(root, '', authority, false)).rejects.toBeDefined()
    expect((await readWorkspace(root, 'note', { stat: authority.stat })).text).toBe('replacement')
  } finally {
    vi.unstubAllEnvs()
    await rm(base, { recursive: true, force: true })
  }
})
