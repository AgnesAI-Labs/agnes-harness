import type { Provider } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import type { FsPolicy } from '../../src/effects/fs-guard.js'
import type { SeamImplementations } from '../../src/effects/seams.js'
import type { FsOps } from '../../src/effects/tool-context.js'
import { SeamRuntime } from '../../src/effects/wrap.js'
import { defaultIds } from '../../src/ids.js'
import { MemoryStorage } from '../../src/log/memory-storage.js'
import { openTracked } from '../../src/reduce/tracker.js'
import { ToolRegistry } from '../../src/registry/tools.js'
import { type PresetView, presetDefaults } from '../../src/step/preset.js'
import { type SessionDeps, SessionImpl } from '../../src/step/session.js'
import { createWorkspaceInvocationPort } from '../../src/workspace/runtime.js'
import { fencedFs, testFsPolicy } from '../../testkit/fenced-fs.js'
import { fakeSeams } from './fake-seams.js'
import { opHistory } from './op-history.js'

export const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }

/**
 * The file system the test sessions run against: a fake that stores nothing, behind the fence a
 * delivered one applies. Unfenced it would be laxer than anything a host assembles, and core
 * refuses to open a session against a file system that enforces no policy at all.
 */
export const testFsOps = (policy: FsPolicy = testFsPolicy('/w')): FsOps =>
  fencedFs(
    {
      read: async () => new Uint8Array(),
      write: async () => undefined,
      list: async () => [],
      stat: async () => ({ kind: 'file' as const, size: 0, mtimeMs: 0 }),
    },
    policy,
  )

export function testWorkspaceInvocation(
  fsOps: FsOps = testFsOps(),
  seams: SeamImplementations = fakeSeams(),
  root = '/w',
) {
  return createWorkspaceInvocationPort(() => ({
    source: {
      root,
      fs: fsOps,
      ready: async () => ({ confine: async (argv) => [...(await seams.sandbox.confine([...argv]))] }),
      hookSnapshot: async () => ({ workspaceDigest: 'test', policyRevision: 'test', hooks: [] }),
      hookSandbox: seams.sandbox,
      approval: seams.approval,
      checkpoint: seams.checkpoint,
    },
    release: () => undefined,
  }))
}
export const noTimers = { setTimeout: () => 0, clearTimeout: () => undefined }

const meta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe' as const,
  costHint: undefined,
  deferLoading: undefined,
  requiresApproval: undefined,
}

export const readTool = (
  fn: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }> = async (args) => ({
    content: [{ type: 'text' as const, text: `read:${JSON.stringify(args)}` }],
  }),
) =>
  ({
    name: 'read',
    description: 'read',
    parameters: Type.Object({}),
    meta,
    execute: fn,
  }) as never

export const shellTool = (
  fn: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }> = async () => ({
    content: [{ type: 'text' as const, text: 'ran' }],
  }),
) =>
  ({
    name: 'shell',
    description: 'shell',
    parameters: Type.Object({}),
    meta: {
      ...meta,
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: false,
      replay: 'never' as const,
      requiresApproval: 'destructive' as const,
    },
    execute: fn,
  }) as never

/** Read-only, but it brings back text the harness did not write: the row it writes is untrusted. */
export const openWorldTool = (
  fn: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }> = async () => ({
    content: [{ type: 'text' as const, text: 'from the web' }],
  }),
) =>
  ({
    name: 'fetch_page',
    description: 'fetch',
    parameters: Type.Object({}),
    meta: { ...meta, isOpenWorld: true },
    execute: fn,
  }) as never

/**
 * Writes, but is neither destructive nor marked as needing approval — so it is the tool that asks
 * for nothing in a clean turn and has to ask once the turn is tainted.
 */
export const writeTool = (
  fn: (args: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }> = async () => ({
    content: [{ type: 'text' as const, text: 'written' }],
  }),
) =>
  ({
    name: 'write_note',
    description: 'write',
    parameters: Type.Object({}),
    meta: { ...meta, isReadOnly: false, replay: 'never' as const },
    execute: fn,
  }) as never

/** Timers that fire on the next microtask, for a test that has to get through a retry backoff. */
export const immediateTimers = {
  setTimeout: (fn: () => void) => {
    queueMicrotask(fn)
    return 0
  },
  clearTimeout: () => undefined,
}

export async function openSession(
  over: Partial<SessionDeps> & {
    provider: Provider
    seams?: SeamImplementations
    preset?: PresetView
    storage?: MemoryStorage
    key?: string
    writerRunId?: string
    clock?: () => number
    fsOps?: FsOps
  },
) {
  const storage = over.storage ?? new MemoryStorage()
  const clock = over.clock ?? (() => 1_757_203_200_000)
  const ids = over.ids ?? defaultIds(clock)
  // openTracked owns the SurfaceCache and feeds it from onAppended. Building a second one here
  // would leave session.surface() empty and the model would never see the user's question.
  const { log, tracker, surface, ui } = await openTracked({
    storage,
    key: over.key ?? 'k',
    writerRunId: over.writerRunId ?? 'r1',
    ttlMs: 60_000,
    ids,
    clock,
    timers: noTimers,
    ...(over.lane ? { lane: over.lane } : {}),
  })
  // Program-counter cells after every commit, for a test that cuts the ledger short to fake a crash.
  const ops = opHistory(log)
  const preset = over.preset ?? presetDefaults()
  const seams = over.seams ?? fakeSeams()
  const fsOps = over.fsOps ?? testFsOps()
  const workspaceInvocation = over.workspaceInvocation ?? testWorkspaceInvocation(fsOps, seams, over.cwd)
  const runtime = new SeamRuntime(seams, preset, {
    clock,
    onFailure: () => undefined,
    workspaceInvocation,
  })
  const { fsOps: _fsOps, ...sessionOver } = over
  const registry = over.registry ?? new ToolRegistry()
  const session = new SessionImpl({
    log,
    tracker,
    surface,
    ui,
    lane: 'main',
    runtime,
    registry,
    operations: [],
    preset,
    contract: { contract_id: null, parser_version: '1' },
    children: {
      create: async () => {
        throw new Error('no children in test')
      },
    },
    ids,
    clock,
    actor,
    resolvedProfileHash: null,
    cwd: '/w',
    workspaceInvocation,
    netFetch: async () => new Response(''),
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    timers: noTimers,
    ...sessionOver,
  })
  await session.start()
  return { session, storage, log, tracker, ui, opCellsBefore: ops.before, opWrites: ops.writes }
}
