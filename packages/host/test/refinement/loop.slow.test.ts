import { closeSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { operations as codeOperations } from '@agnes/code'
import { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it, vi } from 'vitest'
import { requestRefinement } from '../../src/runtime/sessions/session-refinement.js'
import {
  type CapturedRequest,
  createTestHost,
  expectExtends,
  startWireCapture,
  type WireReply,
} from '../../testkit/index.js'
import {
  BASELINE_PROFILE,
  firstDifference,
  maskVolatile,
  normalizeForBaseline,
  runScriptedSession,
} from './scripted-session.js'

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))
const baselineFile = fileURLToPath(new URL('../fixtures/refinement/off-baseline.json', import.meta.url))
const apis = ['anthropic-messages', 'openai-completions'] as const
type Api = (typeof apis)[number]

/** The baseline session's profile: the switch saved here is the one that session reads. */
const PROFILE = BASELINE_PROFILE
/** The first words of the planner's system prompt: how the loopback tells a planning call apart. */
const PLANNER_MARK = 'You review one piece of finished agent work'
const NOTES = 'Ship the release on Friday.'
const ENTRY = 'The notes file is docs/notes.txt; there is no notes.txt at the workspace root.'
// The entry as it reaches the wire inside a JSON string: one envelope whose id names the block's
// content, under the request's nonce, with the entry line inside it.
const ENVELOPED_ENTRY =
  /<untrusted id=\\"[0-9a-f]{32,64}-n[0-9a-f]{16}-0\\" bytes=\\"\d+\\">[^<]*\[memory\/notes-location v1\] Notes file location: The notes file is docs\/notes\.txt[^<]*<\/untrusted id=\\"/
const MARKER = '[task-experience]\\n'
/** The deferred-tool listing of a request, where registered refinement tools would be named. */
const deferredListing = (request: CapturedRequest | undefined) =>
  request?.raw.match(/<available_deferred_tools>[\s\S]*?<\/available_deferred_tools>/u)?.[0]

type Session = Awaited<ReturnType<Awaited<ReturnType<typeof createTestHost>>['host']['createSession']>>
type Row = { seq: number; type: string; lane?: string; data: Record<string, unknown> }
/** One model reply, or a function that decides it when the request arrives (and may wait). */
type Step = WireReply | (() => WireReply | Promise<WireReply>)
/** A verbatim part of the user's request that grants the lesson session level. */
const QUOTE = 'tell me what it says'

type Evidence = { id: string; kind: string; tool?: string; args?: string; isError?: boolean; text: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, ready: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!ready()) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`)
    await sleep(5)
  }
}

function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

const isPlanner = (request: CapturedRequest) => request.raw.includes(PLANNER_MARK)

/** The evidence lines of a planner request, as the planner prompt lists them (one JSON object a line). */
function evidenceOf(body: unknown): Evidence[] {
  const found: Evidence[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const line of value.split('\n'))
        if (line.startsWith('{"id":"e')) found.push(JSON.parse(line) as Evidence)
    } else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(body)
  return found
}

const NOTHING_TO_KEEP: WireReply = {
  text: JSON.stringify({
    summary: 'Nothing worth keeping.',
    rationale: 'A one-off typo.',
    expectedOutcome: '',
    edits: [],
    confirmations: [],
    evidenceIds: [],
  }),
}

/**
 * The planner's answer: one session entry citing the failed read, the read that fixed it and the
 * user's request, quoted verbatim so the entry is granted session level (the two reads name
 * different paths, so they are not a failed-then-successful pair on one target).
 */
function lessonFrom(body: unknown): WireReply {
  const evidence = evidenceOf(body)
  const failed = evidence.find((e) => e.tool === 'read' && e.isError === true)
  const fixed = evidence.find((e) => e.tool === 'read' && e.isError === false && e.text.includes(NOTES))
  const asked = evidence.find((e) => e.kind === 'user' && e.text.includes(QUOTE))
  // Without all three, nothing is proposed and the test that expects an entry fails on the run's states.
  if (!failed || !fixed || !asked) return NOTHING_TO_KEEP
  const cited = [asked.id, failed.id, fixed.id]
  return {
    text: JSON.stringify({
      summary: 'Read the notes from docs/notes.txt.',
      rationale: 'notes.txt at the root failed; docs/notes.txt worked.',
      expectedOutcome: 'The first read of the notes succeeds.',
      edits: [
        {
          op: 'upsert',
          kind: 'memory',
          id: 'notes-location',
          title: 'Notes file location',
          content: ENTRY,
          applicability: 'session',
          evidenceIds: cited,
          quote: QUOTE,
        },
      ],
      confirmations: [],
      evidenceIds: cited,
    }),
  }
}

const read = (path: string): WireReply => ({ toolCall: { name: 'read', args: { path } } })

type Fixture = {
  session: Session
  /** Requests of the conversation itself, in order. */
  main: () => CapturedRequest[]
  /** Planning calls the maintenance invocation sent. */
  planner: () => CapturedRequest[]
  dataDir: string
}

const saveSwitch = (dataDir: string, enabled: boolean) => {
  const store = new RefinementSettingsStore(dataDir, PROFILE)
  store.save({ enabled, mode: 'auto' }, store.read().revision)
}

/**
 * A real assembled host on a loopback provider. Conversation requests are answered by `steps` in
 * order; a planning call is answered by `plan`. The planner model is the session's priced primary.
 */
async function withHost(
  o: {
    api: Api
    dataDir: string
    switchOn: boolean
    steps: Step[]
    plan: (body: unknown) => WireReply | Promise<WireReply>
  },
  run: (t: Fixture) => Promise<void>,
): Promise<void> {
  const workspace = join(o.dataDir, `workspace-${o.api}`)
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  writeFileSync(join(workspace, 'docs', 'notes.txt'), `${NOTES}\n`)
  // Not the scripted baseline's own credentials directory: that session creates it afresh.
  const credentials = join(o.dataDir, 'loop-credentials')
  createPrivateDirectorySync(credentials)
  createPrivateDirectorySync(join(credentials, 'test'))
  const credential = createPrivateFileSync(join(credentials, 'test', 'wire'))
  try {
    writeFileSync(credential, 'synthetic-wire-capture')
  } finally {
    closeSync(credential)
  }
  if (o.switchOn) saveSwitch(o.dataDir, true)
  let next = 0
  const capture = await startWireCapture(async (body) => {
    if (JSON.stringify(body).includes(PLANNER_MARK)) return o.plan(body)
    const step = o.steps[next++] ?? { text: 'Done.' }
    return typeof step === 'function' ? step() : step
  })
  vi.stubEnv('AGH_HOME', o.dataDir)
  try {
    const baseUrl = capture.baseUrl(o.api)
    const model = fakeModel({
      route: 'wire',
      id: 'fixture',
      api: o.api,
      baseUrl,
      contextWindow: 100_000,
      // Automatic planning needs a priced model: its spend is bounded by the maintenance budget.
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    })
    const { host } = await createTestHost({
      dataDir: o.dataDir,
      workspaceRoot: workspace,
      packageDirs: { '@agnes/base': baseDir },
      packages: { '@agnes/code': { operations: codeOperations } },
      disableSessionTitle: true,
      profileInputs: {
        user: {
          name: PROFILE,
          provider: {
            package: '@agnes/ai',
            routes: [
              { route: 'wire', api: o.api, baseUrl, credentialRef: 'secret://test/wire', models: [model] },
            ],
          },
          adapters: { secrets: { kind: 'file', path: credentials } },
        },
      },
    })
    try {
      const session = await host.createSession({ cwd: workspace })
      expect(session.d.refinement?.settings().enabled).toBe(o.switchOn)
      await run({
        session,
        main: () => capture.requests.filter((r) => !isPlanner(r)),
        planner: () => capture.requests.filter(isPlanner),
        dataDir: o.dataDir,
      })
    } finally {
      await host.close()
    }
  } finally {
    vi.unstubAllEnvs()
    await capture.close()
  }
}

async function withDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-refinement-loop-')))
  try {
    const dataDir = join(root, 'data')
    mkdirSync(dataDir)
    await run(dataDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function turn(session: Session, prompt: string): Promise<void> {
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text: prompt }],
    actor: session.d.actor,
    kind: 'prompt',
  })
  const result = await session.run({ until: 'turn-end', signal: new AbortController().signal })
  expect(result.reason).toBe('completed')
}

const scan = async (session: Session, type: string | string[]): Promise<Row[]> =>
  (await session.d.log.scan({ type, limit: 500 })) as unknown as Row[]

const runRows = async (session: Session, runId: string) =>
  (await scan(session, 'x/core/refinement-run')).filter((row) => row.data.runId === runId)

const onlyRun = (session: Session) => {
  const runs = [...session.state.refinementRuns.values()]
  return runs.length === 1 ? runs[0] : undefined
}

const entries = (session: Session) =>
  [...session.state.registers.harnessEntries.values()].map((cell) => cell.value)

/** The turn ends on the conversation lane, in order. */
const turnEnds = async (session: Session) => (await scan(session, 'turn/end')).map((row) => row.seq)

describe('the refinement loop in an assembled host', () => {
  it.each(apis)(
    '%s: a corrected tool error is planned in the background, applied after the turn, read by the next request',
    async (api) => {
      await withDataDir(async (dataDir) => {
        await loop(api, dataDir)
      })
    },
  )

  it.each(apis)('%s: a plan with nothing to keep ends no-op and writes no entry', async (api) => {
    await withDataDir(async (dataDir) => {
      await withHost(
        {
          api,
          dataDir,
          switchOn: true,
          // Three identical failures of one tool in a turn are the automatic trigger.
          steps: [
            read('notes.txt'),
            read('notes.txt'),
            read('notes.txt'),
            read('docs/notes.txt'),
            { text: NOTES },
            { text: 'Nothing else.' },
          ],
          plan: () => NOTHING_TO_KEEP,
        },
        async ({ session, main, planner }) => {
          await turn(session, 'Read notes.txt and tell me what it says.')
          await until('the plan ends', () => onlyRun(session)?.state === 'no-op')
          const run = onlyRun(session)
          expect(run?.trigger).toMatchObject({ kind: 'repeated-failure', focus: 'read' })
          expect((await runRows(session, run?.runId ?? '')).map((row) => row.data.state)).toEqual([
            'queued',
            'planning',
            'no-op',
          ])
          expect(planner()).toHaveLength(1)
          expect(await scan(session, ['harness/refine', 'harness/entry'])).toEqual([])
          expect(entries(session)).toEqual([])
          await turn(session, 'Anything else?')
          const next = main().at(-1)
          // Only the snapshot the first request carried, now history; no update and no entry.
          expect(next?.raw.split(MARKER)).toHaveLength(2)
          expect(next?.raw).not.toContain('Task experience update')
          expect(next?.raw).not.toContain('notes-location')
        },
      )
    })
  })

  it.each(apis)(
    '%s: the user starts the next turn while planning runs; the apply waits for that turn to end',
    async (api) => {
      await withDataDir(async (dataDir) => {
        const answer = gate()
        let session: Session | undefined
        let plannerWaiting = false
        const during: { before?: string | undefined; after?: string | undefined; entries?: number } = {}
        const state = () => (session ? onlyRun(session)?.state : undefined)
        await withHost(
          {
            api,
            dataDir,
            switchOn: true,
            steps: [
              read('notes.txt'),
              read('docs/notes.txt'),
              { text: NOTES },
              // Turn 2's only request, sent while the planning call still waits for its answer.
              // Answer it now, while this turn is open, and reply once the result is proposed.
              async () => {
                during.before = state()
                answer.open()
                await until('the plan is proposed', () => state() === 'proposed')
                during.after = state()
                during.entries = session ? entries(session).length : -1
                return { text: 'Nothing else.' }
              },
              { text: 'Check the release checklist next.' },
            ],
            plan: async (body) => {
              plannerWaiting = true
              await answer.opened
              return lessonFrom(body)
            },
          },
          async (t) => {
            session = t.session
            await turn(t.session, 'Read notes.txt and tell me what it says.')
            const { runId } = await requestRefinement(t.session, 'where the notes file lives')
            await until('the planning call is sent', () => plannerWaiting)
            expect(t.session.state.refinementRuns.get(runId)?.state).toBe('planning')
            // Not blocked: this turn runs to its end while the planning call was unanswered at its start.
            await turn(t.session, 'Anything else?')
            expect(during).toEqual({ before: 'planning', after: 'proposed', entries: 0 })
            const [, secondEnd] = await turnEnds(t.session)
            const rows = await runRows(t.session, runId)
            expect(rows.map((row) => row.data.state)).toEqual(['queued', 'planning', 'proposed', 'applied'])
            expect(rows[2]?.seq).toBeLessThan(secondEnd ?? 0)
            expect(rows[3]?.seq).toBeGreaterThan(secondEnd ?? Number.POSITIVE_INFINITY)
            const [refine] = await scan(t.session, 'harness/refine')
            expect(refine?.seq).toBeGreaterThan(secondEnd ?? Number.POSITIVE_INFINITY)
            await turn(t.session, 'What should I check next?')
            const main = t.main()
            expect(main).toHaveLength(5)
            for (const request of main.slice(0, 4)) expect(request.raw).not.toContain(ENTRY)
            expect(main[4]?.raw).toMatch(ENVELOPED_ENTRY)
          },
        )
      })
    },
  )

  it.each(apis)(
    '%s: with refinement switched off the same script writes and sends nothing of it',
    async (api) => {
      await withDataDir(async (dataDir) => {
        saveSwitch(dataDir, true)
        saveSwitch(dataDir, false)
        await withHost(
          { api, dataDir, switchOn: false, steps: loopSteps(), plan: () => NOTHING_TO_KEEP },
          async ({ session, main, planner }) => {
            await turn(session, 'Read notes.txt and tell me what it says.')
            await turn(session, 'What should I check next?')
            expect(planner()).toEqual([])
            expect(main()).toHaveLength(6)
            for (const request of main()) {
              expect(request.raw).not.toContain('[task-experience]')
              // The script still calls harness_refine; the tool is simply not there.
              expect(deferredListing(request)).toBeDefined()
              expect(deferredListing(request)).not.toContain('harness_')
            }
            expect(await scan(session, ['x/core/refinement-run', 'harness/refine', 'harness/entry'])).toEqual(
              [],
            )
            expect(await session.d.log.scan({ lane: 'refinement', limit: 10 })).toEqual([])
          },
        )
      })
    },
  )

  // The request bytes are produced by cross-platform code and are pinned on Linux and macOS. A Windows
  // host adds a PowerShell description to the prompt while it assembles (the host resolves PowerShell,
  // and the prompt prefers that description over the platform's shell), so that assembly is not part of
  // this comparison and could not be verified here. Follow-up: make `pinnedPlatform().matches` return
  // false on win32 and run one Windows diagnostic. The other cases in this describe run everywhere.
  it.skipIf(process.platform === 'win32').each(apis)(
    '%s: after refinement was used and switched off, the baseline session sends the baseline bytes',
    async (api) => {
      await withDataDir(async (dataDir) => {
        await loop(api, dataDir)
        saveSwitch(dataDir, false)
        // The baseline session reads this very switch: saved, now off, and not the never-saved default.
        const saved = new RefinementSettingsStore(dataDir, BASELINE_PROFILE).read()
        const neverSaved = new RefinementSettingsStore(join(dataDir, 'never-saved'), BASELINE_PROFILE).read()
        expect(saved.settings.enabled).toBe(false)
        expect(saved.revision).not.toBe(neverSaved.revision)
        const workspace = join(dataDir, 'baseline-workspace')
        mkdirSync(workspace)
        const requests = await runScriptedSession({ dataDir, workspace, api })
        const actual = maskVolatile(
          requests.map((request) => request.raw),
          { dataDir, workspace },
        ).map(normalizeForBaseline)
        const baseline = (JSON.parse(readFileSync(baselineFile, 'utf8')) as Record<Api, string[]>)[api]
        expect(actual).toHaveLength(baseline.length)
        for (const [index, request] of actual.entries()) {
          const expected = baseline[index] ?? ''
          if (request !== expected)
            throw new Error(`${api} request ${index}: ${firstDifference(expected, request)}`)
        }
      })
    },
  )
})

/** Turn 1: a read fails, the model reads the right file, asks for a review, then answers. Turn 2: one request. */
function loopSteps(answer?: () => Promise<void>): Step[] {
  return [
    read('notes.txt'),
    read('docs/notes.txt'),
    { toolCall: { name: 'tool_describe', args: { name: 'harness_refine' } } },
    { toolCall: { name: 'harness_refine', args: { focus: 'where the notes file lives' } } },
    async () => {
      await answer?.()
      return { text: NOTES }
    },
    { text: 'Check the release checklist next.' },
  ]
}

/**
 * The reproducible loop: the model trigger falls inside turn 1; the planning call is answered and
 * the result proposed while turn 1 is still open; it is applied after turn 1 ends, and turn 2's
 * request carries the entry.
 */
async function loop(api: Api, dataDir: string): Promise<void> {
  let session: Session | undefined
  let atAnswer: { state: string | undefined; entries: number } | undefined
  await withHost(
    {
      api,
      dataDir,
      switchOn: true,
      steps: loopSteps(async () => {
        const s = session as Session
        await until('the plan is proposed', () => onlyRun(s)?.state === 'proposed')
        atAnswer = { state: onlyRun(s)?.state, entries: entries(s).length }
      }),
      plan: lessonFrom,
    },
    async (t) => {
      session = t.session
      await turn(t.session, 'Read notes.txt and tell me what it says.')
      const run = onlyRun(t.session)
      if (!run) throw new Error('no refinement run')
      expect(run.trigger).toMatchObject({ kind: 'model', focus: 'where the notes file lives' })
      // Proposed while turn 1 was open, and nothing was applied then.
      expect(atAnswer).toEqual({ state: 'proposed', entries: 0 })
      const rows = await runRows(t.session, run.runId)
      expect(rows.map((row) => row.data.state)).toEqual(['queued', 'planning', 'proposed', 'applied'])
      const [firstEnd] = await turnEnds(t.session)
      expect(rows[2]?.seq).toBeLessThan(firstEnd ?? 0)
      expect(rows[3]?.seq).toBeGreaterThan(firstEnd ?? Number.POSITIVE_INFINITY)
      const refines = await scan(t.session, 'harness/refine')
      expect(refines).toHaveLength(1)
      expect(refines[0]?.seq).toBeGreaterThan(firstEnd ?? Number.POSITIVE_INFINITY)
      // The evidence the plan cites is the user's request (quoted, which grants the session level),
      // the failed read and the read that fixed it.
      const request = (await scan(t.session, 'user/message')).find((row) =>
        JSON.stringify(row.data.content).includes(QUOTE),
      )
      const results = await scan(t.session, 'tool/result')
      const failed = results.find((row) => row.data.isError === true)
      const fixed = results.find(
        (row) => row.data.isError !== true && JSON.stringify(row.data.content).includes(NOTES),
      )
      const plan = rows[2]?.data.plan as { edits: { evidenceSeqs: number[] }[] }
      expect(plan.edits[0]?.evidenceSeqs).toEqual([request?.seq, failed?.seq, fixed?.seq])
      expect(plan.edits[0]).toMatchObject({ applicability: 'session' })
      expect(plan.edits[0]).not.toHaveProperty('quote')
      // One background call on the maintenance lane.
      const intents = await scan(t.session, 'x/core/maintenance-intent')
      expect(intents.map((row) => row.lane)).toEqual(['refinement'])
      // The lane filter the off case relies on finds the run rows and the call here.
      const lane = await t.session.d.log.scan({ lane: 'refinement', limit: 500 })
      expect(lane.map((row) => row.type)).toEqual(
        expect.arrayContaining(['x/core/refinement-run', 'x/core/maintenance-intent']),
      )
      // The tools are registered: the switch was on when the host was assembled.
      // harness_refine is always loaded (its schema is in the request); the other two are listed as deferred.
      expect(t.main()[0]?.raw).toContain('harness_refine')
      expect(deferredListing(t.main()[0])).not.toContain('harness_refine')
      expect(deferredListing(t.main()[0])).toContain('harness_propose')
      expect(t.planner()).toHaveLength(1)
      expect(t.planner()[0]?.raw).toContain('Trigger: model.')
      const evidence = evidenceOf(t.planner()[0]?.body)
      expect(evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'user', text: 'Read notes.txt and tell me what it says.' }),
          expect.objectContaining({
            tool: 'read',
            isError: true,
            args: expect.stringContaining('"notes.txt"'),
          }),
          expect.objectContaining({ tool: 'read', isError: false, text: expect.stringContaining(NOTES) }),
        ]),
      )
      expect(entries(t.session)).toEqual([
        expect.objectContaining({
          kind: 'memory',
          id: 'notes-location',
          title: 'Notes file location',
          content: ENTRY,
        }),
      ])
      await turn(t.session, 'What should I check next?')
      const main = t.main()
      expect(main).toHaveLength(6)
      for (const request of main.slice(0, 5)) expect(request.raw).not.toContain(ENTRY)
      const next = main[5] as CapturedRequest
      expect(next.raw).toMatch(ENVELOPED_ENTRY)
      // Once on the wire, only inside its envelope; and the request extends the one before it.
      expect(next.raw.split('docs/notes.txt; there is no notes.txt')).toHaveLength(2)
      expectExtends(main[4] as CapturedRequest, next)
    },
  )
}
