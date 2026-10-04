import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { ReplacementOperation, SandboxSeam, SeamWorkspace } from '@agnes/core'
import { fakeSeams, testFsPolicy } from '@agnes/core/testkit'
import type { ToolDef, ToolResult } from '@agnes/extension-api'
import type { RouteDecl } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryPackageLoader, type PackageModule } from '../../src/assemble/packages.js'
import { type AssembleDeps, assemble } from '../../src/assemble.js'
import { createMemoryAudit } from '../../src/audit.js'
import { resolveProfile } from '../../src/profile/resolve.js'
import { createSession } from '../../src/session.js'
import { SessionWorkspaceRuntimeTable } from '../../src/session-workspace-runtime.js'
import { WorkspaceBindingAuthority } from '../../src/workspace-authority.js'
import { attachTestSeamPlugins } from '../../testkit/cordis-seams.js'

const pluginId = '@test/tool-execution'
const route: RouteDecl = {
  route: 'fixture',
  api: 'openai',
  baseUrl: 'https://example.invalid/v1',
  models: [
    {
      id: 'fixture-model',
      name: 'fixture-model',
      api: 'openai',
      route: 'fixture',
      baseUrl: 'https://example.invalid/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
      toolCallFormats: ['native'],
      thinkingReplay: 'native',
      contract_id: null,
    },
  ],
}
const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})

function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

type Mode = 'delegate' | 'replace' | 'disabled' | 'duplicate' | 'double-next'

async function fixture(mode: Mode) {
  const root = mkdtempSync(join(tmpdir(), 'agnes-tool-execution-'))
  closes.push(async () => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'original.txt'), 'original payload')
  const seams = fakeSeams()
  const base = attachTestSeamPlugins({
    id: '@agnes/base',
    seams: {
      approval: async () => seams.approval,
      checkpoint: async () => seams.checkpoint,
      ledger: async () => seams.ledger,
      sandbox: async () => ({
        ...seams.sandbox,
        fsPolicy: () => testFsPolicy(realpathSync.native(root)),
        forWorkspace: async (workspace: SeamWorkspace): Promise<SandboxSeam> => ({
          ...seams.sandbox,
          fsPolicy: () => workspace.policy,
          enforcement: () => workspace.enforcement,
        }),
      }),
      verifier: async () => seams.verifier,
      repair: async () => seams.repair,
      artifacts: async () => seams.artifacts,
      principals: async () => seams.principals,
      harness: async () => seams.harness,
    },
    sandboxWorkspaceProbe: async () => ({
      name: 'none',
      execBackend: 'none',
      degraded: true,
      enforcement: { level: 'partial', scope: ['file'] },
      confine: ({ argv }) => argv,
    }),
    presets: { base: { name: 'base' } },
  })
  let entryIntentSeq: number | undefined
  let delegatedResult: ToolResult | undefined
  const replace = vi.fn<ReplacementOperation<'ToolExecution'>['replace']>(
    async ({ input, next, session }) => {
      const intents = (await session.scan({ type: 'effect/intent', toSeq: session.lastSeq })).filter(
        (row) => field(row.data, 'kind') === 'tool',
      )
      expect(intents).toHaveLength(1)
      entryIntentSeq = intents[0]?.seq
      expect(
        (await session.scan({ type: 'effect/settled', toSeq: session.lastSeq })).filter(
          (row) => field(row.data, 'effectId') === field(intents[0]?.data, 'effectId'),
        ),
      ).toEqual([])
      expect(session.op()?.phase).toMatchObject({
        kind: 'tools',
        batch: { calls: [expect.objectContaining({ dispatchAttempt: 1, dispatchPhase: 'may_have_sent' })] },
      })
      expect(input.name).toBe('plugin_read')
      if (mode === 'replace') {
        const bytes = await input.context.fs.read('original.txt')
        return { content: [{ type: 'text', text: `plugin:${new TextDecoder().decode(bytes)}` }] }
      }
      delegatedResult = await next()
      if (mode === 'double-next') await next()
      return delegatedResult
    },
  )
  const operation: ReplacementOperation<'ToolExecution'> = {
    name: 'fixture/tool-execution',
    slot: { replace: 'ToolExecution' },
    replay: 'never',
    applicable: async () => 'applied',
    run: async () => ({}),
    replace,
  }
  const factory = vi.fn(() => operation)
  const modules: Record<string, PackageModule> = {
    '@agnes/base': base,
    '@agnes/code': { id: '@agnes/code', presets: { standard: { name: 'standard', extends: 'base' } } },
    '@agnes/ai': { id: '@agnes/ai' },
    [pluginId]: { id: pluginId, operations: { toolExecution: factory } },
  }
  if (mode === 'duplicate') base.operations = { other: () => ({ ...operation, name: 'fixture/second' }) }
  const lock = Object.fromEntries(
    Object.keys(modules).map((id) => [
      id,
      {
        version: '0.1.0',
        integrity: 'sha512-fixture',
        trust: 'builtin' as const,
        enabled: id !== pluginId || mode !== 'disabled',
      },
    ]),
  )
  const profile = await resolveProfile(
    {
      builtin: 'local-dev',
      lock: { packages: lock },
      user: {
        name: 'local-dev',
        packages: [{ id: pluginId, source: `builtin:${pluginId}`, enabled: mode !== 'disabled' }],
        provider: { package: '@agnes/ai', adapters: ['@agnes/ai'], routes: [route] },
      },
    },
    {
      platform: { os: 'linux', arch: 'x64', capabilities: {} },
      agnesVersion: '0.1.0',
      now: '2026-10-04T00:00:00Z',
    },
  )
  const loader = new MemoryPackageLoader(modules)
  const imported = vi.spyOn(loader, 'importPackage')
  const provider = new ScriptedProvider({
    models: route.models ?? [],
    onExhausted: 'error',
    scripts: [
      [
        {
          type: 'toolcall_end',
          call: { toolUseId: '', name: 'plugin_read', args: {}, ordinal: 0 },
          via: 'native',
        },
        { type: 'done', reason: 'toolUse' },
      ],
      [
        { type: 'text_delta', delta: 'done' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  const deps: AssembleDeps = {
    dataDir: join(root, 'data'),
    profileDir: join(root, 'profile'),
    workspaceRoot: root,
    homeDir: root,
    hostRoot: process.cwd(),
    loader,
    audit: createMemoryAudit(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    providerFactory: () => provider,
    env: { ...process.env },
  }
  // These are trusted in-process package fixtures; production snapshot admission is unchanged.
  const installation = assemble(profile, deps)
  if (mode === 'duplicate') return { installation, factory, replace, imported }
  const assembly = await installation
  closes.push(async () => {
    await assembly.rollback.unwind()
  })
  const builtin = vi.fn(
    async (_args: unknown, context: Parameters<ToolDef['execute']>[1]): Promise<ToolResult> => {
      const bytes = await context.fs.read('original.txt')
      return { content: [{ type: 'text', text: `builtin:${new TextDecoder().decode(bytes)}` }] }
    },
  )
  const tool: ToolDef = {
    name: 'plugin_read',
    description: 'read the fixture file',
    parameters: Type.Object({}),
    meta: {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      costHint: undefined,
      deferLoading: undefined,
      requiresApproval: 'never',
    },
    execute: builtin,
  }
  assembly.kernel.tools.add(tool, { source: 'fixture/tool', trust: 'builtin' })
  const binding = new WorkspaceBindingAuthority().accept(
    {
      version: 1,
      sessionKey: 'tool-execution',
      workspaceId: 'a'.repeat(64),
      revision: 1,
      canonicalRoot: realpathSync.native(root),
    },
    'tool-execution',
  )
  const table = new SessionWorkspaceRuntimeTable()
  assembly.rollback.push('fixture-workspace', () => table.closeAll())
  const runtime = await table.open(binding, () => assembly.openWorkspaceRuntime(binding))
  const session = await createSession(profile, assembly, { key: binding.sessionKey, binding }, undefined, {
    runtime,
    lifecycle: table.lifecycle(binding.sessionKey),
    children: table,
    invocation: table.invocation(binding.sessionKey),
  })
  closes.push(() => session.close())
  await session.enqueue('next-turn', { actor: session.d.actor, content: [{ type: 'text', text: 'read' }] })
  await session.acceptInput()
  await session.runInference()
  return {
    installation,
    assembly,
    session,
    factory,
    operation,
    replace,
    builtin,
    imported,
    provider,
    entryIntentSeq: () => entryIntentSeq,
    delegatedResult: () => delegatedResult,
    originalFile: () => readFileSync(join(root, 'original.txt'), 'utf8'),
  }
}

async function opened(mode: Exclude<Mode, 'duplicate'>) {
  const f = await fixture(mode)
  const { session, assembly, builtin, operation, entryIntentSeq, delegatedResult, originalFile } = f
  if (!session || !assembly || !builtin || !operation || !entryIntentSeq || !delegatedResult || !originalFile)
    throw new Error('fixture did not open a session')
  return { ...f, session, assembly, builtin, operation, entryIntentSeq, delegatedResult, originalFile }
}

describe('assembled ToolExecution replacement', () => {
  it.each(['delegate', 'replace'] as const)(
    'runs the selected package %s inside the original effect boundary',
    async (mode) => {
      const f = await opened(mode)
      expect(f.factory).toHaveBeenCalledOnce()
      expect(f.imported.mock.calls.map(([id]) => id)).toContain(pluginId)
      expect(f.session.d.segments?.ToolExecution).toBe(f.operation)
      await f.session.runToolsPhase()
      expect(f.replace).toHaveBeenCalledOnce()
      expect(f.builtin).toHaveBeenCalledTimes(mode === 'delegate' ? 1 : 0)
      const rows = await f.session.scan({ fromSeq: 1, toSeq: f.session.lastSeq })
      const intents = rows.filter((row) => row.type === 'effect/intent' && field(row.data, 'kind') === 'tool')
      const settled = rows.filter(
        (row) =>
          row.type === 'effect/settled' &&
          field(row.data, 'effectId') === field(intents[0]?.data, 'effectId'),
      )
      const results = rows.filter((row) => row.type === 'tool/result')
      expect(intents).toHaveLength(1)
      expect(intents[0]?.seq).toBe(f.entryIntentSeq())
      expect(settled).toHaveLength(1)
      expect(settled[0]?.data).toMatchObject({ effectId: field(intents[0]?.data, 'effectId'), outcome: 'ok' })
      expect(results).toHaveLength(1)
      expect(results[0]?.data).toMatchObject({
        content: [{ type: 'text', text: `${mode === 'delegate' ? 'builtin' : 'plugin'}:original payload` }],
      })
      if (mode === 'delegate')
        await expect(f.replace.mock.results[0]?.value).resolves.toBe(f.delegatedResult())
      expect(f.session.pendingEffects()).toEqual([])
      expect(f.originalFile()).toBe('original payload')
    },
  )

  it('does not import or construct a disabled package and keeps the original handler', async () => {
    const f = await opened('disabled')
    expect(f.imported.mock.calls.map(([id]) => id)).not.toContain(pluginId)
    expect(f.factory).not.toHaveBeenCalled()
    expect(f.session.d.segments?.ToolExecution).toBeUndefined()
    await f.session.runToolsPhase()
    expect(f.builtin).toHaveBeenCalledOnce()
    expect(f.replace).not.toHaveBeenCalled()
    const intents = (await f.session.scan({ type: 'effect/intent', toSeq: f.session.lastSeq })).filter(
      (row) => field(row.data, 'kind') === 'tool',
    )
    expect(intents).toHaveLength(1)
    expect(
      (await f.session.scan({ type: 'effect/settled', toSeq: f.session.lastSeq })).filter(
        (row) => field(row.data, 'effectId') === field(intents[0]?.data, 'effectId'),
      ),
    ).toHaveLength(1)
  })

  it('rejects two loaded replacement owners before creating a Kernel or dispatching', async () => {
    const f = await fixture('duplicate')
    await expect(f.installation).rejects.toMatchObject({
      code: 'E_SEAM_INIT',
      message: expect.stringContaining('E_REGISTRY_DUPLICATE: duplicate core op ToolExecution'),
    })
    expect(f.factory).toHaveBeenCalledOnce()
    expect(f.replace).not.toHaveBeenCalled()
  })

  it('does not enter the plugin or original handler when the durable intent commit fails', async () => {
    const f = await opened('delegate')
    const commit = f.assembly.adapters.storage.commit.bind(f.assembly.adapters.storage)
    const failing = vi.spyOn(f.assembly.adapters.storage, 'commit').mockImplementation((key, tx) => {
      if (tx.events.some((event) => event.type === 'effect/intent'))
        throw new Error('fixture intent write failed')
      return commit(key, tx)
    })
    try {
      await expect(f.session.runToolsPhase()).rejects.toThrow('fixture intent write failed')
      expect(f.replace).not.toHaveBeenCalled()
      expect(f.builtin).not.toHaveBeenCalled()
      const rows = await f.assembly.adapters.storage.scan(f.session.key, {
        fromSeq: 1,
        toSeq: f.session.lastSeq,
      })
      expect(
        rows.filter((row) => row.type === 'effect/intent' && field(row.data, 'kind') === 'tool'),
      ).toEqual([])
      expect(rows.filter((row) => row.type === 'tool/result')).toEqual([])
    } finally {
      failing.mockRestore()
    }
  })

  it('keeps the original execution single use when a plugin calls next twice', async () => {
    const f = await opened('double-next')
    await f.session.runToolsPhase()
    expect(f.builtin).toHaveBeenCalledOnce()
    expect(f.replace).toHaveBeenCalledOnce()
    const results = await f.session.scan({ type: 'tool/result', toSeq: f.session.lastSeq })
    expect(results).toHaveLength(1)
    expect(results[0]?.data).toMatchObject({ isError: true })
    const intents = (await f.session.scan({ type: 'effect/intent', toSeq: f.session.lastSeq })).filter(
      (row) => field(row.data, 'kind') === 'tool',
    )
    expect(intents).toHaveLength(1)
    expect(
      (await f.session.scan({ type: 'effect/settled', toSeq: f.session.lastSeq })).filter(
        (row) => field(row.data, 'effectId') === field(intents[0]?.data, 'effectId'),
      ),
    ).toHaveLength(1)
  })
})
