import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../src/adapters/storage-sqlite.js'
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
    const root = realpathSync(dataDir)
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
      })

      await seedCreatingAttempt(dataDir, 'close-parent', 'close-child', 'close')
      await host.close()
      closed = true
      expect(await readAttempt(dataDir, 'close-child')).toMatchObject({
        creationPhase: 'cancelled',
        cancelledFact: { reason: 'open_failed' },
      })
    } finally {
      if (!closed) await host.close()
    }
  })
})
