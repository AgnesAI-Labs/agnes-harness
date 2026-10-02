import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seams as baseSeams } from '@agnes/base'
import type { InferenceEvent, JsonValue } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../src/adapters/storage-sqlite.js'
import type { HostSession } from '../src/host.js'
import { createTestHost } from '../testkit/index.js'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-task5-workspace-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function childAttempt(parentKey: string, childKey: string, suffix: string) {
  return {
    childKey,
    parentKey,
    boundarySeq: 0,
    creationId: `creation:${suffix}`,
    attemptId: `attempt:${suffix}`,
    attemptStartedAt: 1,
    kind: 'spawn' as const,
    rootTaskId: `root:${suffix}`,
    runtimeOwnerSessionKey: parentKey,
    generationDepth: 1,
    generationLimit: 2,
    maxFanOut: 4,
    inputHash: suffix.padEnd(64, 'a').slice(0, 64),
    inputText: 'work',
    cwd: '/workspace',
    actorId: 'actor',
    isolation: 'shared' as const,
    workspaceId: `workspace:${suffix}`,
    treeCapMicro: 1_000_000n,
    childCapMicro: null,
    writerRunId: `writer:${suffix}`,
  }
}

async function seedCreatingAttempt(dataDir: string, parentKey: string, childKey: string, suffix: string) {
  const storage = createSqliteStorage({
    file: join(dataDir, 'sessions.db'),
    tablesDir: join(dataDir, 'tables'),
  })
  try {
    await storage.open(parentKey, { writerRunId: `parent-writer:${suffix}`, ttlMs: 1_000 })
    await storage.ensureRootScope(`root:${suffix}`, 1_000_000n)
    await storage.createDelegatedChild(childAttempt(parentKey, childKey, suffix))
  } finally {
    await storage.close()
  }
}

async function readAttempt(dataDir: string, childKey: string) {
  const storage = createSqliteStorage({
    file: join(dataDir, 'sessions.db'),
    tablesDir: join(dataDir, 'tables'),
  })
  try {
    return await storage.lookupByKey(childKey)
  } finally {
    await storage.close()
  }
}

describe('Task 5 production workspace acceptance', () => {
  it('compiles and enforces the selected non-default preset for each session workspace', async () => {
    const dataDir = tempDir()
    mkdirSync(join(dataDir, 'secret'), { recursive: true })
    writeFileSync(join(dataDir, 'secret', 'value.txt'), 'private')
    const root = realpathSync.native(dataDir)
    const { host } = await createTestHost({
      dataDir,
      allowed: ['standard', 'strict'],
      presets: {
        strict: {
          name: 'strict',
          extends: 'standard',
          sandbox: {
            level: 'L0',
            required: false,
            on_unavailable: 'allow',
            extra_paths: [],
            deny_paths: ['secret'],
            network_allow: [],
          },
        },
      },
      disableSessionTitle: true,
    })
    try {
      const binding = (sessionKey: string) =>
        host.acceptWorkspaceBinding(
          {
            version: 1,
            sessionKey,
            workspaceId: sessionKey === 'standard-session' ? 'a'.repeat(64) : 'b'.repeat(64),
            revision: 1,
            canonicalRoot: root,
          },
          sessionKey,
        )
      const standard = await host.createSession({
        key: 'standard-session',
        cwd: root,
        preset: 'standard',
        binding: binding('standard-session'),
      })
      const strict = await host.createSession({
        key: 'strict-session',
        cwd: root,
        preset: 'strict',
        binding: binding('strict-session'),
      })

      await expect(
        standard.d.workspaceInvocation?.run((view) => view.fs().read('secret/value.txt')),
      ).resolves.toEqual(new TextEncoder().encode('private'))
      await expect(
        strict.d.workspaceInvocation?.run((view) => view.fs().read('secret/value.txt')),
      ).rejects.toMatchObject({ code: 'E_FS_DENIED' })
      await strict.setYolo(true, strict.d.actor)
      await expect(
        strict.d.workspaceInvocation?.run((view) => view.fs().read('secret/value.txt')),
      ).rejects.toMatchObject({ code: 'E_FS_DENIED' })
    } finally {
      await host.close()
    }
  })

  it('applies full access to file tools and checkpoints only for the selected session', async () => {
    const dataDir = tempDir()
    const root = realpathSync.native(dataDir)
    const outside = realpathSync.native(tempDir())
    const path = join(outside, 'state.txt')
    writeFileSync(path, 'before')
    const calls: Array<{ name: string; args: Record<string, JsonValue> }> = [
      { name: 'write', args: { path, content: 'after' } },
      { name: 'read', args: { path } },
      { name: 'edit', args: { path, edits: [{ oldText: 'after', newText: 'edited' }] } },
      { name: 'ls', args: { path: outside } },
      { name: 'find', args: { path: outside, pattern: '*.txt' } },
      { name: 'grep', args: { path: outside, pattern: 'edited' } },
    ]
    const script = Array.from({ length: 3 }, () => [
      ...calls.map(({ name, args }): InferenceEvent[] => [
        { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 }, via: 'native' },
        { type: 'done', reason: 'toolUse' },
      ]),
      [
        { type: 'text_delta', delta: 'done' },
        { type: 'done', reason: 'stop' },
      ] as InferenceEvent[],
    ]).flat()
    const { host } = await createTestHost({
      dataDir,
      script,
      packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
      packages: { '@agnes/base': { seams: { checkpoint: baseSeams.checkpoint } } },
      disableSessionTitle: true,
    })
    const open = (key: string) =>
      host.createSession({
        key,
        binding: host.acceptWorkspaceBinding(
          { version: 1, sessionKey: key, workspaceId: 'c'.repeat(64), revision: 1, canonicalRoot: root },
          key,
        ),
      })
    const results = async (session: HostSession) => {
      const before = session.lastSeq
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'exercise the selected file permission mode' }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      const rows = await session.scan({ type: 'tool/result', fromSeq: before + 1, limit: 20 })
      return rows.map((row) => row.data as { isError?: boolean; content?: Array<{ text?: string }> })
    }
    try {
      const session = await open('file-access')
      const peer = await open('file-access-peer')
      const invocation = session.d.workspaceInvocation
      const peerInvocation = peer.d.workspaceInvocation
      if (!invocation || !peerInvocation) throw new Error('test sessions need workspace invocations')
      const refused = await results(session)
      expect(refused).toHaveLength(calls.length)
      expect(refused.every((result) => result.isError)).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe('before')

      await session.setYolo(true, session.d.actor)
      await Promise.all([
        expect(invocation.run((view) => view.fs().read(path))).resolves.toEqual(
          new TextEncoder().encode('before'),
        ),
        expect(peerInvocation.run((view) => view.fs().read(path))).rejects.toMatchObject({
          code: 'E_FS_DENIED',
        }),
      ])
      await expect(invocation.run((view) => view.fs().read('.git/config'))).rejects.toMatchObject({
        code: 'E_FS_DENIED',
      })
      // The test home is the workspace, so its profiles are inside the allow rule; full access still
      // reads them but may not rewrite them.
      const profileYaml = join(root, 'profiles', 'local-dev', 'profile.yaml')
      mkdirSync(join(root, 'profiles', 'local-dev'), { recursive: true })
      writeFileSync(profileYaml, 'name: local-dev\n')
      await expect(invocation.run((view) => view.fs().read(profileYaml))).resolves.toEqual(
        new TextEncoder().encode('name: local-dev\n'),
      )
      await expect(
        invocation.run((view) => view.fs().write(profileYaml, new TextEncoder().encode('approvals: off'))),
      ).rejects.toMatchObject({ code: 'E_FS_DENIED', message: expect.stringContaining('denied by policy') })
      expect(readFileSync(profileYaml, 'utf8')).toBe('name: local-dev\n')
      const saved = await invocation.run((view) => view.checkpointContext().snapshot([path], 'external'))
      const allowed = await results(session)
      expect(allowed).toHaveLength(calls.length)
      for (const [index, result] of allowed.entries())
        expect(result.isError, JSON.stringify({ tool: calls[index]?.name, result })).not.toBe(true)
      const output = (index: number) => allowed[index]?.content?.map((part) => part.text ?? '').join('')
      expect(output(1)).toContain('after')
      for (const index of [3, 4, 5]) expect(output(index)).toContain('state.txt')
      expect(output(5)).toContain('edited')
      expect(readFileSync(path, 'utf8')).toBe('edited')

      await session.setYolo(false, session.d.actor)
      const revoked = await results(session)
      expect(revoked).toHaveLength(calls.length)
      expect(revoked.every((result) => result.isError)).toBe(true)
      await expect(invocation.run((view) => view.checkpointContext().rewind(saved.id))).rejects.toMatchObject(
        {
          code: 'E_FS_DENIED',
        },
      )
      expect(readFileSync(path, 'utf8')).toBe('edited')
      await session.setYolo(true, session.d.actor)
      await invocation.run((view) => view.checkpointContext().rewind(saved.id))
      expect(readFileSync(path, 'utf8')).toBe('before')
      await expect(peerInvocation.run((view) => view.fs().read(path))).rejects.toMatchObject({
        code: 'E_FS_DENIED',
      })
      // An invocation must observe a revocation without waiting for the next invocation.
      await invocation.run(async (view) => {
        await session.setYolo(false, session.d.actor)
        await expect(view.fs().read(path)).rejects.toMatchObject({ code: 'E_FS_DENIED' })
        await session.setYolo(true, session.d.actor)
        await expect(view.fs().read(path)).resolves.toEqual(new TextEncoder().encode('before'))
      })
      await session.close()
      const restoredFull = await open('file-access')
      expect(restoredFull.yolo).toBe(true)
      await expect(restoredFull.d.workspaceInvocation?.run((view) => view.fs().read(path))).resolves.toEqual(
        new TextEncoder().encode('before'),
      )
      await restoredFull.setYolo(false, restoredFull.d.actor)
      await restoredFull.close()
      const restoredWorkspace = await open('file-access')
      expect(restoredWorkspace.yolo).toBe(false)
      await expect(
        restoredWorkspace.d.workspaceInvocation?.run((view) => view.fs().read(path)),
      ).rejects.toMatchObject({ code: 'E_FS_DENIED' })
    } finally {
      await host.close()
    }
  })

  it('keeps a pinned secrets directory outside the home read-only under full access', async () => {
    const dataDir = tempDir()
    const root = realpathSync.native(dataDir)
    // Not <home>/secrets: only the profile's own pin names this directory.
    const secrets = join(realpathSync.native(tempDir()), 'vault')
    mkdirSync(secrets, { recursive: true })
    writeFileSync(join(secrets, 'token'), 'CANARY-PINNED')
    const { host } = await createTestHost({
      dataDir,
      profileInputs: { user: { name: 'local-dev', adapters: { secrets: { kind: 'file', path: secrets } } } },
      disableSessionTitle: true,
    })
    try {
      const session = await host.createSession({
        key: 'pinned-secrets',
        binding: host.acceptWorkspaceBinding(
          {
            version: 1,
            sessionKey: 'pinned-secrets',
            workspaceId: 'd'.repeat(64),
            revision: 1,
            canonicalRoot: root,
          },
          'pinned-secrets',
        ),
      })
      const invocation = session.d.workspaceInvocation
      if (!invocation) throw new Error('test session needs a workspace invocation')
      await session.setYolo(true, session.d.actor)
      await expect(invocation.run((view) => view.fs().read(join(secrets, 'token')))).resolves.toEqual(
        new TextEncoder().encode('CANARY-PINNED'),
      )
      await expect(
        invocation.run((view) => view.fs().write(join(secrets, 'token'), new TextEncoder().encode('x'))),
      ).rejects.toMatchObject({ code: 'E_FS_DENIED', message: expect.stringContaining('denied by policy') })
      await expect(
        invocation.run((view) => view.fs().write(join(secrets, 'fresh'), new TextEncoder().encode('x'))),
      ).rejects.toMatchObject({ code: 'E_FS_DENIED' })
      expect(readFileSync(join(secrets, 'token'), 'utf8')).toBe('CANARY-PINNED')
    } finally {
      await host.close()
    }
  })

  it('recovers stale child creation attempts during production startup and close', async () => {
    const dataDir = tempDir()
    await seedCreatingAttempt(dataDir, 'startup-parent', 'startup-child', 'startup')

    const { host } = await createTestHost({ dataDir, disableSessionTitle: true })
    let closed = false
    try {
      expect(await readAttempt(dataDir, 'startup-child')).toMatchObject({
        creationPhase: 'cancelled',
        cancelledFact: { reason: 'open_failed' },
        state: 'failed',
      })
      // The recovered child no longer holds its parent's only fan-out slot.
      const storage = createSqliteStorage({
        file: join(dataDir, 'sessions.db'),
        tablesDir: join(dataDir, 'tables'),
      })
      try {
        const next = await storage.createDelegatedChild({
          ...childAttempt('startup-parent', 'startup-next', 'startup'),
          creationId: 'creation:startup-next',
          workspaceId: 'workspace:startup-next',
          maxFanOut: 1,
        })
        expect(next.status).toBe('created')
      } finally {
        await storage.close()
      }

      await seedCreatingAttempt(dataDir, 'close-parent', 'close-child', 'close')
      await host.close()
      closed = true
      expect(await readAttempt(dataDir, 'close-child')).toMatchObject({
        creationPhase: 'cancelled',
        cancelledFact: { reason: 'open_failed' },
        state: 'failed',
      })
    } finally {
      if (!closed) await host.close()
    }
  })
})
