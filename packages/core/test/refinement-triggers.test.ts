import { presetDefaults } from '@agnes/core-common/step/preset'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { HookPayloadMap, ToolResult } from '@agnes/extension-api'
import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { RoleDelegation } from '../src/child/roles.js'
import { Kernel } from '../src/kernel.js'
import { normalizeCommandError, normalizeToolError } from '../src/refinement/normalize-error.js'
import {
  MAX_FAILURE_TALLIES,
  onCompactionCommitted,
  onToolSettled,
  type RefinementCandidate,
  type RefinementTriggerSink,
} from '../src/refinement/triggers.js'
import type { RefinementTrigger } from '../src/refinement/types.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { CompactionRunner } from '../src/step/compaction.js'
import type { SessionImpl } from '../src/step/session.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, type Script, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, openSession, readTool, testFsOps } from './helpers/open-session.js'

const signal = () => new AbortController().signal
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

function sink(accepts: boolean | ((key: string) => boolean) = true) {
  const offered: RefinementTrigger[] = []
  const candidates: RefinementCandidate[] = []
  const asked: string[] = []
  const port: RefinementTriggerSink = {
    offer: (candidate) => {
      candidates.push(candidate)
      offered.push(candidate.trigger)
    },
    accepts: (key) => {
      asked.push(key)
      return typeof accepts === 'function' ? accepts(key) : accepts
    },
  }
  return { offered, candidates, asked, port }
}

function model(id: string, slot: ModelRecord['slot'], contextWindow: number): ModelRecord {
  return {
    id,
    name: id,
    api: 'openai-completions',
    route: 'default',
    baseUrl: 'https://example.invalid/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 4096,
    toolCallFormats: ['native'],
    thinkingReplay: 'native',
    contract_id: null,
    ...(slot ? { slot } : {}),
  }
}

function plan(payload: HookPayloadMap['before_compact']) {
  const surface = payload.getSurface()
  const first = surface[0]
  const penultimate = surface.at(-2)
  const last = surface.at(-1)
  if (!first || !penultimate || !last) throw new Error('fixture needs a compactable surface')
  return {
    keepFromSeq: last.seq,
    summarizeRange: [first.seq, penultimate.seq] as [number, number],
    prompts: { system: 'summarize safely', history: 'ledger history for it' },
    maxTokens: 77,
    details: { readFiles: [], modifiedFiles: [] },
  }
}

const capped: Script = [
  { type: 'thinking_delta', delta: 'deliberating about what to keep' },
  {
    type: 'usage',
    tokens: { input: 500, output: 2048, cacheRead: 0, cacheWrite: 0, reasoning: 2048 },
    credits: 1,
    creditSource: 'estimated',
  },
  { type: 'done', reason: 'length' },
]

const errorTurn: Script = [
  { type: 'error', reason: 'error', code: 'TRANSPORT', message: 'summary unavailable', retryable: false },
]

async function compactable(
  over: { refinementEnabled?: () => boolean; refinementTriggers?: RefinementTriggerSink },
  summary: Script | Script[],
) {
  const summaries = Array.isArray(summary[0]) ? (summary as Script[]) : [summary as Script]
  const provider = fakeProvider([textTurn('old-one'), textTurn('old-two'), ...summaries, textTurn('final')])
  provider.models = () => [model('answer-model', 'primary', 100), model('summary-model', 'compaction', 1000)]
  const opened = await openSession({ provider, ...over })
  delete opened.session.preset.model.contextWindow
  opened.session.preset.model.id.compaction = 'summary-model'
  opened.session.preset.compaction.reserveTokens = 80
  for (const prompt of ['one {{HISTORY}}', 'two']) {
    await opened.session.enqueue('next-turn', { content: [{ type: 'text', text: prompt }], actor })
    expect((await opened.session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
  }
  opened.session.compaction = new CompactionRunner({
    plan: async (payload) => plan(payload),
    onCompact: async () => undefined,
  })
  return { ...opened, provider }
}

describe('compaction trigger', () => {
  it('only a successful summary compaction triggers once', async () => {
    const { offered, port } = sink()
    const { session, log } = await compactable(
      { refinementEnabled: () => true, refinementTriggers: port },
      textTurn('SUMMARY'),
    )
    await session.requestCompaction({ actor, admissionId: 'trigger-summary' })
    expect(await session.runCompaction()).toEqual({ phase: 'checkpoint' })
    const [replace] = (await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)
    expect(offered).toEqual([{ kind: 'compaction', seq: replace?.seq }])
  })

  it('a failed summary compaction does not trigger', async () => {
    const { offered, port } = sink()
    const { session, log } = await compactable(
      { refinementEnabled: () => true, refinementTriggers: port },
      errorTurn,
    )
    await session.requestCompaction({ actor, admissionId: 'trigger-failed' })
    await session.runCompaction()
    expect((await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)).toHaveLength(0)
    expect(offered).toEqual([])
  })

  it('an elided replacement does not trigger', async () => {
    const { offered, port } = sink()
    const { session, log } = await compactable(
      { refinementEnabled: () => true, refinementTriggers: port },
      textTurn('SUMMARY'),
    )
    session.compaction = new CompactionRunner({
      engine: {
        shouldCompact: () => false,
        async compact(input) {
          const nodes = input.conversation
          const range = [nodes[0]!.seq, nodes.at(-2)!.seq] as const
          return { kind: 'replacement', range, text: 'S', mode: 'elision' }
        },
      },
      onCompact: async () => undefined,
    })
    await session.requestCompaction({ actor, admissionId: 'trigger-elided' })
    expect(await session.runCompaction()).toEqual({ phase: 'checkpoint' })
    expect((await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)).toHaveLength(1)
    expect(offered).toEqual([])
  })

  it.each([
    ['off', undefined, true],
    ['explicitly off', () => false, true],
    ['manual', () => true, false],
  ])('nothing is triggered when refinement is %s', async (_name, enabled, accepts) => {
    const { offered, port } = sink(accepts)
    const { session } = await compactable(
      { ...(enabled ? { refinementEnabled: enabled } : {}), refinementTriggers: port },
      textTurn('SUMMARY'),
    )
    await session.requestCompaction({ actor, admissionId: 'trigger-gated' })
    expect(await session.runCompaction()).toEqual({ phase: 'checkpoint' })
    expect(offered).toEqual([])
  })

  it('a summary that is cut off and then retried successfully triggers once', async () => {
    const { offered, port } = sink()
    const { session, log, provider } = await compactable(
      { refinementEnabled: () => true, refinementTriggers: port },
      [capped, textTurn('SUMMARY')],
    )
    await session.requestCompaction({ actor, admissionId: 'trigger-retry' })
    expect(await session.runCompaction()).toEqual({ phase: 'checkpoint' })
    // Two summary calls (the cut-off one and its retry), one committed replacement, one offer.
    expect(provider.requests.filter((r) => r.kind !== 'inference')).toHaveLength(2)
    const replaced = (await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)
    expect(replaced).toHaveLength(1)
    expect(offered).toEqual([{ kind: 'compaction', seq: replaced[0]?.seq }])
  })

  it('the elided fallback of a summary request does not trigger', async () => {
    const { offered, port } = sink()
    const { session, log } = await compactable({ refinementEnabled: () => true, refinementTriggers: port }, [
      capped,
      capped,
    ])
    await session.requestCompaction({ actor, admissionId: 'trigger-elide-fallback' })
    expect(await session.runCompaction()).toEqual({ phase: 'checkpoint' })
    const begins = await log.scan({ type: 'x/core/compaction-begin', limit: 5 })
    expect(begins[0]?.data).toMatchObject({ mode: 'elided' })
    expect((await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)).toHaveLength(1)
    expect(offered).toEqual([])
  })

  it('the offer names the session and the lane, and `accepts` is asked about that session', async () => {
    const { candidates, asked, port } = sink()
    const { session, log } = await compactable(
      { refinementEnabled: () => true, refinementTriggers: port },
      textTurn('SUMMARY'),
    )
    await session.requestCompaction({ actor, admissionId: 'trigger-origin' })
    await session.runCompaction()
    const [replace] = (await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)
    expect(candidates).toEqual([
      { sessionKey: 'k', lane: 'main', trigger: { kind: 'compaction', seq: replace?.seq } },
    ])
    expect(asked).toEqual(['k'])
  })

  it('a throwing owner function never breaks the compaction', async () => {
    // The switch is armed after the setup turns: the request path reads it too, outside this hook.
    let armed = false
    const throwing: Array<{ refinementEnabled: () => boolean; refinementTriggers: RefinementTriggerSink }> = [
      {
        refinementEnabled: () => true,
        refinementTriggers: {
          offer: () => undefined,
          accepts: () => {
            if (armed) throw new Error('accepts down')
            return true
          },
        },
      },
      {
        refinementEnabled: () => {
          if (armed) throw new Error('switch down')
          return true
        },
        refinementTriggers: sink().port,
      },
      {
        refinementEnabled: () => true,
        refinementTriggers: {
          offer: () => {
            throw new Error('offer down')
          },
        },
      },
    ]
    for (const over of throwing) {
      armed = false
      const { session, log } = await compactable(over, textTurn('SUMMARY'))
      armed = true
      await session.requestCompaction({ actor, admissionId: 'trigger-throw' })
      expect(await session.runCompaction()).toEqual({ phase: 'checkpoint' })
      expect((await log.scan({ fromSeq: 1, limit: 500 })).filter((row) => row.surfaceOp)).toHaveLength(1)
    }
  })

  it('no sink means nothing happens', async () => {
    const { session } = await compactable({ refinementEnabled: () => true }, textTurn('SUMMARY'))
    await session.requestCompaction({ actor, admissionId: 'trigger-nosink' })
    expect(await session.runCompaction()).toEqual({ phase: 'checkpoint' })
  })
})

/**
 * A session whose model calls the `read` tool once per scripted outcome, then answers. A string is
 * an error with that text (`ok` is a success); an object is returned as the tool's result.
 */
async function failing(
  outcomes: Array<string | ToolResult>,
  over: { refinementEnabled?: () => boolean; refinementTriggers?: RefinementTriggerSink; tool?: string } = {},
) {
  const script = [...outcomes]
  const registry = new ToolRegistry()
  registry.add(
    readTool(async () => {
      const next = script.shift() ?? 'ok'
      if (typeof next !== 'string') return next
      return next === 'ok' ? text('ok') : { ...text(next), isError: true }
    }),
    { source: 'agnes/tools-core', trust: 'builtin' },
  )
  const provider = fakeProvider([...outcomes.map(() => toolTurn('read', {})), textTurn('done')])
  const { refinementEnabled, refinementTriggers } = over
  const opened = await openSession({
    provider,
    registry,
    ...(refinementEnabled ? { refinementEnabled } : {}),
    ...(refinementTriggers ? { refinementTriggers } : {}),
  })
  const turn = async (prompt: string) => {
    await opened.session.enqueue('next-turn', { content: [{ type: 'text', text: prompt }], actor })
    return opened.session.run({ until: 'turn-end', signal: signal() })
  }
  return { ...opened, turn }
}

const enabled = () => true

describe('repeated-failure trigger', () => {
  it('the offer names the session and the lane', async () => {
    const { candidates, port } = sink()
    const { turn } = await failing(['boom', 'boom', 'boom'], {
      refinementEnabled: enabled,
      refinementTriggers: port,
    })
    await turn('go')
    expect(candidates).toEqual([
      {
        sessionKey: 'k',
        lane: 'main',
        trigger: { kind: 'repeated-failure', seq: expect.any(Number), focus: 'read' },
      },
    ])
  })

  it('a throwing owner function does not break the step: results are returned and the turn completes', async () => {
    const cases: RefinementTriggerSink[] = [
      {
        offer: () => undefined,
        accepts: () => {
          throw new Error('accepts down')
        },
      },
      {
        offer: () => {
          throw new Error('offer down')
        },
      },
    ]
    for (const refinementTriggers of cases) {
      const { turn, log } = await failing(['boom', 'boom', 'boom', 'boom'], {
        refinementEnabled: enabled,
        refinementTriggers,
      })
      expect((await turn('go')).reason).toBe('completed')
      const results = await log.scan({ type: 'tool/result', limit: 50 })
      expect(results.filter((r) => (r.data as { isError?: boolean }).isError)).toHaveLength(4)
    }
  })

  it('two identical normalized failures in one session trigger once', async () => {
    const { offered, port } = sink()
    const { turn, log } = await failing(
      [
        'ENOENT: no such file /tmp/a1b2c3d4e5f6/x.txt',
        'ENOENT: no such file /tmp/ffeeddccbbaa/y.txt',
        'enoent: no such file /srv/app/z.txt',
        'ENOENT: no such file /q.txt',
        'done?',
      ],
      { refinementEnabled: enabled, refinementTriggers: port },
    )
    await turn('go')
    const results = (await log.scan({ type: 'tool/result', limit: 50 })).map((r) => r.seq)
    expect(offered).toHaveLength(1)
    expect(offered[0]?.kind).toBe('repeated-failure')
    // Anchored to the step that settled the second failing result, before the third call's result.
    expect(offered[0]?.seq).toBeGreaterThan(results[1] as number)
    expect(offered[0]?.seq).toBeLessThan(results[2] as number)
  })

  it('one failure does not trigger', async () => {
    const { offered, port } = sink()
    const { turn } = await failing(['boom 1', 'done'], {
      refinementEnabled: enabled,
      refinementTriggers: port,
    })
    await turn('go')
    expect(offered).toEqual([])
  })

  it('[stderr] labels do not make different errors equal', async () => {
    const { offered, port } = sink()
    const { turn } = await failing(
      [
        '[stderr]\nfirst problem',
        '[stderr]\nsecond problem',
        '[stderr]\nthird problem',
        '[stderr]\nfourth problem',
      ],
      { refinementEnabled: enabled, refinementTriggers: port },
    )
    await turn('go')
    expect(offered).toEqual([])
  })

  it('a failing shell command is counted by what it printed, not by its exit code', async () => {
    const { offered, port } = sink()
    const { turn, log } = await failing(
      [shellFailure('error: X'), shellFailure('error: Y'), shellFailure('error: X')],
      { refinementEnabled: enabled, refinementTriggers: port },
    )
    await turn('go')
    const results = (await log.scan({ type: 'tool/result', limit: 50 })).map((r) => r.seq)
    expect(offered).toEqual([{ kind: 'repeated-failure', seq: expect.any(Number), focus: 'read' }])
    // Offered at the second `error: X`, not at the second failing command.
    expect(offered[0]?.seq).toBeGreaterThan(results[2] as number)
  })

  it('nothing is triggered when refinement is off or manual', async () => {
    const same = ['boom', 'boom', 'boom', 'boom']
    const off = sink()
    await (await failing(same, { refinementTriggers: off.port })).turn('go')
    const manual = sink(false)
    await (await failing(same, { refinementEnabled: enabled, refinementTriggers: manual.port })).turn('go')
    expect(off.offered).toEqual([])
    expect(manual.offered).toEqual([])
  })
})

/** A stand-in session: only the three things the trigger reads. */
function fakeSession(port: RefinementTriggerSink, turn: object | null = {}) {
  return {
    key: 'k',
    lane: 'main',
    d: { log: {}, refinementEnabled: enabled, refinementTriggers: port },
    state: {},
    turn,
    lastSeq: 42,
  } as never
}
const failure = (t: string, details?: unknown) =>
  ({ ...text(t), isError: true, ...(details ? { details } : {}) }) as never
/** A result shaped like the shell tool's for a command that exited non-zero. */
function shellFailure(stderr: string, opts: { stdout?: string; exitCode?: number } = {}): ToolResult {
  const exitCode = opts.exitCode ?? 1
  const lines = [
    ...(opts.stdout ? [opts.stdout] : []),
    ...(stderr ? [`[stderr]\n${stderr}`] : []),
    'Command failed; inspect the output and current state, correct the command/arguments, then retry.',
    `[exit ${exitCode}]`,
  ]
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: true,
    details: { code: 'SHELL_EXIT', exitCode },
  }
}

describe('which failures count', () => {
  it.each([
    ['APPROVAL_REJECTED'],
    ['CONTROL_PAUSED'],
    ['TOOL_REJECTED_BEFORE_EFFECT'],
    ['CANCELLED'],
    ['E_BUDGET'],
    ['BUDGET_EXCEEDED'],
    ['PERMISSION_DENIED'],
    ['CREDENTIALS_MISSING'],
    ['UNAUTHORIZED'],
  ])('a %s refusal never triggers', (code) => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    for (let i = 0; i < 6; i++) onToolSettled(s, 'shell', failure('refused', { code }), undefined)
    onToolSettled(s, 'shell', failure('refused'), code)
    onToolSettled(s, 'shell', failure('refused'), code)
    onToolSettled(s, 'shell', failure('refused'), code)
    expect(offered).toEqual([])
  })

  it('permission and budget refusals never trigger', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    for (let i = 0; i < 4; i++) onToolSettled(s, 'write', failure('Permission denied: /etc/hosts'))
    for (let i = 0; i < 4; i++) onToolSettled(s, 'search', failure('budget exceeded for this turn'))
    expect(offered).toEqual([])
  })

  it('a code keys the error, whatever the text says', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    onToolSettled(s, 'fetch', failure('timeout after 3s', { code: 'TIMEOUT' }))
    expect(offered).toEqual([])
    onToolSettled(s, 'fetch', failure('no response after 9s', { code: 'TIMEOUT' }))
    expect(offered).toHaveLength(1)
  })

  it('two shell commands that fail with different errors do not trigger', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    onToolSettled(s, 'shell', shellFailure('error: X'))
    onToolSettled(s, 'shell', shellFailure('error: Y', { exitCode: 2 }))
    expect(offered).toEqual([])
  })

  it('a shell error is offered once per error: a second error gets its own offer', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    onToolSettled(s, 'shell', shellFailure('error: X in /srv/a/one.ts'))
    expect(offered).toEqual([])
    onToolSettled(s, 'shell', shellFailure('error: X in /srv/b/two.ts', { exitCode: 3 }))
    expect(offered).toEqual([{ kind: 'repeated-failure', seq: 42, focus: 'shell' }])
    onToolSettled(s, 'shell', shellFailure('error: Y'))
    expect(offered).toHaveLength(1)
    onToolSettled(s, 'shell', shellFailure('error: Y'))
    expect(offered).toHaveLength(2)
    // The first error again: it was offered already.
    onToolSettled(s, 'shell', shellFailure('error: X in /srv/a/one.ts'))
    expect(offered).toHaveLength(2)
  })

  it('a shell failure that printed nothing at all is keyed by its code', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    const empty = { content: [], isError: true, details: { code: 'SHELL_EXIT', exitCode: 1 } } as never
    onToolSettled(s, 'shell', empty)
    expect(offered).toEqual([])
    onToolSettled(s, 'shell', empty)
    expect(offered).toEqual([{ kind: 'repeated-failure', seq: 42, focus: 'shell' }])
  })

  it('a shell permission refusal never triggers', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    for (let i = 0; i < 4; i++) onToolSettled(s, 'shell', shellFailure('bash: /etc/hosts: Permission denied'))
    for (let i = 0; i < 4; i++)
      onToolSettled(s, 'shell', shellFailure('cp: /etc/hosts: Permission denied', { stdout: `copying ${i}` }))
    expect(offered).toEqual([])
  })

  it('a shell error is keyed by its stderr, not by the stdout before it', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    onToolSettled(s, 'shell', shellFailure('error: X', { stdout: 'building app' }))
    expect(offered).toEqual([])
    onToolSettled(s, 'shell', shellFailure('error: X', { stdout: 'running tests\n3 passed' }))
    expect(offered).toEqual([{ kind: 'repeated-failure', seq: 42, focus: 'shell' }])
  })

  it('the same stdout with different stderr errors does not trigger', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    onToolSettled(s, 'shell', shellFailure('error: X', { stdout: '> app@1.0.0 test' }))
    onToolSettled(s, 'shell', shellFailure('error: Y', { stdout: '> app@1.0.0 test' }))
    onToolSettled(s, 'shell', shellFailure('error: Z', { stdout: '> app@1.0.0 test' }))
    expect(offered).toEqual([])
  })

  it('a shell failure with no stderr is keyed by its first line, as before', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    onToolSettled(s, 'shell', shellFailure('', { stdout: 'build failed: X' }))
    onToolSettled(s, 'shell', shellFailure('', { stdout: 'build failed: Y' }))
    expect(offered).toEqual([])
    onToolSettled(s, 'shell', shellFailure('', { stdout: 'build failed: X' }))
    expect(offered).toEqual([{ kind: 'repeated-failure', seq: 42, focus: 'shell' }])
  })

  it('a Python traceback on stderr is keyed by its exception, not by the shell lines after it', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    const trace = (line: number, exception: string) =>
      `Traceback (most recent call last):\n  File "/srv/job.py", line ${line}, in <module>\n    run()\n${exception}`
    onToolSettled(s, 'shell', shellFailure(trace(12, 'ValueError: bad value 7')))
    onToolSettled(s, 'shell', shellFailure(trace(12, "KeyError: 'name'")))
    expect(offered).toEqual([])
    onToolSettled(s, 'shell', shellFailure(trace(40, 'ValueError: bad value 9'), { stdout: 'step 1' }))
    expect(offered).toEqual([{ kind: 'repeated-failure', seq: 42, focus: 'shell' }])
  })

  it('a specific code still keys the error for the shell too', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    onToolSettled(s, 'shell', failure('[stderr]\nfirst\n[timed out after 1000ms]', { code: 'SHELL_TIMEOUT' }))
    expect(offered).toEqual([])
    onToolSettled(
      s,
      'shell',
      failure('[stderr]\nsecond\n[timed out after 9000ms]', { code: 'SHELL_TIMEOUT' }),
    )
    expect(offered).toEqual([{ kind: 'repeated-failure', seq: 42, focus: 'shell' }])
  })

  it('the same error from different tools is counted per tool', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    onToolSettled(s, 'a', failure('boom'))
    onToolSettled(s, 'b', failure('boom'))
    expect(offered).toEqual([])
    onToolSettled(s, 'a', failure('boom'))
    expect(offered).toEqual([{ kind: 'repeated-failure', seq: 42, focus: 'a' }])
  })

  it('successes are not counted and do not reset', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    onToolSettled(s, 'a', failure('boom'))
    onToolSettled(s, 'a', text('fine'))
    onToolSettled(s, 'a', failure('boom'))
    expect(offered).toEqual([{ kind: 'repeated-failure', seq: 42, focus: 'a' }])
  })

  it('the tally is per session: later turns add to it, and another session starts its own', () => {
    const { offered, port } = sink()
    const first = fakeSession(port, {})
    onToolSettled(first, 'a', failure('boom'))
    expect(offered).toEqual([])
    // A later turn of the same session counts on from the first.
    ;(first as { turn: object }).turn = {}
    onToolSettled(first, 'a', failure('boom'))
    expect(offered).toHaveLength(1)
    // Offered once, then not again for the same tool and error.
    onToolSettled(first, 'a', failure('boom'))
    expect(offered).toHaveLength(1)
    // A different session has a tally of its own.
    const other = fakeSession(port, {})
    onToolSettled(other, 'a', failure('boom'))
    expect(offered).toHaveLength(1)
  })

  it('the tally keeps a bounded number of pairs and forgets the oldest first', () => {
    const { offered, port } = sink()
    const s = fakeSession(port)
    onToolSettled(s, 'first', failure('boom'))
    for (let i = 0; i < MAX_FAILURE_TALLIES; i++) onToolSettled(s, `other-${i}`, failure('boom'))
    // The oldest pair was forgotten, so its next failure counts as the first again.
    onToolSettled(s, 'first', failure('boom'))
    expect(offered).toEqual([])
    onToolSettled(s, 'first', failure('boom'))
    expect(offered).toEqual([{ kind: 'repeated-failure', seq: 42, focus: 'first' }])
  })

  it('does nothing outside a turn', () => {
    const { offered, port } = sink()
    for (let i = 0; i < 4; i++) onToolSettled(fakeSession(port, null), 'a', failure('boom'))
    expect(offered).toEqual([])
  })

  it('a throwing switch never breaks the tool step or the compaction hook', () => {
    const { port } = sink()
    const s = fakeSession(port) as { d: { refinementEnabled: () => boolean } }
    s.d.refinementEnabled = () => {
      throw new Error('switch down')
    }
    for (let i = 0; i < 3; i++) expect(() => onToolSettled(s as never, 'a', failure('boom'))).not.toThrow()
    expect(() => onCompactionCommitted(s as never, { replaceSeq: 1, mode: 'summary' })).not.toThrow()
  })

  it('a throwing sink never breaks the tool step', () => {
    const port: RefinementTriggerSink = {
      offer: () => {
        throw new Error('sink down')
      },
    }
    const s = fakeSession(port)
    for (let i = 0; i < 3; i++) expect(() => onToolSettled(s, 'a', failure('boom'))).not.toThrow()
  })
})

describe('normalizeCommandError', () => {
  const err = (t: string) => normalizeCommandError([{ type: 'text', text: t }])
  it('keys by the first line of stderr, masked like any error', () => {
    expect(err('building\n[stderr]\n\nerror: cannot open /tmp/a1/x.txt (code 2)\nmore\n[exit 1]')).toBe(
      'error: cannot open <path> (code #)',
    )
  })
  it('keys a traceback on stderr by its exception line, before the shell closing lines', () => {
    const text = [
      'step 1',
      '[stderr]',
      'Traceback (most recent call last):',
      '  File "/srv/job.py", line 3, in <module>',
      'ValueError: bad value 7',
      'Command failed; inspect the output and current state, correct the command/arguments, then retry.',
      '[exit 1] [output truncated by sandbox]',
    ].join('\n')
    expect(err(text)).toBe('valueerror: bad value #')
  })
  it('falls back to the first-line rule when stderr is missing or empty', () => {
    const plain = 'build failed: X\nCommand failed; inspect the output and current state.\n[exit 1]'
    expect(err(plain)).toBe(normalizeToolError({ content: [{ type: 'text', text: plain }] }))
    const empty = 'build failed: X\n[stderr]\n   \n[exit 1]'
    expect(err(empty)).toBe('build failed: x')
    expect(normalizeCommandError([])).toBe('')
  })
})

describe('normalizeToolError', () => {
  it('uses the code when there is one', () => {
    expect(normalizeToolError({ code: 'TIMEOUT', content: [{ type: 'text', text: 'anything' }] })).toBe(
      'TIMEOUT',
    )
  })
  it('skips stream labels and masks paths, long hex and digits', () => {
    const a = normalizeToolError({
      content: [{ type: 'text', text: '[stderr]\ncat: /tmp/abc/file1.txt: No such file (exit 2)' }],
    })
    const b = normalizeToolError({
      content: [{ type: 'text', text: '[stdout]\n[stderr]\ncat: /var/x/file9.txt: No such file (exit 7)' }],
    })
    expect(a).toBe('cat: <path> no such file (exit #)')
    expect(b).toBe(a)
    expect(normalizeToolError({ content: [{ type: 'text', text: 'commit deadbeef12345678 failed' }] })).toBe(
      'commit <hex> failed',
    )
  })
  it('different errors behind the same label stay different', () => {
    const one = normalizeToolError({ content: [{ type: 'text', text: '[stderr]\nfirst' }] })
    const two = normalizeToolError({ content: [{ type: 'text', text: '[stderr]\nsecond' }] })
    expect(one).not.toBe(two)
  })
  it('keys a Python traceback by its exception line', () => {
    const err = (t: string) => normalizeToolError({ content: [{ type: 'text', text: t }] })
    const trace = (file: string, line: number, exception: string) =>
      `[stderr]\nTraceback (most recent call last):\n  File "${file}", line ${line}, in <module>\n    run()\n${exception}\n`
    expect(err(trace('/srv/a/job.py', 12, 'ValueError: bad value 7'))).toBe('valueerror: bad value #')
    expect(err(trace('/srv/a/job.py', 12, 'ValueError: bad value 7'))).toBe(
      err(trace('/opt/x/other.py', 301, 'ValueError: bad value 9')),
    )
    expect(err(trace('/srv/a/job.py', 12, 'ValueError: bad value 7'))).not.toBe(
      err(trace('/srv/a/job.py', 12, "KeyError: 'name'")),
    )
  })
  it('cuts at 120 characters and survives odd content', () => {
    expect(normalizeToolError({ content: [{ type: 'text', text: 'x'.repeat(500) }] })).toHaveLength(120)
    expect(normalizeToolError({ content: [null, 7, { type: 'image' }] })).toBe('')
    expect(normalizeToolError({})).toBe('')
  })
})

describe('child sessions', () => {
  it('a real spawned child and a real role child never offer; their parent does', async () => {
    // A spawned child records its parent; a role child opens with no parent at all, and only its
    // delegation says it is a child.
    const role = { ref: '@fixture/roles#reader', title: { en: 'Reader' } }
    const roleDelegation: RoleDelegation = {
      role,
      parentKey: 'parent',
      actor,
      tools: [],
      generationLimit: 3,
      maxFanOut: 2,
      permission: 'read-only',
      approvalPolicy: 'never',
      parentPolicy: 'default',
      parentTainted: false,
      sandboxRequired: true,
      filesystem: fakeSeams().sandbox.fsPolicy(),
    }
    const options = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }
    const { candidates, port } = sink()
    let k!: Kernel
    k = Kernel.create({
      loops: defaultLoops(),
      storage: new MemoryStorage(),
      seams: fakeSeams(),
      provider: fakeProvider([textTurn('done')]),
      contract: { contract_id: null, parser_version: '1' },
      preset: { ...presetDefaults(), generationLimit: 3, maxFanOut: 4, treeBudgetCredits: 100 },
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      timers: noTimers,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      refinementEnabled: () => true,
      refinementTriggers: port,
      childRoles: {
        list: async () => [role],
        resolve: async () => ({
          role,
          open: (key, opts) => k.session(key, { ...options, ...opts, roleDelegation }),
        }),
      },
    })
    try {
      const parent = await k.session('parent', options)
      const spawned = await parent.d.children.create({ parent: 'parent', cwd: '/w', input: 'spawned' })
      const roled = await parent.d.children.createWithKind?.('spawn', {
        parent: 'parent',
        cwd: '/w',
        role: role.ref,
        input: 'role',
        resident: true,
      })
      const roleChild = k.get(roled?.key ?? '') as SessionImpl
      expect(roleChild.d.log.parent).toBeUndefined()
      const children = [k.get(spawned.key) as SessionImpl, roleChild]
      candidates.length = 0
      for (const session of [...children, parent]) {
        session.turn = {} as never
        for (let i = 0; i < 3; i++) onToolSettled(session, 'shell', { ...text('boom'), isError: true })
        onCompactionCommitted(session, { replaceSeq: 7, mode: 'summary' })
      }
      expect(candidates.map((c) => c.sessionKey)).toEqual(['parent', 'parent'])
      expect(candidates.map((c) => [c.lane, c.trigger.kind])).toEqual([
        ['main', 'repeated-failure'],
        ['main', 'compaction'],
      ])
    } finally {
      await k.close()
    }
  })
})
