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
import {
  checkpointOpenOptions,
  humanChildState,
  readChildCheckpoint,
  snapshotFromLedger,
  snapshotFromLive,
  snapshotFromRecord,
} from '../src/child/status.js'
import type { SessionImpl } from '../src/step/session.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession, writeTool } from './helpers/open-session.js'

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
  const f = await fixture('idle', 'worktree', false)
  await f.controls.pauseChild(key)
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

it('checkpoints a deferred child before any child session has been opened', async () => {
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
  expect(await f.controls.pauseChild(row.childKey)).toMatchObject({
    previousStatus: 'starting',
    status: 'paused',
  })
  expect(await f.controls.closeChild(row.childKey)).toMatchObject({
    previousStatus: 'paused',
    status: 'cancelled',
  })
  expect(await f.storage.scan(row.childKey, { type: 'turn/start', limit: 1 })).toEqual([])
})
