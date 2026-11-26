import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { ChildExecutionState } from '@agnes/extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchChildEffect,
  runChildTurn,
  trackChildDispatch,
} from '../src/child/non-interruptible-receipt.js'
import { ChildLifecycleControls } from '../src/child/pause-control.js'
import { buildChildRecap } from '../src/child/recap-snapshot.js'
import {
  checkpointOpenOptions,
  cleanChildLabel,
  humanChildState,
  readChildCheckpoint,
  snapshotFromLedger,
  snapshotFromLive,
  snapshotFromRecord,
} from '../src/child/status.js'
import { Kernel } from '../src/kernel.js'
import { applyChildControl } from '../src/loop/child-controls.js'
import type { SessionImpl } from '../src/step/session.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, openSession, testFsOps, writeTool } from './helpers/open-session.js'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const key = 'parent/child'
const sessions = new Set<SessionImpl>()
afterEach(async () => {
  vi.restoreAllMocks()
  for (const s of sessions) await s.close()
  sessions.clear()
})

async function fixture(
  state: ChildExecutionState = 'ready',
  isolation: 'shared' | 'worktree' = 'shared',
  live = true,
) {
  const storage = new MemoryStorage()
  const provider = fakeProvider([toolTurn('write_note', {}), textTurn('finished')])
  const preset = { ...presetDefaults(), maxFanOut: 1 }
  const parent = (await openSession({ key: 'parent', storage, provider, preset })).session
  sessions.add(parent)
  const input = {
    fresh: true,
    childKey: key,
    parentKey: parent.key,
    boundarySeq: 0,
    creationId: 'creation',
    kind: 'spawn' as const,
    rootTaskId: 'root',
    runtimeOwnerSessionKey: parent.key,
    generationDepth: 1,
    generationLimit: 2,
    maxFanOut: 1,
    inputHash: 'abc',
    inputText: 'task',
    cwd: '/w',
    actorId: 'u',
    isolation,
    workspaceId: 'ws',
    treeCapMicro: 100_000_000n,
    childCapMicro: null,
    writerRunId: 'w',
  }
  await storage.ensureRootScope('root', input.treeCapMicro)
  const created = await storage.createDelegatedChild(input)
  if (created.status !== 'created') throw new Error('fixture child creation failed')
  const read = async () => {
    const record = await storage.lookupByKey(key)
    if (!record) throw new Error('Missing child record')
    return { ...record }
  }
  if (state !== 'creating')
    expect(await storage.casState(key, created.record.stateRevision, state)).toBe(true)
  const child = (await openSession({ key, storage, provider, preset })).session
  sessions.add(child)
  const local = new Map([[key, child]])
  if (!live) {
    await child.close()
    local.clear()
  }
  const retained = new Set<string>()
  const activate = vi.fn(async () => {})
  const port = {
    live: (id: string) => local.get(id),
    activate,
    release: async (id: string) => {
      await local.get(id)?.close()
      local.delete(id)
      retained.delete(id)
    },
    retain: (id: string) => retained.add(id),
  }
  const controls = new ChildLifecycleControls(() => parent, port).bind()
  return { storage, provider, parent, child, input, controls, read, local, retained, activate, port }
}

const stages = [
  ['pending', 'creating'],
  ['running', 'running'],
  ['waiting_approval', 'waiting_approval'],
  ['non-interruptible', 'running'],
  ['retained', 'idle'],
] as const
type Fixture = Awaited<ReturnType<typeof fixture>>
async function pendingDecision(child: SessionImpl) {
  return child.decisions
    .port({
      owner: 'test',
      sourcePackage: '@test/loop',
      packageVersion: '1',
      operationId: 'review',
      alive() {},
    })
    .request({
      key: 'review',
      purpose: 'business.confirm',
      subject: { text: 'Review' },
      prompt: 'Continue?',
      presentation: {
        en: { title: 'Review', fields: [{ label: 'Object', value: 'test' }], responseValue: 'review' },
      },
      options: ['continue', 'reject'],
    })
}
function activeCall(f: Fixture) {
  const tool = gate()
  trackChildDispatch(f.child, 'one-shot', 'write_note', tool.promise)
  return tool
}
for (const [stage, state] of stages) {
  describe(stage, () => {
    async function setup() {
      const f = await fixture(state)
      if (stage === 'waiting_approval') await pendingDecision(f.child)
      if (stage === 'retained') await f.controls.retainChild(key)
      return f
    }
    it('pauses at a durable checkpoint', async () => {
      const f = await setup()
      const tool = stage === 'non-interruptible' ? activeCall(f) : undefined
      const result = await f.controls.pauseChild(key)
      if (tool) {
        expect(result).toMatchObject({ status: 'running', pausePending: true })
        expect((await f.read()).state).toBe('running')
        tool.resolve()
        await vi.waitFor(async () => expect((await f.read()).state).toBe('paused'))
      } else expect(result).toMatchObject({ childKey: key, status: 'paused', executionState: 'paused' })
      await expect(f.controls.admitMessage(key, async () => true)).rejects.toMatchObject({
        code: 'E_RELATION',
      })
      const [event] = await f.child.scan({ type: 'x/core/child-checkpoint', limit: 1 })
      expect(event?.data).toMatchObject({
        childKey: key,
        previousState: state,
        reason: 'parent_pause',
        artifactPaths: [],
        completedEffectIds: [],
      })
      expect(await f.controls.pauseChild(key)).toMatchObject({ previousStatus: 'paused', status: 'paused' })
    })
    it('resumes the same child', async () => {
      const f = await setup()
      if (stage === 'non-interruptible') {
        const tool = activeCall(f)
        await f.controls.pauseChild(key)
        expect(await f.controls.resumeChild(key)).toMatchObject({
          previousStatus: 'running',
          executionState: 'running',
        })
        tool.resolve()
        expect(await f.child.controls.paused()).toBe(false)
      } else {
        await f.controls.pauseChild(key)
        const resumed = await f.controls.resumeChild(key)
        const next = stage === 'retained' ? 'idle' : stage === 'waiting_approval' ? state : 'ready'
        expect(resumed).toMatchObject({ childKey: key, previousStatus: 'paused', executionState: next })
        expect((await f.read()).state).toBe(next)
      }
    })
    it('cancels after in-flight work drains', async () => {
      const f = await setup()
      const tool = stage === 'non-interruptible' ? activeCall(f) : undefined
      const cancel = f.controls.cancelChild(key)
      if (tool) {
        await vi.waitFor(async () => expect((await f.read()).state).toBe('cancelling'))
        expect(await f.child.scan({ type: 'x/core/child-stop-receipt', limit: 1 })).toEqual([])
        tool.resolve()
      }
      expect(await cancel).toMatchObject({ status: 'cancelled', executionState: 'cancelled' })
      expect(f.local.size).toBe(0)
      if (tool) {
        const [row] = await f.storage.scan(key, { type: 'x/core/child-stop-receipt', limit: 1 })
        const receipt = row?.data as {
          cancelRequestedAt: number
          toolReturnedAt: number
          terminalConfirmedAt: number
        }
        expect(receipt).toMatchObject({ toolUseId: 'one-shot', disposition: 'drained_clean' })
        expect(receipt.cancelRequestedAt).toBeLessThanOrEqual(receipt.toolReturnedAt)
        expect(receipt.toolReturnedAt).toBeLessThanOrEqual(receipt.terminalConfirmedAt)
      }
    })
    it('closes only when stopped', async () => {
      const f = await setup()
      const tool = stage === 'non-interruptible' ? activeCall(f) : undefined
      if (state === 'running') {
        await expect(f.controls.closeChild(key)).rejects.toMatchObject({ code: 'E_RELATION' })
        expect((await f.read()).state).toBe('running')
        tool?.resolve()
      } else {
        expect(await f.controls.closeChild(key)).toMatchObject({
          executionState: state === 'idle' ? 'completed' : 'cancelled',
        })
        expect(f.local.size).toBe(0)
        expect(f.retained.size).toBe(0)
      }
    })
  })
}

it('coalesces concurrent revivals and waits for checkpoint persistence', async () => {
  const f = await fixture()
  const entered = gate(),
    flush = gate()
  const append = f.child.d.log.append.bind(f.child.d.log)
  vi.spyOn(f.child.d.log, 'append').mockImplementation(async (rows, opts) => {
    if (rows.some((e) => e.type === 'x/core/child-checkpoint')) {
      entered.resolve()
      await flush.promise
    }
    return append(rows, opts)
  })
  const parked = f.controls.pauseChild(key)
  await entered.promise
  const first = f.controls.resumeChild(key)
  expect(f.controls.resumeChild(key)).toBe(first)
  expect((await f.read()).state).toBe('ready')
  flush.resolve()
  expect(await parked).toMatchObject({ executionState: 'paused' })
  expect(await first).toMatchObject({ previousStatus: 'paused', executionState: 'ready' })
  expect(f.activate).toHaveBeenCalledTimes(1)
})

it('releases the slot on pause and preserves the checkpoint if re-admission is refused', async () => {
  const f = await fixture()
  await f.controls.pauseChild(key)
  expect(
    (
      await f.storage.createDelegatedChild({
        ...f.input,
        childKey: 'sibling',
        creationId: 'sibling',
        workspaceId: 'ws2',
      })
    ).status,
  ).toBe('created')
  await expect(f.controls.resumeChild(key)).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
  expect((await f.read()).state).toBe('paused')
})

it('refuses a cold resume after the isolated workspace was removed', async () => {
  const f = await fixture('idle', 'worktree')
  await f.controls.pauseChild(key)
  await f.child.close()
  f.local.clear()
  await f.storage.updateWorkspace('ws', { phase: 'worktree_removed' })
  await expect(f.controls.resumeChild(key)).rejects.toMatchObject({ code: 'E_WORKSPACE_CLOSED' })
  expect((await f.read()).state).toBe('paused')
})
it('preserves terminal failure over close and cancel', async () => {
  const f = await fixture('failed')
  expect(await f.controls.closeChild(key)).toMatchObject({ previousStatus: 'failed', status: 'failed' })
  expect(await f.controls.cancelChild(key)).toMatchObject({ previousStatus: 'failed', status: 'failed' })
  expect((await f.read()).state).toBe('failed')
})
it('refuses self, root and unsupported providers', async () => {
  const f = await fixture()
  for (const action of ['pauseChild', 'closeChild'] as const) {
    await expect(f.controls[action](f.parent.key)).rejects.toMatchObject({ code: 'E_UNAUTHORIZED' })
    const nested = new ChildLifecycleControls(() => f.child, f.port)
    await expect(nested[action](key)).rejects.toMatchObject({ code: 'E_UNAUTHORIZED' })
    await expect(nested[action](f.parent.key)).rejects.toMatchObject({ code: 'E_UNAUTHORIZED' })
  }
  const external = new ChildLifecycleControls(() => f.parent, { ...f.port, capabilities: () => ({}) })
  await expect(external.pauseChild(key)).rejects.toMatchObject({
    code: 'E_UNSUPPORTED',
    message: expect.stringMatching(/interrupt or cancel/),
  })
})

it('keeps a timed-out tool unconfirmed in the ledger', async () => {
  const f = await fixture('running')
  const tool = activeCall(f)
  await expect(f.controls.cancelChild(key, 0)).rejects.toMatchObject({ code: 'E_RELATION' })
  expect((await f.read()).state).toBe('cancelling')
  const [row] = await f.child.scan({ type: 'x/core/child-stop-receipt', limit: 1 })
  expect(row?.data).toMatchObject({
    disposition: 'timed_out_unknown',
    toolReturnedAt: null,
    terminalConfirmedAt: null,
  })
  const cold = new ChildLifecycleControls(() => f.parent, { ...f.port, live: () => undefined })
  await expect(cold.cancelChild(key)).rejects.toMatchObject({ code: 'E_RELATION' })
  expect((await f.read()).state).toBe('cancelling')
  tool.resolve()
  await f.controls.cancelChild(key)
  const [confirmed] = await f.storage.scan(key, {
    type: 'x/core/child-stop-receipt',
    order: 'desc',
    limit: 1,
  })
  expect(confirmed?.data).toMatchObject({
    disposition: 'drained_clean',
    toolUseId: 'one-shot',
    terminalConfirmedAt: expect.any(Number),
  })
})

it('uses the same durable status, execution state and controls for record, ledger and live views', async () => {
  for (const [state, status] of [
    ['creating', 'starting'],
    ['ready', 'starting'],
    ['running', 'running'],
    ['waiting_approval', 'waiting_approval'],
    ['paused', 'paused'],
    ['idle', 'idle'],
    ['disconnected', 'disconnected'],
    ['interrupted', 'interrupted'],
    ['recovery_pending', 'running'],
    ['cancelling', 'running'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const) {
    const f = await fixture(state)
    const record = await f.read()
    const base = snapshotFromRecord(record)
    expect(base).toMatchObject({ executionState: state, status })
    expect(await humanChildState(f.parent, record, f.child, true)).toMatchObject({
      executionState: state,
      status,
    })
    const projected = { status, executionState: state, controls: base.controls }
    expect(await snapshotFromLedger(f.parent, record)).toMatchObject(projected)
    expect(
      await snapshotFromLive(
        f.parent,
        { ...record, state: 'creating' },
        { state: 'ready', idle: false, lastSeq: f.child.lastSeq },
      ),
    ).toMatchObject(projected)
  }
})

it('resumes a real turn without repeating its one-shot write or losing the artifact', async ({
  onTestFinished,
}) => {
  const f = await fixture('running')
  const dir = await mkdtemp(join(tmpdir(), 'child-lifecycle-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const artifact = join(dir, 'answer.txt')
  const entered = gate(),
    finish = gate()
  f.child.d.registry.add(
    writeTool(async () => {
      entered.resolve()
      await trackChildDispatch(f.child, 'one-shot', 'write_note', finish.promise)
      await writeFile(artifact, 'written', { flag: 'wx' })
      await f.child.append([
        f.child.ev('x/agnes/tools-core/file-change', { path: 'answer.txt' }, { ignorable: true }),
      ])
      return { content: [{ type: 'text', text: 'written' }] }
    }),
    { source: 'test', trust: 'builtin' },
  )
  await f.child.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'write once' }] })
  const turn = runChildTurn(f.child, { until: 'turn-end', signal: new AbortController().signal })
  await Promise.race([
    entered.promise,
    turn.then((r) => {
      throw new Error(`turn ended before dispatch: ${JSON.stringify(r)}`)
    }),
  ])
  expect(await f.controls.pauseChild(key)).toMatchObject({ status: 'running', pausePending: true })
  finish.resolve()
  await vi.waitFor(async () => expect((await f.read()).state).toBe('paused'))
  const [row] = await f.child.scan({ type: 'x/core/child-checkpoint', limit: 1 })
  expect(row?.data).toMatchObject({
    completedEffectIds: expect.arrayContaining([expect.any(String)]),
    artifactPaths: ['answer.txt'],
  })
  const [intent] = await f.child.scan({ type: 'effect/intent', order: 'desc', limit: 1 })
  const effect = intent?.data as { effectId: string }
  await f.controls.resumeChild(key)
  await expect(
    dispatchChildEffect(
      f.child,
      { toolUseId: 'duplicate', name: 'write_note' },
      effect.effectId,
      { replay: 'never', isReadOnly: false, isDestructive: true },
      () => writeFile(artifact, 'duplicate'),
    ),
  ).rejects.toMatchObject({ code: 'E_RELATION' })
  expect((await turn).reason).toBe('completed')
  const rowAfter = await f.read()
  await f.storage.casState(key, rowAfter.stateRevision, 'idle')
  await f.controls.pauseChild(key)
  expect(await f.controls.closeChild(key)).toMatchObject({ status: 'completed' })
  expect(await readFile(artifact, 'utf8')).toBe('written')
  const results = await f.storage.scan(key, { type: 'tool/result', limit: 10 })
  expect(results).toHaveLength(1)
  expect(f.local.size).toBe(0)
})

it('restores the checkpoint tool filter and refuses cold activation under a changed authority', async () => {
  const f = await fixture()
  f.child.toolFilter = { allow: ['read'], deny: ['shell'] }
  await f.controls.pauseChild(key)
  await f.child.close()
  f.local.clear()
  const record = await f.read()
  const checkpoint = await readChildCheckpoint(f.parent, record)
  expect(checkpointOpenOptions(f.parent, record, checkpoint)).toMatchObject({
    cwd: '/w',
    recovering: true,
    toolFilter: { allow: ['read'], deny: ['shell'] },
  })
  const restricted = (
    await openSession({
      key: 'restricted',
      provider: f.provider,
      preset: { ...f.parent.preset, permission: 'read-only' },
    })
  ).session
  sessions.add(restricted)
  expect(() => checkpointOpenOptions(restricted, record, checkpoint)).toThrow('pinned checkpoint authority')
})

it('cancels a waiting checkpoint before detach and keeps the live driver', async () => {
  const f = await fixture('running')
  const entered = gate(),
    finish = gate()
  f.child.d.registry.add(
    writeTool(async () => {
      entered.resolve()
      await finish.promise
      return { content: [{ type: 'text', text: 'ok' }] }
    }),
    { source: 'test', trust: 'builtin' },
  )
  await f.child.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'work' }] })
  const turn = runChildTurn(f.child, { until: 'turn-end', signal: new AbortController().signal })
  await entered.promise
  const pause = f.controls.pauseChild(key)
  const resume = f.controls.resumeChild(key)
  expect(await pause).toMatchObject({ executionState: 'running' })
  expect(await resume).toMatchObject({ executionState: 'running' })
  finish.resolve()
  expect((await turn).reason).toBe('completed')
  expect(await f.child.scan({ type: 'x/core/child-checkpoint', limit: 1 })).toEqual([])
})

it('refuses to checkpoint a deferred child without a trusted binding', async () => {
  const f = await fixture('idle')
  const deferred = await f.storage.createDelegatedChild({
    ...f.input,
    childKey: 'unopened',
    creationId: 'unopened',
    workspaceId: 'unopened-ws',
  })
  if (deferred.status !== 'created') throw new Error('deferred child creation failed')
  const row = deferred.record
  await f.storage.deferCreatingChild({
    childKey: row.childKey,
    creationId: row.creationId,
    attemptId: row.attemptId,
    expectedRevision: row.creationRevision,
    deferredAt: f.parent.d.clock(),
  })
  await expect(f.controls.pauseChild(row.childKey)).rejects.toMatchObject({ code: 'E_RELATION' })
  expect(await f.storage.scan(row.childKey, { type: 'x/core/child-checkpoint', limit: 1 })).toEqual([])
  expect(await f.controls.closeChild(row.childKey)).toMatchObject({ status: 'cancelled' })
  expect(await f.storage.scan(row.childKey, { type: 'turn/start', limit: 1 })).toEqual([])
})

it('does not mark an incomplete paused turn with draft artifacts as completed on close (#07)', async ({
  onTestFinished,
}) => {
  const dir = await mkdtemp(join(tmpdir(), 'child-close-draft-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const draft = join(dir, 'draft.txt')
  await writeFile(draft, 'work in progress')
  const f = await fixture('waiting_approval')
  // Real historical completed turn followed by a newer open turn that wrote a draft and waited for approval.
  await f.child.append([
    f.child.ev('turn/start', { turn: 1, trigger: 'prompt' }),
    f.child.ev('turn/end', { reason: 'completed', lastAssistantSeq: null }),
  ])
  await f.child.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'write draft' }] })
  await f.child.acceptInput()
  await f.child.append([f.child.ev('x/agnes/tools-core/file-change', { path: draft }, { ignorable: true })])
  await pendingDecision(f.child)
  await f.controls.pauseChild(key)
  const cp = await readChildCheckpoint(f.parent, await f.read())
  expect(cp.artifactPaths).toContain(draft)

  const closed = await f.controls.closeChild(key)
  expect(closed).toMatchObject({ status: 'cancelled', executionState: 'cancelled' })
  expect((await f.read()).state).toBe('cancelled')
  // Draft file remains preserved on disk and recap reports cancelled (not completed).
  expect(await readFile(draft, 'utf8')).toBe('work in progress')
  const recap = await buildChildRecap(f.parent)
  expect(recap.snapshot.counts.completed).toBe(0)
  expect(recap.snapshot.counts.cancelled).toBe(1)
  expect(recap.snapshot.subtasks.find((s) => s.taskId === key)?.status).toBe('cancelled')
})

it('resumes a paused-from-idle child without pending work even when fan-out is full, but enforces quota when inbox has pending work (#19)', async () => {
  // Case 1: no pending work — resumes paused -> idle directly while sibling holds maxFanOut=1 slot.
  const f = await fixture('idle')
  await f.controls.pauseChild(key)
  expect(
    (
      await f.storage.createDelegatedChild({
        ...f.input,
        childKey: 'sibling-busy',
        creationId: 'sibling-busy',
        workspaceId: 'ws-busy',
      })
    ).status,
  ).toBe('created')
  expect(await f.controls.resumeChild(key)).toMatchObject({
    previousStatus: 'paused',
    status: 'idle',
    executionState: 'idle',
  })
  expect((await f.read()).state).toBe('idle')
  // Waking the idle child to execute still enforces fan-out limit.
  await expect(
    f.storage.casState(key, (await f.read()).stateRevision, 'ready', { maxFanOut: 1 }),
  ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })

  // Case 2: queued inbox message — must require fan-out quota and refuse when full.
  await f.controls.pauseChild(key)
  await f.child.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'pending follow-up' }] })
  await expect(f.controls.resumeChild(key)).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
  expect((await f.read()).state).toBe('paused')
})

it('records waiting-safepoint control fact instead of premature applied for deferred pause, then final applied/uncertain (#20)', async () => {
  const storage = new MemoryStorage()
  const provider = fakeProvider([textTurn('ok'), textTurn('ok2')])
  const k = Kernel.create({
    loops: defaultLoops(),
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 4 },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    timers: noTimers,
    clock: () => 1_757_203_200_000,
  })
  try {
    const parent = await k.session('pause-facts-parent', {
      actor,
      resolvedProfileHash: 'h1',
      cwd: '/w',
      writerRunId: 'r1',
    })
    const childHandle = await parent.d.children.create({
      parent: parent.key,
      cwd: '/w',
      input: 'non-interruptible work',
      resident: true,
    })
    const childSession = k.get(childHandle.key)!
    const row = (await storage.lookupByKey(childHandle.key))!
    await storage.casState(childHandle.key, row.stateRevision, 'running')

    // Case A: delayed tool return -> queued (WAITING_SAFEPOINT), then applied once drained.
    const tool1 = gate()
    trackChildDispatch(childSession, 'eff-1', 'write_note', tool1.promise)
    await applyChildControl(parent, childHandle.key, 'pause', actor, 'adm-pause-ok')
    const beforeDrain = (await parent.controls.state()).facts.filter(
      (f) => (f.details as { admissionId?: string }).admissionId === 'adm-pause-ok',
    )
    expect(beforeDrain.map((f) => f.outcome)).toEqual(['requested', 'queued'])
    expect(beforeDrain[1]?.details).toMatchObject({ pausePending: true, reason: 'WAITING_SAFEPOINT' })
    tool1.resolve()
    await vi.waitFor(async () => {
      const after = (await parent.controls.state()).facts.filter(
        (f) => (f.details as { admissionId?: string }).admissionId === 'adm-pause-ok',
      )
      expect(after.map((f) => f.outcome)).toEqual(['requested', 'queued', 'applied'])
    })
    expect((await storage.lookupByKey(childHandle.key))?.state).toBe('paused')

    // Case B: checkpoint write fails after drain -> final outcome is uncertain (never applied), child stays non-paused.
    const childHandle2 = await parent.d.children.create({
      parent: parent.key,
      cwd: '/w',
      input: 'non-interruptible work 2',
      resident: true,
    })
    const childSession2 = k.get(childHandle2.key)!
    const row2 = (await storage.lookupByKey(childHandle2.key))!
    await storage.casState(childHandle2.key, row2.stateRevision, 'running')
    const tool2 = gate()
    trackChildDispatch(childSession2, 'eff-2', 'write_note', tool2.promise)
    const origAppend = childSession2.d.log.append.bind(childSession2.d.log)
    vi.spyOn(childSession2.d.log, 'append').mockImplementation(async (rows, opts) => {
      if (rows.some((e) => e.type === 'x/core/child-checkpoint')) throw new Error('disk full')
      return origAppend(rows, opts)
    })
    await applyChildControl(parent, childHandle2.key, 'pause', actor, 'adm-pause-fail')
    const pendingFail = (await parent.controls.state()).facts.filter(
      (f) => (f.details as { admissionId?: string }).admissionId === 'adm-pause-fail',
    )
    expect(pendingFail.map((f) => f.outcome)).toEqual(['requested', 'queued'])
    tool2.resolve()
    await vi.waitFor(async () => {
      const afterFail = (await parent.controls.state()).facts.filter(
        (f) => (f.details as { admissionId?: string }).admissionId === 'adm-pause-fail',
      )
      expect(afterFail.map((f) => f.outcome)).toEqual(['requested', 'queued', 'uncertain'])
    })
    expect((await storage.lookupByKey(childHandle2.key))?.state).toBe('running')

    // Case C (P1-B race): delayed parent append while checkpoint fails & removes park -> NEVER emits applied.
    const childHandle3 = await parent.d.children.create({
      parent: parent.key,
      cwd: '/w',
      input: 'delayed parent append fail',
      resident: true,
    })
    const childSession3 = k.get(childHandle3.key)!
    const row3 = (await storage.lookupByKey(childHandle3.key))!
    await storage.casState(childHandle3.key, row3.stateRevision, 'running')
    const tool3 = gate()
    trackChildDispatch(childSession3, 'eff-3', 'write_note', tool3.promise)
    const cpFailed = gate()
    const origChild3Append = childSession3.d.log.append.bind(childSession3.d.log)
    vi.spyOn(childSession3.d.log, 'append').mockImplementation(async (rows, opts) => {
      if (rows.some((e) => e.type === 'x/core/child-checkpoint')) {
        cpFailed.resolve()
        throw new Error('disk full during delayed parent append')
      }
      return origChild3Append(rows, opts)
    })
    const parentResultEntered = gate()
    const releaseParentResult = gate()
    const origParentAppend = parent.d.log.append.bind(parent.d.log)
    vi.spyOn(parent.d.log, 'append').mockImplementation(async (rows, opts) => {
      if (
        rows.some(
          (e) =>
            e.type === 'x/core/child-control-result' &&
            (e.data as { admissionId?: string }).admissionId === 'adm-pause-race-fail' &&
            (e.data as { pausePending?: boolean }).pausePending === true,
        )
      ) {
        parentResultEntered.resolve()
        await releaseParentResult.promise
      }
      return origParentAppend(rows, opts)
    })
    const raceCall = applyChildControl(parent, childHandle3.key, 'pause', actor, 'adm-pause-race-fail')
    await parentResultEntered.promise
    // Complete tool & fail checkpoint BEFORE the parent's initial child-control-result append resolves!
    tool3.resolve()
    await cpFailed.promise
    await new Promise((r) => setTimeout(r, 10))
    releaseParentResult.resolve()
    await raceCall
    await vi.waitFor(async () => {
      const facts = (await parent.controls.state()).facts.filter(
        (f) => (f.details as { admissionId?: string }).admissionId === 'adm-pause-race-fail',
      )
      expect(facts.map((f) => f.outcome)).toEqual(['requested', 'queued', 'uncertain'])
    })
    expect((await storage.lookupByKey(childHandle3.key))?.state).toBe('running')
    expect(await storage.scan(childHandle3.key, { type: 'x/core/child-checkpoint', limit: 1 })).toEqual([])

    // Case D (P1-B success under delayed parent append + close/reopen reconciliation): exactly one applied.
    const childHandle4 = await parent.d.children.create({
      parent: parent.key,
      cwd: '/w',
      input: 'delayed parent append ok',
      resident: true,
    })
    const childSession4 = k.get(childHandle4.key)!
    const row4 = (await storage.lookupByKey(childHandle4.key))!
    await storage.casState(childHandle4.key, row4.stateRevision, 'running')
    const tool4 = gate()
    trackChildDispatch(childSession4, 'eff-4', 'write_note', tool4.promise)
    const parentResult4Entered = gate()
    const releaseParentResult4 = gate()
    vi.spyOn(parent.d.log, 'append').mockImplementation(async (rows, opts) => {
      if (
        rows.some(
          (e) =>
            e.type === 'x/core/child-control-result' &&
            (e.data as { admissionId?: string }).admissionId === 'adm-pause-race-ok' &&
            (e.data as { pausePending?: boolean }).pausePending === true,
        )
      ) {
        parentResult4Entered.resolve()
        await releaseParentResult4.promise
      }
      return origParentAppend(rows, opts)
    })
    const raceOkCall = applyChildControl(parent, childHandle4.key, 'pause', actor, 'adm-pause-race-ok')
    await parentResult4Entered.promise
    tool4.resolve()
    await vi.waitFor(async () => expect((await storage.lookupByKey(childHandle4.key))?.state).toBe('paused'))
    releaseParentResult4.resolve()
    await raceOkCall
    await vi.waitFor(async () => {
      const facts = (await parent.controls.state()).facts.filter(
        (f) => (f.details as { admissionId?: string }).admissionId === 'adm-pause-race-ok',
      )
      expect(facts.map((f) => f.outcome)).toEqual(['requested', 'queued', 'applied'])
    })
    await k.close()

    const k2 = Kernel.create({
      loops: defaultLoops(),
      storage,
      seams: fakeSeams(),
      provider,
      contract: { contract_id: null, parser_version: '1' },
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 4 },
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      timers: noTimers,
      clock: () => 1_757_203_200_000,
    })
    try {
      const reopened = await k2.session('pause-facts-parent', {
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r2',
      })
      const factsFail = (await reopened.controls.state()).facts.filter(
        (f) => (f.details as { admissionId?: string }).admissionId === 'adm-pause-race-fail',
      )
      expect(factsFail.map((f) => f.outcome)).toEqual(['requested', 'queued', 'uncertain'])
      const factsOk = (await reopened.controls.state()).facts.filter(
        (f) => (f.details as { admissionId?: string }).admissionId === 'adm-pause-race-ok',
      )
      expect(factsOk.map((f) => f.outcome)).toEqual(['requested', 'queued', 'applied'])
      expect((await storage.lookupByKey(childHandle4.key))?.state).toBe('paused')
    } finally {
      await k2.close()
    }

    // Case E (P2-B): orderly parent close right after queued pause reconciles to terminal fact on reopen.
    const k3 = Kernel.create({
      loops: defaultLoops(),
      storage: new MemoryStorage(),
      seams: fakeSeams(),
      provider: fakeProvider([textTurn('ok')]),
      contract: { contract_id: null, parser_version: '1' },
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 4 },
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      timers: noTimers,
      clock: () => 1_757_203_200_000,
    })
    const closeStorage = k3.o.storage as MemoryStorage
    try {
      const parentClose = await k3.session('pause-close-reconcile', {
        actor,
        resolvedProfileHash: 'h1',
        cwd: '/w',
        writerRunId: 'r1',
      })
      const childClose = await parentClose.d.children.create({
        parent: parentClose.key,
        cwd: '/w',
        input: 'pause then close before safepoint',
        resident: true,
      })
      const childCloseSession = k3.get(childClose.key)!
      const closeRow = (await closeStorage.lookupByKey(childClose.key))!
      await closeStorage.casState(childClose.key, closeRow.stateRevision, 'running')
      const toolClose = gate()
      trackChildDispatch(childCloseSession, 'eff-close', 'write_note', toolClose.promise)
      await applyChildControl(parentClose, childClose.key, 'pause', actor, 'adm-pause-close')
      const queuedFacts = (await parentClose.controls.state()).facts.filter(
        (f) => (f.details as { admissionId?: string }).admissionId === 'adm-pause-close',
      )
      expect(queuedFacts.map((f) => f.outcome)).toEqual(['requested', 'queued'])
      const closing = parentClose.close()
      toolClose.resolve()
      await closing
      await k3.close()

      const k4 = Kernel.create({ ...k3.o, storage: closeStorage })
      try {
        const reopenedClose = await k4.session('pause-close-reconcile', {
          actor,
          resolvedProfileHash: 'h1',
          cwd: '/w',
          writerRunId: 'r2',
        })
        await reopenedClose.d.children.recover?.()
        await reopenedClose.d.children.recover?.()
        expect((await closeStorage.lookupByKey(childClose.key))?.state).toBe('cancelled')
        const reconciledFacts = (await reopenedClose.controls.state()).facts.filter(
          (f) => (f.details as { admissionId?: string }).admissionId === 'adm-pause-close',
        )
        expect(reconciledFacts.map((f) => f.outcome)).toEqual(['requested', 'queued', 'withdrawn'])
        expect(reconciledFacts[2]?.details).toMatchObject({
          admissionId: 'adm-pause-close',
          childId: childClose.key,
          executionState: 'cancelled',
        })
      } finally {
        await k4.close()
      }
    } finally {
      await k3.close()
    }
  } finally {
    await k.close()
  }
})

it('preserves underscores, hashes, C# and surrogate pairs while stripping paired Markdown in child labels (#31)', async () => {
  expect(cleanChildLabel('web_search')).toBe('web_search')
  expect(cleanChildLabel('lane_1.txt')).toBe('lane_1.txt')
  expect(cleanChildLabel('订单对账_g #42')).toBe('订单对账_g #42')
  expect(cleanChildLabel('Fix C# parser for #42')).toBe('Fix C# parser for #42')
  expect(cleanChildLabel('## Review **web_search** in `lane_1.txt` and __bold__ _em_')).toBe(
    'Review web_search in lane_1.txt and bold em',
  )
  const emojiInput = `${'a'.repeat(79)}😀tail`
  const clipped = cleanChildLabel(emojiInput)
  expect(clipped.length).toBeLessThanOrEqual(80)
  // Must never leave an unpaired high surrogate at the end.
  expect(clipped.charCodeAt(clipped.length - 1)).not.toBeGreaterThanOrEqual(0xd800)

  const f = await fixture('idle')
  const state = await humanChildState(
    f.parent,
    { ...(await f.read()), inputText: '## 订单对账_g #42 (`web_search` / C#)' },
    f.child,
    true,
  )
  expect(state.label).toBe('订单对账_g #42 (web_search / C#)')
})
