import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { Host, WorkspaceBinding } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { InferenceEvent } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import type { SessionCommandFrame, SessionOpenFrame } from '../src/frames.js'
import { HostedSessions } from '../src/hosted-sessions.js'
import { SharedSessionChannel } from '../src/shared-session-channel.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const say = (text: string): InferenceEvent[] => [
  { type: 'text_delta', delta: text },
  { type: 'done', reason: 'stop' },
]

function command(
  sessionKey: string,
  method: SessionCommandFrame['method'],
  params: Record<string, unknown>,
): SessionCommandFrame {
  return { kind: 'command', requestId: `${sessionKey}:${method}`, sessionKey, method, params }
}

function tracingRemoteTransport(ownerCommands: string[][]) {
  let alive = true
  const guard = () => {
    if (!alive) throw new Error('remote transport closed')
  }
  return {
    alive: () => alive,
    close: async () => {
      alive = false
    },
    exec: async (argv: string[], options: { cwd: string; env?: Record<string, string>; stdin?: string }) => {
      guard()
      if (argv[0] === 'mkdir' || argv[0] === 'rm') ownerCommands.push([...argv])
      const [bin, ...args] = argv
      if (!bin) throw new Error('empty remote argv')
      return await new Promise<{
        code: number
        stdout: string
        stderr: string
        truncated: false
      }>((resolve, reject) => {
        const child = spawn(bin, args, {
          cwd: options.cwd,
          ...(options.env ? { env: options.env } : {}),
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk)
        })
        child.on('error', reject)
        child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr, truncated: false }))
        child.stdin.end(options.stdin)
      })
    },
    upload: async (files: Array<{ path: string; content: Uint8Array }>) => {
      guard()
      for (const file of files) {
        await mkdir(dirname(file.path), { recursive: true })
        await writeFile(file.path, file.content)
      }
    },
    download: async (paths: string[]) => {
      guard()
      return Promise.all(paths.map(async (path) => ({ path, content: new Uint8Array(await readFile(path)) })))
    },
  }
}

it('the real remote worker fork keeps the parent owner directory and child binding', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-worker-fork-workspace-'))
  dirs.push(dataDir)
  const root = realpathSync(dataDir)
  const remoteBase = join(root, 'remote-owners')
  const ownerCommands: string[][] = []
  const transport = tracingRemoteTransport(ownerCommands)
  const built = await createTestHost({
    dataDir,
    provider: new ScriptedProvider({ scripts: [say('ready to fork')] }),
    disableSessionTitle: true,
    profileInputs: {
      user: {
        name: 'local-dev',
        packages: [
          {
            id: '@agnes/base',
            source: 'builtin',
            config: {
              rootTemplate: `${remoteBase.replace(/\\/g, '/')}/{session}`,
              keepOnClose: false,
            },
          },
        ],
      },
    },
    packages: {
      '@agnes/base': {
        openTransport: async () => transport,
      },
    },
  })
  const childRuntimes: WorkspaceBinding[] = []
  const actualCreateSession = built.host.createSession.bind(built.host)
  const host: Host = {
    ...built.host,
    createSession: async (options) => {
      const session = await actualCreateSession(options)
      if (options.parent) childRuntimes.push(session.d.workspaceIdentity as WorkspaceBinding)
      return session
    },
  }
  const hosted = new HostedSessions({
    host,
    channel: new SharedSessionChannel(() => undefined),
    send: () => undefined,
    workerGeneration: 1,
    workspaceRoot: root,
  })
  const sessionKey = 'worker-parent'
  const open: SessionOpenFrame = {
    kind: 'session.open',
    requestId: 'open:worker-parent',
    sessionKey,
    params: {
      binding: {
        version: 1,
        sessionKey,
        workspaceId: 'a'.repeat(64),
        revision: 7,
        canonicalRoot: root,
      },
    },
  }

  try {
    await hosted.open(open)
    const parent = built.host.kernel.get(sessionKey)
    if (!parent) throw new Error('worker did not publish the parent session')
    await hosted.dispatch(
      command(sessionKey, 'enqueue', {
        target: 'next-turn',
        msg: {
          kind: 'prompt',
          actor: parent.d.actor,
          content: [{ type: 'text', text: 'establish a completed fork boundary' }],
        },
      }),
    )
    await expect(
      hosted.dispatch(command(sessionKey, 'run', { runId: 'parent-turn', until: 'turn-end' })),
    ).resolves.toMatchObject({ reason: 'completed' })
    const [boundary] = await parent.scan({ type: 'turn/end', order: 'desc', limit: 1 })
    if (!boundary) throw new Error('missing completed fork boundary')

    await expect(
      hosted.dispatch(
        command(sessionKey, 'fork', {
          at: boundary.seq,
          childKey: 'worker-child',
          binding: {
            version: 1,
            sessionKey: 'worker-child',
            workspaceId: 'a'.repeat(64),
            revision: 7,
            canonicalRoot: root,
          },
        }),
      ),
    ).resolves.toMatchObject({ sessionId: 'worker-child' })
    await expect(
      hosted.open({
        kind: 'session.open',
        requestId: 'open:worker-child:wrong-binding',
        sessionKey: 'worker-child',
        params: {
          binding: {
            version: 1,
            sessionKey: 'worker-child',
            workspaceId: 'b'.repeat(64),
            revision: 7,
            canonicalRoot: root,
          },
          parent: { key: sessionKey, boundarySeq: boundary.seq },
          resume: true,
        },
      }),
    ).rejects.toThrow('authority does not match')
    await expect(
      hosted.open({
        kind: 'session.open',
        requestId: 'open:worker-child:wrong-parent',
        sessionKey: 'worker-child',
        params: {
          binding: {
            version: 1,
            sessionKey: 'worker-child',
            workspaceId: 'a'.repeat(64),
            revision: 7,
            canonicalRoot: root,
          },
          parent: { key: sessionKey, boundarySeq: boundary.seq + 1 },
          resume: true,
        },
      }),
    ).rejects.toThrow('authority does not match')
    await hosted.open({
      kind: 'session.open',
      requestId: 'open:worker-child',
      sessionKey: 'worker-child',
      params: {
        binding: {
          version: 1,
          sessionKey: 'worker-child',
          workspaceId: 'a'.repeat(64),
          revision: 7,
          canonicalRoot: root,
        },
        parent: { key: sessionKey, boundarySeq: boundary.seq },
        resume: true,
      },
    })

    expect(childRuntimes).toHaveLength(1)
    expect(childRuntimes[0]).toEqual({
      sessionKey: 'worker-child',
      workspaceId: 'a'.repeat(64),
      authorityRevision: 7,
      canonicalRoot: root,
    })
    expect(parent.d).not.toHaveProperty('workspaceRuntime')
    expect(hosted.keys()).toEqual([sessionKey, 'worker-child'])
    const parentOwnerRoot = `${remoteBase}/${createHash('sha256').update(sessionKey).digest('hex')}`
    expect(ownerCommands).toEqual([['mkdir', '-p', parentOwnerRoot]])

    await hosted.close(sessionKey)
    expect(ownerCommands).toEqual([['mkdir', '-p', parentOwnerRoot]])
    await hosted.close('worker-child')
    expect(ownerCommands).toEqual([
      ['mkdir', '-p', parentOwnerRoot],
      ['rm', '-rf', parentOwnerRoot],
    ])
  } finally {
    await hosted.closeAll()
    await built.host.close()
  }
}, 30_000)
