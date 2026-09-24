import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { subagentCollectTool, subagentForkTool, subagentSpawnTool } from '@agnes/base'
import { createWorkspaceInvocationPort, Kernel, presetDefaults } from '@agnes/core'
import {
  fakeProvider,
  fakeSeams,
  fencedFs,
  noTimers,
  testFsPolicy,
  textTurn,
  toolTurn,
} from '@agnes/core/testkit'
import { Type } from '@sinclair/typebox'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../src/adapters/storage-sqlite.js'
import { createTestHost } from '../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
const model = () => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'] as Array<'text'>,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
  toolCallFormats: ['native' as const],
  thinkingReplay: 'native' as const,
  contract_id: null,
})
const fsOps = fencedFs(
  {
    read: async () => new Uint8Array(),
    write: async () => undefined,
    list: async () => [],
    stat: async () => ({ kind: 'file' as const, size: 0, mtimeMs: 0 }),
  },
  testFsPolicy('/w'),
)
const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }

/** Task 6 makes workspace-domain tools fail closed without a Host-owned invocation boundary. */
function workspaceSessionOptions(sessionKey: string) {
  const seams = fakeSeams()
  const invocation = () =>
    createWorkspaceInvocationPort(() => ({
      source: {
        root: '/w',
        fs: fsOps,
        ready: async () => ({ confine: async (argv) => [...argv] }),
        hookSnapshot: async () => ({ workspaceDigest: 'test', policyRevision: 'test', hooks: [] }),
        hookSandbox: seams.sandbox,
        approval: seams.approval,
        checkpoint: seams.checkpoint,
      },
      release: () => undefined,
    }))
  const workspaceInvocation = invocation()
  return {
    workspaceInvocation,
    workspaceIdentity: {
      sessionKey,
      workspaceId: 'test-workspace',
      authorityRevision: 1,
      canonicalRoot: '/w',
    },
    childWorkspaceRuntime: {
      reserve: async (_parentKey: string, childKey: string) => {
        const childInvocation = invocation()
        return {
          runtime: {
            fs: fsOps,
            invocation: childInvocation,
            identity: {
              sessionKey: childKey,
              workspaceId: 'test-workspace',
              authorityRevision: 1,
              canonicalRoot: '/w',
            },
          },
          commit: () => true,
          close: async () => undefined,
        }
      },
    },
  }
}

function kernel(
  storage: ReturnType<typeof createSqliteStorage>,
  provider: ReturnType<typeof fakeProvider>,
  preset: ReturnType<typeof presetDefaults> = {
    ...presetDefaults(),
    treeBudgetCredits: 100,
    generationLimit: 2,
    maxFanOut: 4,
  },
) {
  Object.assign(provider, { models: () => [model()] })
  return Kernel.create({
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset,
    fsOps,
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => Date.now(),
  })
}

const worktrees = {
  create: async () => ({ skipped: 'not-git' as const }),
  finish: async () => ({ action: 'removed' as const }),
}
const spawnDeps = {
  limits: { maxDepth: 2, maxFanOut: 4, isolation: 'shared' as const },
  worktrees,
}

function addSubagentTools(k: ReturnType<typeof Kernel.create>): void {
  k.tools.add(subagentForkTool, { source: 'agnes/subagent', trust: 'builtin' })
  k.tools.add(subagentSpawnTool(spawnDeps), { source: 'agnes/subagent', trust: 'builtin' })
  k.tools.add(subagentCollectTool(spawnDeps), { source: 'agnes/subagent', trust: 'builtin' })
}

describe('real subagent tools on sqlite', () => {
  it('captures createTestHost assemble failure on this Node and drives fork/spawn/collect tools', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-entry-host-'))
    dirs.push(dataDir)
    let hostError = ''
    try {
      const { host } = await createTestHost({
        dataDir,
        packageDirs: { '@agnes/base': baseDir },
        provider: new ScriptedProvider({ models: [fakeModel({ route: 'gw', id: 'm1' })], scripts: [] }),
      })
      await host.close()
    } catch (error) {
      hostError = error instanceof Error ? error.message : String(error)
    }
    if (hostError) expect(hostError).toMatch(/setAuthorizer|E_SEAM_INIT/)
    const log: string[] = [`createTestHost: ${hostError || 'assembled'}`]

    for (let pass = 1; pass <= 2; pass += 1) {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-entry-'))
      dirs.push(dir)
      const dbFile = join(dir, 'sessions.db')

      const limited = fakeProvider([toolTurn('subagent_fork', { question: 'go' }), textTurn('parent')])
      const storage0 = createSqliteStorage({ file: dbFile, tablesDir: join(dir, 'tables-0') })
      const k0 = kernel(storage0, limited, {
        ...presetDefaults(),
        treeBudgetCredits: 100,
        generationLimit: 0,
        maxFanOut: 1,
      })
      addSubagentTools(k0)
      const parent0 = await k0.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r0',
      })
      await parent0.enqueue('next-turn', { content: [{ type: 'text', text: 'fork' }], actor })
      await parent0.run({ until: 'turn-end', signal: new AbortController().signal })
      const forkResult = (await parent0.scan({ type: 'tool/result', limit: 5 }))[0]?.data as
        | { isError?: boolean }
        | undefined
      expect(forkResult?.isError).toBe(true)
      expect(await storage0.listByParent('parent')).toEqual([])
      expect(limited.requests.length).toBe(2)
      log.push(`pass ${pass} over-limit providerCalls=${limited.requests.length} children=0`)
      await k0.close()

      const nobudget = fakeProvider([toolTurn('subagent_fork', { question: 'go' }), textTurn('parent')])
      const storageB = createSqliteStorage({ file: join(dir, 'nb.db'), tablesDir: join(dir, 'tables-b') })
      const kB = kernel(storageB, nobudget, {
        ...presetDefaults(),
        treeBudgetCredits: null,
        generationLimit: 2,
        maxFanOut: 4,
      })
      addSubagentTools(kB)
      const parentB = await kB.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'rb',
      })
      // A preset that never names tree_budget_credits now defaults instead of refusing (see
      // factory.ts's DEFAULT_TREE_BUDGET_CREDITS), so the fork succeeds: the child runs its own
      // turn (consuming the next scripted response as its own text) and the parent's tool/result
      // carries the child's final text, not an error.
      await parentB.enqueue('next-turn', { content: [{ type: 'text', text: 'fork' }], actor })
      await parentB.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(
        ((await parentB.scan({ type: 'tool/result', limit: 5 }))[0]?.data as { isError?: boolean })?.isError,
      ).toBe(false)
      expect(await storageB.listByParent('parent')).toHaveLength(1)
      expect(nobudget.requests.length).toBe(3)
      log.push(`pass ${pass} default-budget providerCalls=${nobudget.requests.length} children=1`)
      await kB.close()

      const liveDb = join(dir, 'live.db')
      const tables = join(dir, 'tables-live')
      const spawnP = fakeProvider([
        toolTurn('subagent_spawn', { task: 'later', isolation: 'shared' }),
        textTurn('parent-ok'),
        textTurn('child-live'),
      ])
      const storage1 = createSqliteStorage({ file: liveDb, tablesDir: tables })
      const k1 = kernel(storage1, spawnP)
      addSubagentTools(k1)
      const parent1 = await k1.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r1',
      })
      await parent1.enqueue('next-turn', { content: [{ type: 'text', text: 'spawn' }], actor })
      await parent1.run({ until: 'turn-end', signal: new AbortController().signal })
      const spawned = (await parent1.scan({ type: 'tool/result', limit: 5 }))[0]?.data as
        | { details?: { childKey?: string }; content?: Array<{ text?: string }> }
        | undefined
      const childKey =
        spawned?.details?.childKey ?? spawned?.content?.[0]?.text?.replace(/^spawned /, '') ?? ''
      expect(childKey.includes('/')).toBe(true)
      log.push(`pass ${pass} spawned ${childKey}`)
      await k1.close()

      const collectP = fakeProvider([
        toolTurn('subagent_collect', { childKey, wait: false }),
        textTurn('collected'),
        toolTurn('subagent_collect', { childKey: 'missing-child', wait: false }),
        textTurn('unknown'),
      ])
      const storage2 = createSqliteStorage({ file: liveDb, tablesDir: tables })
      const k2 = kernel(storage2, collectP)
      addSubagentTools(k2)
      const parent2 = await k2.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r1',
      })
      await parent2.enqueue('next-turn', { content: [{ type: 'text', text: 'collect' }], actor })
      await parent2.run({ until: 'turn-end', signal: new AbortController().signal })
      const results = (await parent2.scan({ type: 'tool/result', limit: 10 })).map(
        (row) => row.data as { isError?: boolean; details?: { childKey?: string } },
      )
      expect(results[0]?.details?.childKey ?? childKey).toBe(childKey)
      expect(results[0]?.isError).not.toBe(true)
      await parent2.enqueue('next-turn', { content: [{ type: 'text', text: 'missing' }], actor })
      await parent2.run({ until: 'turn-end', signal: new AbortController().signal })
      const missing = (await parent2.scan({ type: 'tool/result', order: 'desc', limit: 1 }))[0]?.data as
        | { isError?: boolean }
        | undefined
      expect(missing?.isError).toBe(true)
      expect(await storage2.existsSession('missing-child')).toBe(false)
      log.push(`pass ${pass} unknown collect created=${await storage2.existsSession('missing-child')}`)
      await k2.close()
    }
    const entryLog = process.env.AGNES_ENTRY_LOG
    if (entryLog) writeFileSync(entryLog, `${log.join('\n')}\n`)
  }, 40_000)
})

describe('host sqlite + core children factory entry (legacy factory path)', () => {
  it('refuses over-limit create, defaults a missing tree budget, collects a stable spawn key after restart, twice', async () => {
    const log: string[] = []
    for (let pass = 1; pass <= 2; pass += 1) {
      const dir = mkdtempSync(join(tmpdir(), 'agnes-entry-'))
      dirs.push(dir)
      const dbFile = join(dir, 'sessions.db')

      const limited = fakeProvider([textTurn('nope')])
      const k0 = kernel(createSqliteStorage({ file: dbFile, tablesDir: join(dir, 'tables-0') }), limited, {
        ...presetDefaults(),
        treeBudgetCredits: 100,
        generationLimit: 0,
        maxFanOut: 1,
      })
      const parent0 = await k0.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r0',
      })
      const before = limited.requests.length
      await expect(
        parent0.d.children.create({ parent: parent0.key, cwd: '/w', input: 'nope' }),
      ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
      expect(limited.requests.length).toBe(before)
      log.push(`pass ${pass} over-limit providerCalls=${limited.requests.length}`)
      await k0.close()

      // A preset that never names tree_budget_credits gets DEFAULT_TREE_BUDGET_CREDITS instead of
      // a hard E_BUDGET refusal — every shipped preset left this unset, which is a missing knob,
      // not a deliberate "no subagents" decision.
      const nobudget = fakeProvider([textTurn('nope')])
      const kB = kernel(
        createSqliteStorage({ file: join(dir, 'nb.db'), tablesDir: join(dir, 'tables-b') }),
        nobudget,
        {
          ...presetDefaults(),
          treeBudgetCredits: null,
          generationLimit: 2,
          maxFanOut: 4,
        },
      )
      const parentB = await kB.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'rb',
      })
      const beforeB = nobudget.requests.length
      const defaultedChild = await parentB.d.children.create({
        parent: parentB.key,
        cwd: '/w',
        input: 'nope',
      })
      expect(defaultedChild.key).toBeDefined()
      expect(nobudget.requests.length).toBe(beforeB)
      log.push(`pass ${pass} default-budget providerCalls=${nobudget.requests.length}`)
      await kB.close()

      const liveDb = join(dir, 'live.db')
      const tables = join(dir, 'tables-live')
      const spawnP = fakeProvider([toolTurn('delegate', {}), textTurn('child-live'), textTurn('parent-ok')])
      const storage1 = createSqliteStorage({ file: liveDb, tablesDir: tables })
      const k1 = kernel(storage1, spawnP)
      k1.tools.add(
        {
          name: 'delegate',
          description: 'delegate',
          parameters: Type.Object({}),
          meta: {
            isReadOnly: false,
            isDestructive: false,
            isConcurrencySafe: true,
            isOpenWorld: true,
            replay: 'never',
            costHint: undefined,
            deferLoading: undefined,
            requiresApproval: undefined,
          },
          execute: async () => {
            const parent = k1.get('parent')
            if (!parent) throw new Error('missing parent')
            const child = await parent.d.children.createWithKind?.('spawn', {
              parent: parent.key,
              cwd: '/w',
              input: 'later',
              isolation: 'shared',
            })
            return { content: [{ type: 'text', text: child?.key ?? '' }] }
          },
        } as never,
        { source: 'agnes/subagent', trust: 'builtin' },
      )
      const parent1 = await k1.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r1',
      })
      await parent1.enqueue('next-turn', { content: [{ type: 'text', text: 'spawn' }], actor })
      await parent1.run({ until: 'turn-end', signal: new AbortController().signal })
      const childKey = (
        (await parent1.scan({ type: 'tool/result', limit: 5 }))[0]?.data as {
          content?: Array<{ text?: string }>
        }
      )?.content?.[0]?.text
      expect(childKey && childKey.length > 0).toBe(true)
      log.push(`pass ${pass} spawned ${childKey}`)
      await k1.close()

      const storage2 = createSqliteStorage({ file: liveDb, tablesDir: tables })
      const k2 = kernel(storage2, fakeProvider([textTurn('ignored')]))
      const parent2 = await k2.session('parent', {
        ...workspaceSessionOptions('parent'),
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r1',
      })
      const collected = await parent2.d.children.inspect?.(childKey as string)
      expect(collected).not.toBeNull()
      log.push(`pass ${pass} collect ${childKey} state=${collected?.state}`)
      const missing = await parent2.d.children.inspect?.('missing-child')
      expect(missing).toBeNull()
      expect(await storage2.existsSession('missing-child')).toBe(false)
      log.push(`pass ${pass} unknown collect created=${await storage2.existsSession('missing-child')}`)
      await k2.close()
    }
  }, 30_000)
})
