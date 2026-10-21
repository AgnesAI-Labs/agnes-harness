import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { createSqliteStorage } from '@agnes/host-infrastructure/adapters/storage-sqlite'
import { createSandboxSeam } from '@agnes/host-infrastructure/sandbox-seam'
import type { InferenceEvent, JsonValue, Provider, RequestBody } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostSession } from '../../src/runtime/lifecycle/host.js'
import { createTestHost } from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base', import.meta.url))
const PARENT = 'subagent-parent'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

type Script = InferenceEvent[] | ((req: RequestBody) => InferenceEvent[])

const toolCall = (name: string, args: Record<string, JsonValue>): InferenceEvent[] => [
  { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 }, via: 'native' },
  { type: 'done', reason: 'toolUse' },
]
const text = (value: string): InferenceEvent[] => [
  { type: 'text_delta', delta: value },
  { type: 'done', reason: 'stop' },
]

/**
 * Parent and child share one provider and may run concurrently (spawn), so requests are routed by
 * session key instead of by global call order.
 */
class RoutedProvider implements Provider {
  private readonly parent: ScriptedProvider
  private readonly child: ScriptedProvider
  readonly childKeys: string[] = []
  readonly childRequests: RequestBody[] = []

  /** Holds every child model request until released. */
  childGate: Promise<void> = Promise.resolve()

  constructor(parent: Script[], child: Script[]) {
    const models = [fakeModel({ route: 'gw', id: 'm1' })]
    this.parent = new ScriptedProvider({
      models,
      scripts: [
        ...['subagent_fork', 'subagent_spawn', 'subagent_list', 'subagent_collect'].map(
          (name) => (req: RequestBody) => {
            expect(req.tools.some((tool) => tool.name === 'tool_describe')).toBe(true)
            return toolCall('tool_describe', { name })
          },
        ),
        ...parent,
      ],
      onExhausted: 'error',
    })
    this.child = new ScriptedProvider({ models, scripts: child, onExhausted: 'error' })
  }

  models() {
    return this.parent.models()
  }

  infer(req: RequestBody, opts: { signal: AbortSignal; toolNames: string[] }) {
    if (req.sessionKey === PARENT) return this.parent.infer(req, opts)
    this.childKeys.push(req.sessionKey)
    this.childRequests.push(req)
    const gate = this.childGate
    const inner = this.child.infer(req, opts)
    return (async function* () {
      await gate
      yield* inner
    })()
  }
}

async function workspaceHost(provider: Provider) {
  const dataDir = tempDir('agnes-subagent-workspace-')
  const root = realpathSync.native(dataDir)
  // The production sandbox seam: unbound at the Kernel level, fitted per workspace by the Host.
  const { host } = await createTestHost({
    dataDir,
    packageDirs: { '@agnes/base': baseDir },
    provider,
    disableSessionTitle: true,
    sandboxSeam: createSandboxSeam(),
  })
  // The shape a shared worker opens: an authenticated binding and a stable key, no cwd override.
  const binding = host.acceptWorkspaceBinding(
    { version: 1, sessionKey: PARENT, workspaceId: 'a'.repeat(64), revision: 1, canonicalRoot: root },
    PARENT,
  )
  const session = await host.createSession({ key: PARENT, binding })
  return { host, session, dataDir, root }
}

async function prompt(session: HostSession, value: string) {
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text: value }],
    actor: session.d.actor,
    kind: 'prompt',
  })
  return session.run({ until: 'turn-end', signal: new AbortController().signal })
}

type ToolResult = {
  toolUseId?: string
  code?: string
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
}

async function toolResults(session: HostSession): Promise<ToolResult[]> {
  const rows = await session.scan({ type: 'tool/result', limit: 50 })
  const calls = await session.scan({ type: 'tool/call', limit: 50 })
  const discoveryIds = new Set(
    calls.flatMap((row) => {
      const call = row.data as { toolUseId: string; name: string }
      return call.name === 'tool_describe' ? [call.toolUseId] : []
    }),
  )
  const results = rows.map((row) => row.data as ToolResult)
  const descriptions = results.filter((result) => discoveryIds.has(result.toolUseId ?? ''))
  expect(descriptions).toHaveLength(4)
  for (const result of descriptions) expect(result.isError).not.toBe(true)
  const listIds = new Set(
    calls.flatMap((row) => {
      const call = row.data as { toolUseId: string; name: string }
      return call.name === 'subagent_list' ? [call.toolUseId] : []
    }),
  )
  for (const result of results.filter((result) => listIds.has(result.toolUseId ?? '')))
    expect(result.isError).not.toBe(true)
  return results.filter(
    (result) => !discoveryIds.has(result.toolUseId ?? '') && !listIds.has(result.toolUseId ?? ''),
  )
}

const textOf = (result: ToolResult | undefined): string =>
  (result?.content ?? []).map((block) => block.text ?? '').join('')

async function childRecord(dataDir: string, childKey: string) {
  const storage = createSqliteStorage({
    file: join(dataDir, 'sessions.db'),
    tablesDir: join(dataDir, 'inspect-tables'),
  })
  try {
    return await storage.lookupByKey(childKey)
  } finally {
    await storage.close()
  }
}

const listChildren = toolCall('subagent_list', {})

function listedChild(req: RequestBody): string {
  // Read only model-visible tool content, never Host state or UI-only receipt details.
  const result = req.messages.filter((message) => message.role === 'tool_result').at(-1)
  expect(result?.isError).toBe(false)
  const listed = result?.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
  // A deferred worktree child is collectable while its follow-up controls are still starting.
  const childKey = listed?.match(/^(subagent-parent\/[A-Z0-9]+) \w+(?: continuable)?$/m)?.[1]
  if (!childKey) throw new Error(`subagent_list did not expose a child: ${listed}`)
  return childKey
}

function collectListed(req: RequestBody): InferenceEvent[] {
  return toolCall('subagent_collect', { childKey: listedChild(req), wait: true })
}

describe('subagents in a workspace-bound Host session', () => {
  it('collects a forked child turn and leaves it idle for follow-ups', async () => {
    const provider = new RoutedProvider(
      [
        toolCall('subagent_fork', { question: 'summarise the workspace', isolation: 'shared' }),
        listChildren,
        collectListed,
        text('parent done'),
      ],
      [text('child answer')],
    )
    const { host, session, dataDir } = await workspaceHost(provider)
    try {
      const out = await prompt(session, 'delegate')
      expect(out.reason).toBe('completed')
      const [fork, collect] = await toolResults(session)
      expect(fork?.isError).not.toBe(true)
      expect(collect?.isError).not.toBe(true)
      expect(textOf(collect)).toBe('child answer')
      const childKey = provider.childKeys[0]
      expect(childKey?.startsWith(`${PARENT}/`)).toBe(true)
      expect(await childRecord(dataDir, childKey as string)).toMatchObject({
        creationPhase: 'committed',
        state: 'idle',
      })
    } finally {
      await host.close()
    }
  })

  it('runs subagent_spawn and lets the parent collect the child result', async () => {
    let childKey = ''
    const provider = new RoutedProvider(
      [
        toolCall('subagent_spawn', { task: 'count the files', isolation: 'shared' }),
        listChildren,
        (req) => {
          childKey = listedChild(req)
          return toolCall('subagent_collect', { childKey, wait: true })
        },
        text('parent collected'),
      ],
      [
        toolCall('read', { path: 'probe.txt' }),
        (req) => {
          expect(JSON.stringify(req.messages)).toContain('child workspace input')
          return text('three files')
        },
      ],
    )
    const { host, session, dataDir, root } = await workspaceHost(provider)
    try {
      writeFileSync(join(root, 'probe.txt'), 'child workspace input')
      const out = await prompt(session, 'spawn and collect')
      expect(out.reason).toBe('completed')
      const [spawn, collect] = await toolResults(session)
      expect(spawn?.isError).not.toBe(true)
      expect(childKey).not.toBe('')
      expect(collect?.isError).not.toBe(true)
      expect(textOf(collect)).toBe('three files')
      const req = provider.childRequests[0]
      if (!req) throw new Error('missing child request')
      // The parent's spawn call is still executing when this first child request is built.
      expect(req.tools.some((tool) => tool.name === 'read')).toBe(true)
      expect(req.messages.some((message) => message.role === 'assistant')).toBe(false)
      expect(JSON.stringify(req.messages)).not.toContain('spawn and collect')
      expect(JSON.stringify(req.messages)).toContain('count the files')
      expect(JSON.stringify(req.messages)).toContain('delegated child agent')
      expect((await childRecord(dataDir, childKey))?.cwd).toBe(root)
      expect(await childRecord(dataDir, childKey)).toMatchObject({
        creationPhase: 'committed',
        state: 'idle',
      })
    } finally {
      await host.close()
    }
  })

  it('opens a worktree spawn under the parent workspace sandbox', async () => {
    let childKey = ''
    const provider = new RoutedProvider(
      [
        toolCall('subagent_spawn', { task: 'work in a worktree', isolation: 'worktree' }),
        listChildren,
        (req) => {
          childKey = listedChild(req)
          return toolCall('subagent_collect', { childKey, wait: true })
        },
        text('parent collected'),
      ],
      [text('child answered')],
    )
    const { host, session, dataDir, root } = await workspaceHost(provider)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git('init', '-b', 'main')
    git('config', 'user.email', 'subagent@example.test')
    git('config', 'user.name', 'subagent')
    writeFileSync(join(root, '.gitignore'), '*\n!.gitignore\n.worktrees\n')
    git('add', '.gitignore')
    git('commit', '-m', 'init')
    try {
      expect((await prompt(session, 'spawn into a worktree')).reason).toBe('completed')
      const [spawn, collect] = await toolResults(session)
      expect(spawn?.isError).not.toBe(true)
      expect(textOf(spawn)).not.toMatch(/worktree skipped/)
      expect(textOf(collect)).toBe('child answered')
      const record = await childRecord(dataDir, childKey)
      expect(record).toMatchObject({ isolation: 'worktree', creationPhase: 'committed', state: 'idle' })
      expect(record?.cwd.startsWith(join(root, '.worktrees', 'agnes-'))).toBe(true)
    } finally {
      await host.close()
    }
  })

  it('holds an extension activation until an in-flight spawned child turn has ended', async () => {
    let release!: () => void
    const provider = new RoutedProvider(
      [toolCall('subagent_spawn', { task: 'slow work', isolation: 'shared' }), text('parent done')],
      [text('slow answer')],
    )
    provider.childGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { host, session, dataDir } = await workspaceHost(provider)
    try {
      expect((await prompt(session, 'spawn and move on')).reason).toBe('completed')
      await expect.poll(() => provider.childKeys.length).toBe(1)
      const childKey = provider.childKeys[0] as string
      expect(host.activationBarrier.snapshot().active.turn).toBe(1)
      let switchedWith: unknown
      const activation = host.activationBarrier.quiesce('test.child-turn', async () => {
        switchedWith = (await childRecord(dataDir, childKey))?.state
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(switchedWith).toBeUndefined()
      release()
      await activation
      expect(switchedWith).toBe('idle')
    } finally {
      release()
      await host.close()
    }
  })

  it('queues a child spawned while an activation is quiescing instead of failing it', async () => {
    let host!: Awaited<ReturnType<typeof workspaceHost>>['host']
    let activation: Promise<unknown> | undefined
    let childAtSwitch: unknown
    let childKey = ''
    const provider = new RoutedProvider(
      [
        () => {
          // The activation starts while the parent turn is live, before its spawn call runs.
          activation = host.activationBarrier.quiesce('test.spawn-during-switch', async () => {
            childAtSwitch = { requests: provider.childKeys.length }
          })
          return toolCall('subagent_spawn', { task: 'queued work', isolation: 'shared' })
        },
        listChildren,
        (req) => {
          childKey = listedChild(req)
          return text('parent done')
        },
      ],
      [text('queued answer')],
    )
    const opened = await workspaceHost(provider)
    host = opened.host
    try {
      expect((await prompt(opened.session, 'spawn during a switch')).reason).toBe('completed')
      await activation
      expect(childAtSwitch).toEqual({ requests: 0 })
      await expect.poll(async () => (await childRecord(opened.dataDir, childKey))?.state).toBe('idle')
    } finally {
      await host.close()
    }
  })

  it.each([false, true])(
    'bounds child file access by the parent permission switch (%s)',
    async (fullAccess) => {
      const outside = realpathSync.native(tempDir('agnes-subagent-outside-'))
      const escapePath = join(outside, 'escape.txt')
      let host!: Awaited<ReturnType<typeof workspaceHost>>['host']
      let direct: Promise<unknown> | undefined
      const provider = new RoutedProvider(
        [
          toolCall('write', { path: escapePath, content: 'parent' }),
          toolCall('subagent_fork', { question: 'write two files', isolation: 'shared' }),
          listChildren,
          collectListed,
          text('parent done'),
        ],
        [
          (req) => {
            // The child's own workspace capability, asked directly while the child is live.
            const child = host.kernel.get(req.sessionKey)
            direct = child?.d.workspaceInvocation?.run((view) =>
              view.fs().write(escapePath, new TextEncoder().encode('direct')),
            )
            provider.childGate =
              direct?.then(
                () => undefined,
                () => undefined,
              ) ?? Promise.resolve()
            return toolCall('write', { path: 'inside.txt', content: 'inside' })
          },
          toolCall('read', { path: escapePath }),
          toolCall('write', { path: escapePath, content: 'child' }),
          text('child done'),
        ],
      )
      const opened = await workspaceHost(provider)
      host = opened.host
      const { session, root } = opened
      try {
        await session.setYolo(fullAccess, session.d.actor)
        expect((await prompt(session, 'delegate writes')).reason).toBe('completed')
        const [parentWrite, fork, collect] = await toolResults(session)
        expect(fork?.isError).not.toBe(true)
        expect(collect?.isError).not.toBe(true)
        expect(textOf(collect)).toBe('child done')

        const child = provider.childKeys[0] as string
        const childRows = await session.d.log.storage.scan(child, { type: 'tool/result', limit: 10 })
        const [inside, _readOutside, outsideWrite] = childRows.map(
          (row) => row.data as ToolResult & { code?: string },
        )
        expect(inside?.isError).not.toBe(true)
        expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toBe('inside')
        // The user's full-access choice governs descendants too; standard still stays fenced.
        expect(parentWrite?.isError === true).toBe(!fullAccess)
        expect(outsideWrite?.isError === true).toBe(!fullAccess)
        if (fullAccess) {
          await expect(direct).resolves.toBeUndefined()
          expect(readFileSync(escapePath, 'utf8')).toBe('child')
        } else {
          expect(textOf(parentWrite)).toContain('E_FS_DENIED')
          expect(textOf(outsideWrite)).toBe(textOf(parentWrite))
          expect(outsideWrite?.code).toBe(parentWrite?.code)
          expect(outsideWrite).toMatchObject({
            enforcement: (parentWrite as { enforcement?: unknown }).enforcement,
          })
          expect(outsideWrite).toMatchObject({ enforcement: { level: 'full' } })
          await expect(direct).rejects.toMatchObject({ code: 'E_FS_DENIED' })
          expect(existsSync(escapePath)).toBe(false)
        }
      } finally {
        await host.close()
      }
    },
  )
})
