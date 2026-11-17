import { resolve } from 'node:path'
import { HookEngine, SessionHookPort, ToolRegistry } from '@agnes/core'
import {
  actor,
  fakeProvider,
  fakeSeams,
  openSession,
  readTool,
  type Script,
  textTurn,
  toolTurn,
} from '@agnes/core/testkit'
import { platformFacts } from '@agnes/core-effects/effects/platform-facts'
import type { ProcessExit, ToolDef } from '@agnes/extension-api'
import type { RequestBody } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createJobTools, jobHooks } from '../src/index.js'
import { ShellJobs } from '../src/registry.js'

// The jobs extension inside a real Core session: what the model is sent while a background job runs
// and after it ends, and what Core's own repeat reminder makes of polling it.

const SESSION = 'k'
const platform = platformFacts(fakeSeams().platform)

/** A background command this session started; the test decides when it ends. */
async function backgroundJob(jobs: ShellJobs, command = 'make world') {
  const tool = fakeToolContext({ sessionKey: SESSION, cwd: resolve('/w') })
  let exit!: (value: ProcessExit) => void
  tool.sandbox.openProcess = async () => ({
    enforcement: { level: 'none', scope: [] },
    exited: new Promise<ProcessExit>((done) => {
      exit = done
    }),
    onOutput: () => () => {},
    write: async () => {},
    resize: async () => {},
    signal: async () => {},
    close: async () => exit({ code: -1 }),
  })
  const job = await jobs.start(command, tool.cwd, tool)
  return {
    id: job.id,
    async end(code: number) {
      exit({ code })
      await new Promise((settled) => setTimeout(settled, 0))
    },
  }
}

/** One turn of a session whose model follows `script`; the jobs context hook is registered unless told not to. */
async function runTurn(jobs: ShellJobs, script: Script[], tools: ToolDef[], o: { hook?: boolean } = {}) {
  const registry = new ToolRegistry()
  for (const tool of tools) registry.add(tool, { source: 'agnes/jobs', trust: 'builtin' })
  const provider = fakeProvider(script)
  const { session, log } = await openSession({ key: SESSION, provider, registry })
  if (o.hook !== false) {
    const engine = new HookEngine({ diag: () => undefined, onFailure: () => undefined, platform })
    engine.on('context', jobHooks(jobs).context, { source: 'agnes/jobs', trust: 'builtin' })
    session.hooks = new SessionHookPort(engine, {
      context: () => ({
        session: { key: SESSION, lane: 'main', workspaceRoot: '/w' },
        lease: { expiresAt: '2099-01-01T00:00:00Z', scope: {}, budget: { remaining: 10 } },
        replayed: false,
        signal: new AbortController().signal,
        log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
      budget: () => ({ remaining: 10, cap: 10 }),
      surface: () => [],
      surfaceDigest: () => ({ nodes: 0, tokensEstimate: 0 }),
      verifierTier: () => 0,
      contextOverflow: () => undefined,
      compactPlanIgnored: () => undefined,
    })
  }
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 'build it' }], actor })
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  const results = (await log.scan({ type: 'tool/result', limit: 50 })).map((row) =>
    ((row.data as { content?: Array<{ text?: string }> }).content ?? []).map((b) => b.text ?? '').join(''),
  )
  return { requests: provider.requests, results, provider }
}

const texts = (request: RequestBody) =>
  request.messages.map((m) => (m.content as Array<{ text?: string }>).map((b) => b.text ?? '').join(''))
const notices = (request: RequestBody) => texts(request).filter((text) => text.includes('Jobs completed'))

afterEach(() => vi.restoreAllMocks())

it('tells the model a background job ended on the very next request, once, and adds nothing after that', async () => {
  const jobs = new ShellJobs()
  try {
    const job = await backgroundJob(jobs)
    let reads = 0
    const read = readTool(async () => {
      // The build ends while the model is busy with its second step.
      if (++reads === 2) await job.end(0)
      return { content: [{ type: 'text', text: `read ${reads}` }] }
    })
    const script = [
      toolTurn('read', { path: 'a' }),
      toolTurn('read', { path: 'b' }),
      toolTurn('read', { path: 'c' }),
    ]
    const { requests } = await runTurn(jobs, [...script, textTurn('done')], [read])
    expect(requests.map((request) => notices(request).length)).toEqual([0, 0, 1, 1])
    const [, , before, after] = requests as [RequestBody, RequestBody, RequestBody, RequestBody]
    expect(notices(before)[0]).toContain(`Jobs completed: ${job.id}: completed (exit 0)`)
    // The request after the notice is the one before it plus the step in between, byte for byte:
    // nothing is repeated, cleared or re-sent while no other job has ended.
    expect(after.system).toBe(before.system)
    expect(after.tools).toEqual(before.tools)
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages)
    expect(after.messages.slice(before.messages.length).map((m) => m.role)).toEqual([
      'assistant',
      'tool_result',
    ])
  } finally {
    await jobs.dispose()
  }
})

it('sends the same requests as a session without the hook while no background job has ended', async () => {
  const run = async (hook: boolean) => {
    const jobs = new ShellJobs()
    try {
      await backgroundJob(jobs)
      const script = [toolTurn('read', { path: 'a' }), toolTurn('read', { path: 'b' }), textTurn('done')]
      return (await runTurn(jobs, script, [readTool()], { hook })).requests
    } finally {
      await jobs.dispose()
    }
  }
  // Tool use ids are minted at random per session, and the derived hash covers them.
  const comparable = (requests: RequestBody[]) =>
    requests.map((request) =>
      JSON.stringify({ ...request, derivedHash: '' }).replace(/"toolUseId":"[^"]*"/g, '"toolUseId":""'),
    )
  const [withHook, without] = [await run(true), await run(false)]
  expect(withHook).toHaveLength(3)
  expect(comparable(withHook)).toEqual(comparable(without))
})

it('never reminds the model about repeating itself while it polls a running job, but does once the job has ended', async () => {
  const jobs = new ShellJobs()
  try {
    let now = Date.parse('2026-11-09T08:00:00Z')
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const job = await backgroundJob(jobs)
    const [, output] = createJobTools(jobs) as ToolDef[] as [ToolDef, ToolDef]
    let polls = 0
    const poll = {
      ...output,
      // Each model step takes a few seconds; the job prints nothing new meanwhile.
      async execute(args: never, ctx: never) {
        now += 7_000
        if (++polls === 9) await job.end(0)
        return output.execute(args, ctx)
      },
    } as ToolDef
    const script = Array.from({ length: 11 }, () => toolTurn('job_output', { jobId: job.id }))
    const { results } = await runTurn(jobs, [...script, textTurn('done')], [poll])
    expect(results).toHaveLength(11)
    // Eight polls of the running job: every one says how long it has run, so none repeats another.
    expect(results.slice(0, 8).every((text) => text.includes('[running for '))).toBe(true)
    expect(results.slice(0, 8).filter((text) => text.includes('[Repeat'))).toEqual([])
    // The same call on the finished job, three times in a row with the same answer, is a loop.
    expect(results.slice(8).map((text) => text.includes('[Repeat'))).toEqual([false, false, true])
  } finally {
    await jobs.dispose()
  }
})
