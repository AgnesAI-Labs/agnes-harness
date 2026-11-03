import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { defaultLoopPlugin, memoryPlugin } from '@agnes/base'
import { operations as codeOperations } from '@agnes/code'
import { REVIEW_AFTER_MS, RefinementRegistry } from '@agnes/host-infrastructure/refinement-registry'
import { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { requestRefinement } from '../../src/runtime/sessions/session-refinement.js'
import {
  type CapturedRequest,
  createTestHost,
  startWireCapture,
  type WireReply,
} from '../../testkit/index.js'

// The whole promotion path in an assembled host: the refine plugin's planner on a loopback model, Core's
// reach and automatic offer, the Host's promotion, user registry and validity view, and the bundled file
// memory read from a second workspace.
const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))
const PROFILE = 'user-promotion-e2e'
const PLANNER_MARK = 'You review one piece of finished agent work'
const QUOTE = 'answer in short sentences'
const LESSON = 'Answer in short sentences; the user reads replies on a phone.'
const AGAIN = 'Remember to keep answers short please'
const ONCE_MORE = 'Once more, keep answers short today'
const T0 = Date.UTC(2026, 10, 4, 9)
const DAY = 86_400_000

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const plugins = [
  { export: 'defaultLoopPlugin', id: 'loop:agnes.default', inject: ['loops'], entry: defaultLoopPlugin },
  { export: 'memoryPlugin', id: 'memory:file', inject: ['providers'], entry: memoryPlugin },
].map(({ entry, ...declaration }) => ({
  declaration: {
    ...declaration,
    apiRange: '^5.0.0',
    default: true,
    provide: [],
    runtime: 'in-process' as const,
  },
  entry: normalizePluginExport(entry),
}))

type Evidence = { id: string; kind: string; text: string }
type Host = Awaited<ReturnType<typeof createTestHost>>['host']
type Session = Awaited<ReturnType<Host['createSession']>>

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
const plan = (o: { edits?: unknown[]; confirmations?: unknown[]; evidenceIds: string[] }): WireReply => ({
  text: JSON.stringify({
    summary: 'How the user wants answers.',
    rationale: 'The user said so.',
    expectedOutcome: 'Short answers.',
    edits: o.edits ?? [],
    confirmations: o.confirmations ?? [],
    evidenceIds: o.evidenceIds,
  }),
})
/** A session lesson quoting the user, suggested for every workspace. */
function lesson(body: unknown): WireReply {
  const asked = evidenceOf(body).find((e) => e.kind === 'user' && e.text.includes(QUOTE))
  if (!asked) return plan({ evidenceIds: [] })
  return plan({
    edits: [
      {
        op: 'upsert',
        kind: 'memory',
        id: 'short-answers',
        title: 'Answer style',
        content: LESSON,
        applicability: 'session',
        evidenceIds: [asked.id],
        quote: QUOTE,
        reach: 'user',
      },
    ],
    evidenceIds: [asked.id],
  })
}
const confirm =
  (quote: string) =>
  (body: unknown): WireReply => {
    const asked = evidenceOf(body).find((e) => e.kind === 'user' && e.text.includes(quote))
    if (!asked) return plan({ evidenceIds: [] })
    return plan({
      confirmations: [{ entryId: 'memory/short-answers', evidenceIds: [asked.id], quote }],
      evidenceIds: [asked.id],
    })
  }

async function until(what: string, ready: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = performance.now() + ms
  while (!(await ready())) {
    if (performance.now() > end) throw new Error(`timed out waiting until ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
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
async function refine(session: Session): Promise<void> {
  const { runId } = await requestRefinement(session as never)
  await until('the review is applied', () => {
    const run = session.state.refinementRuns.get(runId)
    if (run?.state === 'no-op' || run?.state === 'rejected')
      throw new Error(`the review ended ${run.state}: ${JSON.stringify(run)}`)
    return run?.state === 'applied'
  })
}
const latestMemoryNote = (request: CapturedRequest | undefined): string => {
  const raw = request?.raw ?? ''
  const from = raw.lastIndexOf('memory:index')
  return from < 0 ? '' : raw.slice(from, raw.indexOf('"', from))
}
const systemOf = (request: CapturedRequest | undefined): string => {
  const body = (request?.body ?? {}) as { system?: unknown; messages?: { role?: string }[] }
  return JSON.stringify([body.system ?? null, (body.messages ?? []).filter((m) => m.role === 'system')])
}

/** An assembled host with two workspaces: A learns, B reads user memory. */
async function twoWorkspaces(
  enabled: boolean,
  run: (t: {
    host: Host
    openHost: (workspace: string) => Promise<Host>
    a: string
    b: string
    dataDir: string
    main: () => CapturedRequest[]
  }) => Promise<void>,
) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-user-promotion-')))
  dirs.push(root)
  const dataDir = join(root, 'data')
  const a = join(root, 'alpha')
  const b = join(root, 'beta')
  mkdirSync(a)
  mkdirSync(b)
  const credentials = join(dataDir, 'credentials')
  createPrivateDirectorySync(dataDir)
  createPrivateDirectorySync(credentials)
  createPrivateDirectorySync(join(credentials, 'test'))
  const credential = createPrivateFileSync(join(credentials, 'test', 'wire'))
  try {
    writeFileSync(credential, 'synthetic-wire-capture')
  } finally {
    closeSync(credential)
  }
  const settings = new RefinementSettingsStore(dataDir, PROFILE)
  settings.save({ enabled, mode: 'auto' }, settings.read().revision)
  const planner = [lesson, confirm(AGAIN), confirm(ONCE_MORE)]
  let reviews = 0
  const capture = await startWireCapture(async (body) =>
    JSON.stringify(body).includes(PLANNER_MARK)
      ? (planner[reviews++ % planner.length] as (b: unknown) => WireReply)(body)
      : { text: 'Done.' },
  )
  vi.stubEnv('AGH_HOME', dataDir)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  try {
    const api = 'anthropic-messages' as const
    const baseUrl = capture.baseUrl(api)
    const model = fakeModel({
      route: 'wire',
      id: 'fixture',
      api,
      baseUrl,
      contextWindow: 100_000,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    })
    const hosts: Host[] = []
    /** A host for one workspace; a test host trusts one workspace, so each workspace gets its own. */
    const openHost = async (workspace: string) => {
      const { host } = await createTestHost({
        dataDir,
        workspaceRoot: workspace,
        packageDirs: { '@agnes/base': baseDir },
        packages: { '@agnes/code': { operations: codeOperations }, '@agnes/base': { plugins } },
        disableSessionTitle: true,
        profileInputs: {
          user: {
            name: PROFILE,
            provider: {
              package: '@agnes/ai',
              routes: [{ route: 'wire', api, baseUrl, credentialRef: 'secret://test/wire', models: [model] }],
            },
            adapters: { secrets: { kind: 'file', path: credentials } },
          },
        },
      })
      hosts.push(host)
      return host
    }
    try {
      const setup = await openHost(a)
      // A keeps its memory but does not read user memory; B reads it. Nothing here is changed later.
      await setup.memory(a, 'admin')?.configure({ mode: 'auto', userEnabled: false })
      await setup.memory(b, 'admin')?.configure({ mode: 'auto', userEnabled: true })
      await run({
        host: setup,
        openHost,
        a,
        b,
        dataDir,
        main: () => capture.requests.filter((request) => !request.raw.includes(PLANNER_MARK)),
      })
    } finally {
      for (const host of hosts) await host.close()
    }
  } finally {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    await capture.close()
  }
}

describe('promoting task experience to user memory in an assembled host', () => {
  it('a lesson learned in one workspace reaches another, expires after 30 days and stays away once withdrawn', async () => {
    await twoWorkspaces(true, async ({ host, openHost, a, b, dataDir, main }) => {
      // The data directory is the home here: user memory and its registry sit under it.
      const registry = RefinementRegistry.user(dataDir, Date.now)
      const userFile = join(dataDir, 'memory', 'user', 'MEMORY.md')

      // Workspace A learns the lesson; the second confirmation promotes it, asking nobody.
      const first = await host.createSession({ cwd: a })
      await turn(first, `Please ${QUOTE} from now on.`)
      await refine(first)
      await turn(first, AGAIN)
      await refine(first)
      await turn(first, ONCE_MORE)
      await refine(first)
      await until('the promotion is recorded', () =>
        registry.read().paragraphs.some((p) => p.state === 'active'),
      )
      const [section] = registry.read().paragraphs
      expect(section).toMatchObject({ state: 'active', reviewAfter: T0 + REVIEW_AFTER_MS })
      expect(readFileSync(userFile, 'utf8')).toBe(
        `<!-- refinement:${section?.id} -->\nAnswer style\n${LESSON}\n<!-- /refinement:${section?.id} -->\n`,
      )
      // The receipt is in A's timeline: user memory, automatic, and A does not read user memory itself.
      await until('the receipt reaches the session', () =>
        [...first.state.refinementSaves.values()].some((r) => r.outcome === 'saved'),
      )
      expect([...first.state.refinementSaves.values()]).toEqual([
        expect.objectContaining({
          initiator: 'auto',
          outcome: 'saved',
          layer: 'user',
          userMemoryRead: false,
        }),
      ])
      // Nothing went to A's workspace memory, and A's settings are as they were.
      expect((await host.memory(a, 'admin')?.readFile('MEMORY.md'))?.content).toBe('')
      expect((await host.memory(a, 'admin')?.inspect())?.settings).toMatchObject({ userEnabled: false })
      expect(existsSync(join(dataDir, 'refinement', 'workspaces'))).toBe(false)
      await first.close()

      // A new session in workspace B, on a host of its own, reads it with the user memory.
      const beta = await openHost(b)
      const second = await beta.createSession({ cwd: b, key: 'beta-session' })
      await turn(second, 'Hello again.')
      const before = main().at(-1)
      expect(latestMemoryNote(before)).toContain(LESSON)

      // Past its review date the next request leaves it out and says so; the system prompt is unchanged.
      vi.setSystemTime(T0 + REVIEW_AFTER_MS + DAY)
      await turn(second, 'And now?')
      const expired = main().at(-1)
      expect(latestMemoryNote(expired)).not.toContain(LESSON)
      expect(latestMemoryNote(expired)).toContain('1 task-experience paragraphs omitted')
      expect(systemOf(expired)).toBe(systemOf(before))

      // Renewed on the memory page, it is back; withdrawn, it is gone from the file and the next request.
      const editor = () => beta.memory(b, 'human-editor')
      const id = section?.id ?? ''
      const manage = beta.savedParagraphs
      const renewed = await manage(editor() as never, b, { action: 'renew', paragraphId: id, layer: 'user' })
      expect(renewed.paragraphs).toEqual([expect.objectContaining({ id, validity: 'valid' })])
      await turn(second, 'Still there?')
      expect(latestMemoryNote(main().at(-1))).toContain(LESSON)
      await manage(editor() as never, b, { action: 'withdraw', paragraphId: id, layer: 'user' })
      expect(readFileSync(userFile, 'utf8')).toBe('')
      expect(registry.read().revocations).toEqual([expect.objectContaining({ action: 'memory-withdrawn' })])
      await turn(second, 'And after withdrawing?')
      const withdrawn = main().at(-1)
      expect(latestMemoryNote(withdrawn)).not.toContain(LESSON)
      expect(systemOf(withdrawn)).toBe(systemOf(before))
      await second.close()
    })
  }, 120_000)

  it('with refinement off nothing is promoted and no user registry is created', async () => {
    await twoWorkspaces(false, async ({ host, a, dataDir }) => {
      const session = await host.createSession({ cwd: a })
      await turn(session, `Please ${QUOTE} from now on.`)
      await session.close()
      expect(existsSync(join(dataDir, 'memory', 'user', 'refinement.json'))).toBe(false)
      expect(existsSync(join(dataDir, 'refinement', 'workspaces'))).toBe(false)
      expect(existsSync(join(dataDir, 'memory', 'user', 'MEMORY.md'))).toBe(false)
    })
  }, 60_000)
})
