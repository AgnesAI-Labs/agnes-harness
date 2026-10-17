import {
  createWorkspaceInvocationPort,
  type Event,
  Kernel,
  LoopRegistry,
  noopHooks,
  presetDefaults,
  type SessionImpl,
  scanAll,
} from '@agnes/core'
import {
  actor,
  fakeProvider,
  fakeSeams,
  fencedFs,
  MemoryStorage,
  readTool,
  type Script,
  testFsPolicy,
  textTurn,
  toolTurn,
} from '@agnes/core/testkit'
import type { LoopSideCallPort } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { createJevLoopFactory } from '../src/index.js'
import { type FakeJev, fakeJev, PICK_READ, PICK_RESPOND, PICK_WRITE, withJev } from './helpers/fake-jev.js'

// The kernel fixture lives in this test file: the repository allows `Kernel.create` only in test
// files, the host assembly and the author contract testkit.
type JevKernelOptions = {
  scripts: Script[]
  jev: LoopSideCallPort
  storage?: MemoryStorage
  seams?: Parameters<typeof fakeSeams>[0]
  tools?: unknown[]
  config?: object
}

/** A test `write` tool that never asks for approval and writes nothing. */
const writeTool = () => ({
  name: 'write',
  description: 'write',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  meta: {
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    isOpenWorld: false,
    replay: 'never' as const,
    costHint: undefined,
    deferLoading: undefined,
    requiresApproval: 'never' as const,
  },
  execute: async () => ({ content: [{ type: 'text' as const, text: 'written' }] }),
})

/**
 * A real Core kernel that runs `agnes.jev` with `jev` behind its side-call port, scripted model
 * turns, an in-memory ledger and a fenced file system that stores nothing. It keeps Core's default
 * timers, so a loop that waits does wait.
 */
function jevKernel(o: JevKernelOptions) {
  const provider = fakeProvider(o.scripts)
  const storage = o.storage ?? new MemoryStorage()
  const seams = fakeSeams(o.seams)
  const fs = fencedFs(
    {
      read: async () => new Uint8Array(),
      write: async () => undefined,
      list: async () => [],
      stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0 }),
    },
    testFsPolicy('/w'),
  )
  const workspaceInvocation = createWorkspaceInvocationPort(() => ({
    source: {
      root: '/w',
      fs,
      ready: async () => ({ confine: async (argv) => [...argv] }),
      hookSnapshot: async () => ({ workspaceDigest: 'jev', policyRevision: 'jev', hooks: [] }),
      hookSandbox: seams.sandbox,
      approval: seams.approval,
      checkpoint: seams.checkpoint,
    },
    release() {},
  }))
  const loop = withJev(createJevLoopFactory(o.config), o.jev)
  const loops = new LoopRegistry()
  loops.register('@agnes/loop-jev', loop)
  const preset = presetDefaults()
  preset.model.retry.maxAttempts = 1
  const kernel = Kernel.create({
    loops,
    storage,
    provider,
    seams,
    preset,
    fsOps: fs,
    contract: { contract_id: null, parser_version: '1' },
    netFetch: async () => new Response(''),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  for (const tool of o.tools ?? [readTool(), writeTool()])
    kernel.tools.add(tool as never, { source: 'test', trust: 'builtin' })
  /** Opens the session the way a host does: whatever a dead process left in flight is settled first. */
  const open = async (key: string): Promise<SessionImpl> => {
    const session = await kernel.session(key, {
      actor,
      cwd: '/w',
      resolvedProfileHash: null,
      writerRunId: `jev:${key}`,
      workspaceInvocation,
      loop,
    })
    await session.resume()
    return session
  }
  /** Queues `text` as the next turn and runs until a turn ends. */
  const run = async (session: SessionImpl, text = 'Run the Jev task') => {
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text }] })
    return session.run({ until: 'turn-end', signal: new AbortController().signal })
  }
  const rows = async (session: SessionImpl): Promise<Event[]> => {
    const [head] = await session.scan({ order: 'desc', limit: 1 })
    return scanAll((query) => session.scan(query), { toSeq: head?.seq ?? 0 })
  }
  return { kernel, provider, storage, open, run, rows }
}

const isFake = (jev: LoopSideCallPort): jev is FakeJev => 'records' in jev && 'invoked' in jev

/**
 * Runs one turn to the end and returns the ledger as it stood right after the first commit whose
 * event types `cut` matches, as a restarted process would find it. A scripted Jev keeps counting
 * its calls across the restart, but forgets the records of the calls it answered after the cut:
 * those were never written to the ledger the restarted process reads.
 */
async function cutAt(
  o: JevKernelOptions,
  key: string,
  cut: (types: string[]) => boolean,
): Promise<MemoryStorage> {
  const kit = jevKernel(o)
  const commit = kit.storage.commit.bind(kit.storage)
  let snapshot: Event[] | undefined
  let opCells: Awaited<ReturnType<MemoryStorage['registers']>> = []
  let sentAtCut = 0
  vi.spyOn(kit.storage, 'commit').mockImplementation(async (k, tx) => {
    const receipt = await commit(k, tx)
    if (!snapshot && cut(tx.events.map((row) => row.type))) {
      const [head] = await kit.storage.scan(k, { order: 'desc', limit: 1 })
      snapshot = await scanAll((query) => kit.storage.scan(k, query), { toSeq: head?.seq ?? 0 })
      opCells = (await kit.storage.registers(k)).filter((row) => row.register === 'op.state')
      if (isFake(o.jev)) sentAtCut = o.jev.invoked.length
    }
    return receipt
  })
  try {
    const session = await kit.open(key)
    const outcome = await kit.run(session)
    if (outcome.reason !== 'completed') throw new Error(`the turn before the cut ended ${outcome.reason}`)
  } finally {
    await kit.kernel.close()
  }
  if (!snapshot) throw new Error('no commit matched the cut')
  if (isFake(o.jev)) for (const id of o.jev.invoked.slice(sentAtCut)) o.jev.records.delete(id)
  return MemoryStorage.fromEvents(key, snapshot, { opCells })
}

const userTexts = (rows: Awaited<ReturnType<ReturnType<typeof jevKernel>['rows']>>) =>
  rows.filter((r) => r.type === 'user/message').map((r) => JSON.stringify(r.data))

describe('agnes.jev on a real Core session', () => {
  it('takes another step when the stop gate holds the completion', async () => {
    const kit = jevKernel({
      scripts: [textTurn('first'), textTurn('second')],
      jev: fakeJev(() => ({ pick: PICK_RESPOND })),
    })
    const session = await kit.open('gate')
    let asked = 0
    session.hooks = {
      ...noopHooks,
      turnStopping: async () =>
        ++asked === 1 ? { action: 'continue', note: 'cite the source first' } : { action: 'stop' },
    }
    try {
      expect((await kit.run(session)).reason).toBe('completed')
      expect(kit.provider.requests).toHaveLength(2)
      expect(JSON.stringify(kit.provider.requests[1]?.messages)).toContain('cite the source first')
      const rows = await kit.rows(session)
      expect(rows.filter((r) => r.type === 'turn/end')).toHaveLength(1)
      expect(
        rows.some((r) => r.type.endsWith('/jev.step') && JSON.stringify(r.data).includes('STOP_GATE_HELD')),
      ).toBe(true)
    } finally {
      await kit.kernel.close()
    }
  })

  it('stops its own work when the stop gate parks', async () => {
    const kit = jevKernel({
      scripts: [textTurn('answer')],
      jev: fakeJev(() => ({ pick: PICK_RESPOND })),
      seams: {
        verifier: {
          verify: async (scope: string) =>
            scope === 'turn'
              ? { verdict: 'fail', reasons: ['no evidence'] }
              : { verdict: 'pass', reasons: [] },
        },
        repair: { decide: async () => 'park' },
        approval: {
          ask: async () => ({ ticket: 'review', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
        },
      } as never,
    })
    const session = await kit.open('gate-park')
    try {
      expect((await kit.run(session)).reason).toBe('parked')
      const checkpoints = (await kit.rows(session)).filter((r) => r.type === 'x/core/loop-checkpoint')
      expect(JSON.stringify(checkpoints.at(-1)?.data)).toContain('"stage":"finish"')
      expect(kit.provider.calls).toBe(1)
    } finally {
      await kit.kernel.close()
    }
  })

  it('shows Core’s refusal of announced arguments in the next note and writes no call', async () => {
    const kit = jevKernel({
      scripts: [toolTurn('write', { path: 1 }), textTurn('ok')],
      jev: fakeJev((n) => (n === 0 ? { pick: PICK_WRITE } : { pick: PICK_RESPOND })),
    })
    const session = await kit.open('refused')
    try {
      expect((await kit.run(session)).reason).toBe('completed')
      const rows = await kit.rows(session)
      expect(rows.filter((r) => r.type === 'tool/call')).toHaveLength(0)
      expect(
        userTexts(rows).some((t) =>
          t.includes(
            '[runtime observation] write was not applied: REFUSED_BY_CORE (dispatch); reason (data):',
          ),
        ),
      ).toBe(true)
    } finally {
      await kit.kernel.close()
    }
  })

  it('does not publish a refused reply and prepares the next request normally', async () => {
    const kit = jevKernel({
      scripts: [textTurn('I would write it.'), textTurn('ok')],
      jev: fakeJev((n) => (n === 0 ? { pick: PICK_WRITE } : { pick: PICK_RESPOND })),
    })
    const session = await kit.open('unpublished')
    try {
      expect((await kit.run(session)).reason).toBe('completed')
      const messages = (await kit.rows(session))
        .filter((r) => r.type === 'assistant/message')
        .map((r) => JSON.stringify(r.data))
      expect(messages.some((m) => m.includes('I would write it.'))).toBe(false)
      expect(messages.some((m) => m.includes('"ok"'))).toBe(true)
    } finally {
      await kit.kernel.close()
    }
  })

  it('keeps every request a prefix of the next with the same tool bytes', async () => {
    const kit = jevKernel({
      scripts: [toolTurn('read', {}), toolTurn('read', {}), textTurn('done')],
      jev: fakeJev((n) => (n < 2 ? { pick: PICK_READ } : { pick: PICK_RESPOND })),
    })
    const session = await kit.open('prefix')
    try {
      expect((await kit.run(session)).reason).toBe('completed')
      const reqs = kit.provider.requests
      expect(reqs).toHaveLength(3)
      for (let i = 1; i < reqs.length; i++) {
        expect(reqs[i]?.messages.slice(0, reqs[i - 1]?.messages.length)).toEqual(reqs[i - 1]?.messages)
        expect(reqs[i]?.tools).toEqual(reqs[0]?.tools)
      }
    } finally {
      await kit.kernel.close()
    }
  })

  it('does not resend a model request that may have been sent before a crash', async () => {
    const jev = fakeJev((n) => (n === 0 ? { pick: PICK_WRITE } : { pick: PICK_RESPOND }))
    const storage = await cutAt(
      { scripts: [toolTurn('write', { path: 'a', content: 'x' }), textTurn('ok')], jev },
      'crash-llm',
      (types) => types.includes('request/header'),
    )
    const kit = jevKernel({ scripts: [textTurn('after restart')], jev, storage })
    const session = await kit.open('crash-llm')
    try {
      expect((await kit.run(session)).reason).toBe('completed')
      expect(kit.provider.calls).toBe(1)
      const steps = (await kit.rows(session))
        .filter((r) => r.type.endsWith('/jev.step'))
        .map((r) => JSON.stringify(r.data))
      expect(steps.some((s) => s.includes('LLM_OUTCOME_UNKNOWN'))).toBe(true)
    } finally {
      await kit.kernel.close()
    }
  })

  it('runs a planned but undispatched call exactly once after a crash', async () => {
    const jev = fakeJev((n) => (n === 0 ? { pick: PICK_READ } : { pick: PICK_RESPOND }))
    const storage = await cutAt(
      { scripts: [toolTurn('read', {}), textTurn('ok')], jev },
      'crash-dispatch',
      (types) => types.includes('tool/call'),
    )
    let reads = 0
    const kit = jevKernel({
      scripts: [textTurn('ok')],
      jev,
      storage,
      // The same definitions as before the crash; this read counts its runs.
      tools: [
        readTool(async () => {
          reads++
          return { content: [{ type: 'text', text: 'read once' }] }
        }),
        writeTool(),
      ],
    })
    const session = await kit.open('crash-dispatch')
    try {
      expect((await kit.run(session)).reason).toBe('completed')
      expect(reads).toBe(1)
      expect((await kit.rows(session)).filter((r) => r.type === 'tool/call')).toHaveLength(1)
    } finally {
      await kit.kernel.close()
    }
  })
})
