import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { seams as baseSeams } from '@agnes/base'
import type { InferenceEvent, JsonValue, Provider, RequestBody } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'
import type { HostSession } from '../../src/host.js'
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
 * Parent and child share one provider, so requests are routed by session key instead of by global
 * call order.
 */
class RoutedProvider implements Provider {
  private readonly parent: ScriptedProvider
  private readonly child: ScriptedProvider
  readonly childKeys: string[] = []

  constructor(parent: Script[], child: Script[]) {
    const models = [fakeModel({ route: 'gw', id: 'm1' })]
    this.parent = new ScriptedProvider({ models, scripts: parent, onExhausted: 'error' })
    this.child = new ScriptedProvider({ models, scripts: child, onExhausted: 'error' })
  }

  models() {
    return this.parent.models()
  }

  infer(req: RequestBody, opts: { signal: AbortSignal; toolNames: string[] }) {
    if (req.sessionKey === PARENT) return this.parent.infer(req, opts)
    this.childKeys.push(req.sessionKey)
    return this.child.infer(req, opts)
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
    packages: { '@agnes/base': { seams: { sandbox: baseSeams.sandbox } } },
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
  name?: string
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
}

async function toolResults(session: HostSession): Promise<ToolResult[]> {
  const rows = await session.scan({ type: 'tool/result', limit: 50 })
  return rows.map((row) => row.data as ToolResult)
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

describe('subagents in a workspace-bound Host session', () => {
  it('runs subagent_fork to completion and returns the child text to the parent', async () => {
    const provider = new RoutedProvider(
      [toolCall('subagent_fork', { question: 'summarise the workspace' }), text('parent done')],
      [text('child answer')],
    )
    const { host, session, dataDir } = await workspaceHost(provider)
    try {
      const out = await prompt(session, 'delegate')
      expect(out.reason).toBe('completed')
      const [fork] = await toolResults(session)
      expect(fork?.isError).not.toBe(true)
      expect(textOf(fork)).toBe('child answer')
      const childKey = provider.childKeys[0]
      expect(childKey?.startsWith(`${PARENT}/`)).toBe(true)
      expect(await childRecord(dataDir, childKey as string)).toMatchObject({
        creationPhase: 'committed',
        state: 'completed',
      })
    } finally {
      await host.close()
    }
  })

  it('confines the child to the parent workspace: a write outside it is refused', async () => {
    const outside = realpathSync.native(tempDir('agnes-subagent-outside-'))
    const escapePath = join(outside, 'escape.txt')
    let host!: Awaited<ReturnType<typeof workspaceHost>>['host']
    let direct: Promise<unknown> | undefined
    const provider = new RoutedProvider(
      [
        toolCall('write', { path: escapePath, content: 'parent' }),
        toolCall('subagent_fork', { question: 'write two files' }),
        text('parent done'),
      ],
      [
        (req) => {
          // The child's own workspace capability, asked directly while the child is live.
          const child = host.kernel.get(req.sessionKey)
          direct = child?.d.workspaceInvocation?.run((view) =>
            view.fs().write(escapePath, new TextEncoder().encode('direct')),
          )
          direct?.catch(() => undefined)
          return toolCall('write', { path: 'inside.txt', content: 'inside' })
        },
        toolCall('write', { path: escapePath, content: 'child' }),
        text('child done'),
      ],
    )
    const opened = await workspaceHost(provider)
    host = opened.host
    const { session, root } = opened
    try {
      expect((await prompt(session, 'delegate writes')).reason).toBe('completed')
      const [parentWrite, fork] = await toolResults(session)
      expect(fork?.isError).not.toBe(true)
      expect(textOf(fork)).toBe('child done')

      const child = provider.childKeys[0] as string
      const childRows = await session.d.log.storage.scan(child, { type: 'tool/result', limit: 10 })
      const [inside, outsideWrite] = childRows.map((row) => row.data as ToolResult & { code?: string })
      expect(inside?.isError).not.toBe(true)
      expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toBe('inside')
      // Refused exactly as the parent's identical write is, under the same enforcement posture.
      expect(parentWrite?.isError).toBe(true)
      expect(outsideWrite?.isError).toBe(true)
      expect(outsideWrite).toMatchObject({
        code: (parentWrite as { code?: string }).code,
        enforcement: (parentWrite as { enforcement?: unknown }).enforcement,
      })
      expect(outsideWrite).toMatchObject({ enforcement: { level: 'full' } })
      await expect(direct).rejects.toMatchObject({ code: 'E_FS_DENIED' })
      expect(existsSync(escapePath)).toBe(false)
    } finally {
      await host.close()
    }
  })
})
