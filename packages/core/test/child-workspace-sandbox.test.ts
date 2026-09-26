import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { requireChildControl } from '../src/child/store.js'
import type { SandboxSeam } from '../src/effects/seams.js'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { presetDefaults } from '../src/step/preset.js'
import { type HookPort, noopHooks } from '../src/step/session.js'
import { testFsPolicy } from '../testkit/fenced-fs.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const catalogue = (): ModelRecord => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})

/** The Kernel-level seam a Host assembles: fitted per workspace, bound to none itself. */
const unbound: SandboxSeam = {
  forWorkspace: async () => bound(),
  exec: async () => {
    throw Object.assign(new Error('E_WORKSPACE_REQUIRED: unbound'), { code: 'E_WORKSPACE_REQUIRED' })
  },
  confine: async () => {
    throw Object.assign(new Error('E_WORKSPACE_REQUIRED: unbound'), { code: 'E_WORKSPACE_REQUIRED' })
  },
  fsPolicy: () => {
    throw Object.assign(new Error('E_WORKSPACE_REQUIRED: unbound'), { code: 'E_WORKSPACE_REQUIRED' })
  },
  enforcement: () => ({ level: 'none', scope: [] }),
}

function bound(): SandboxSeam {
  return {
    forWorkspace: async () => bound(),
    exec: async (cmd) => ({ code: 0, stdout: cmd.join(' '), stderr: '', truncated: false }),
    confine: async (argv) => argv,
    fsPolicy: () => testFsPolicy('/w'),
    enforcement: () => ({ level: 'full', scope: ['file', 'network', 'process'] }),
  }
}

function kernel(storage: MemoryStorage, maxFanOut = 4, hooks?: HookPort) {
  return Kernel.create({
    ...(hooks ? { hooks } : {}),
    storage,
    seams: fakeSeams({ sandbox: unbound }),
    provider: Object.assign(fakeProvider([textTurn('ok')]), { models: () => [catalogue()] }),
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 2, maxFanOut },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
  })
}

function reservations(sandbox: () => SandboxSeam | undefined, commit = () => true) {
  return {
    reserve: async (_parentKey: string, childKey: string) => {
      const fitted = sandbox()
      return {
        runtime: {
          fs: testFsOps(),
          identity: {
            sessionKey: childKey,
            workspaceId: 'workspace',
            authorityRevision: 1,
            canonicalRoot: '/w',
          },
        },
        ...(fitted ? { sandbox: fitted } : {}),
        commit,
        close: async () => undefined,
      }
    },
  }
}

const parentOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }

describe('delegated child sandbox', () => {
  it('opens the child with the sandbox its workspace reservation carries', async () => {
    const storage = new MemoryStorage()
    const k = kernel(storage)
    const parent = await k.session('parent', {
      ...parentOpts,
      seams: { sandbox: bound() },
      childWorkspaceRuntime: reservations(bound),
    })
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'work' })
    const opened = k.get(child.key)
    expect(opened?.d.runtime.enforcement()).toEqual({ level: 'full', scope: ['file', 'network', 'process'] })
    expect(opened?.d.runtime.sandboxAllowed()).toBe(true)
    await k.close()
  })

  it('never falls back to a permissive seam: without a fitted sandbox the child does not open', async () => {
    const storage = new MemoryStorage()
    const k = kernel(storage)
    const parent = await k.session('parent', {
      ...parentOpts,
      seams: { sandbox: bound() },
      childWorkspaceRuntime: reservations(() => undefined),
    })
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'work' }),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_REQUIRED' })
    await k.close()
  })

  it('settles a child whose open failed as failed, releasing its fan-out slot', async () => {
    const storage = new MemoryStorage()
    const k = kernel(storage, 1)
    let fitted: SandboxSeam | undefined
    const parent = await k.session('parent', {
      ...parentOpts,
      seams: { sandbox: bound() },
      childWorkspaceRuntime: reservations(() => fitted),
    })
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'first' }),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_REQUIRED' })
    const [failed] = await requireChildControl(storage).listByParent(parent.key)
    expect(failed).toMatchObject({ creationPhase: 'cancelled', state: 'failed' })
    expect(await parent.d.children.inspect?.(failed?.childKey as string)).toMatchObject({ state: 'error' })

    fitted = bound()
    const next = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'second' })
    expect(await requireChildControl(storage).lookupByKey(next.key)).toMatchObject({
      creationPhase: 'committed',
      state: 'ready',
    })
    await k.close()
  })

  it('reports the settled outcome to subagent_end when a child fails after attach', async () => {
    const outcomes: string[] = []
    const storage = new MemoryStorage()
    const k = kernel(storage, 4, {
      ...noopHooks,
      subagentEnd: async (payload) => {
        outcomes.push(payload.outcome)
      },
    })
    const parent = await k.session('parent', {
      ...parentOpts,
      seams: { sandbox: bound() },
      childWorkspaceRuntime: reservations(bound, () => false),
    })
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'lost commit' }),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_CLOSED' })
    const [record] = await requireChildControl(storage).listByParent(parent.key)
    expect(record).toMatchObject({ creationPhase: 'cancelled', state: 'failed' })
    expect(outcomes).toEqual(['failed'])
    await k.close()
  })
})
