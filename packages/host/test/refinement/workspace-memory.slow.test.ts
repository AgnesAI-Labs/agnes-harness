import { closeSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { defaultLoopPlugin, memoryPlugin } from '@agnes/base'
import { operations as codeOperations } from '@agnes/code'
import {
  normalizedContentHash,
  REVIEW_AFTER_MS,
  RefinementRegistry,
  type RegistryParagraph,
} from '@agnes/host-infrastructure/refinement-registry'
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

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))
const PROFILE = 'local-dev'
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

const marked = (id: string, text: string) => `<!-- refinement:${id} -->\n${text}\n<!-- /refinement:${id} -->`
const paragraph = (id: string, text: string, savedAt: number): RegistryParagraph => ({
  id,
  source: {
    sessionKey: 'earlier',
    kind: 'memory',
    entryId: `entry-${id}`,
    contentHash: normalizedContentHash(text),
    initiator: 'auto',
  },
  contentHash: normalizedContentHash(text),
  reviewAfter: savedAt + REVIEW_AFTER_MS,
  state: 'active',
  fileHash: 'f',
})

async function setUp(enabled: boolean) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-workspace-memory-')))
  dirs.push(root)
  const dataDir = join(root, 'data')
  const workspace = join(root, 'ws')
  mkdirSync(dataDir)
  mkdirSync(workspace)
  const settings = new RefinementSettingsStore(dataDir, PROFILE)
  settings.save({ enabled, mode: 'auto' }, settings.read().revision)
  const { host } = await createTestHost({
    dataDir,
    workspaceRoot: workspace,
    packageDirs: { '@agnes/base': baseDir },
    packages: { '@agnes/base': { plugins } },
    disableSessionTitle: true,
  })
  return { host, dataDir, workspace }
}

describe('workspace memory in the assembled host', () => {
  it('memory leaves out expired saved paragraphs and a session open reconciles a deleted one', async () => {
    const { host, dataDir, workspace } = await setUp(true)
    try {
      const now = Date.now()
      const registry = new RefinementRegistry(dataDir, workspace, Date.now)
      registry.update((draft) => {
        draft.paragraphs.push(
          paragraph('ra000000001', 'Fresh lesson.', now),
          paragraph('rb000000001', 'Stale lesson.', now - REVIEW_AFTER_MS - 1),
          paragraph('rc000000001', 'Deleted lesson.', now),
        )
      }, registry.read().revision)
      const memory = host.memory(workspace, 'admin')
      if (!memory) throw new Error('no memory provider assembled')
      await memory.configure({ mode: 'auto' })
      const stored = await memory.readFile('MEMORY.md')
      await memory.editFile(
        'MEMORY.md',
        `Human line.\n\n${marked('ra000000001', 'Fresh lesson.')}\n\n${marked('rb000000001', 'Stale lesson.')}\n`,
        stored.hash,
      )
      const reader = host.memory(workspace, 'reader')
      const snapshot = await reader?.snapshot(1)
      // A paragraph in force reaches the model through the task-experience snapshot, not the memory
      // note; the agent still sees it when it reads the file. An expired one is shown nowhere.
      expect(snapshot?.content).toContain('Human line.')
      expect(snapshot?.content).not.toContain('Fresh lesson.')
      expect(snapshot?.content).not.toContain('Stale lesson.')
      const seen = await reader
        ?.files(
          {
            read: async () => new Uint8Array(),
            write: async () => undefined,
            list: async () => [],
            stat: async () => ({}),
          } as never,
          { sessionKey: 'reader', turn: 1, toolUseId: 't' },
          new AbortController().signal,
          async () => ({ status: 'approved' }),
        )
        .read(`${reader.root}/MEMORY.md`)
      expect(Buffer.from(seen ?? new Uint8Array()).toString('utf8')).toContain('Fresh lesson.')
      // The person reads the raw file.
      expect((await memory.readFile('MEMORY.md')).content).toContain('Stale lesson.')

      const session = await host.createSession({ cwd: workspace })
      try {
        const deadline = Date.now() + 10_000
        const state = () => registry.read().paragraphs.find((entry) => entry.id === 'rc000000001')?.state
        while (state() === 'active' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
        expect(state()).toBe('removed')
        expect(registry.read().revocations.map((entry) => entry.action)).toEqual(['memory-deleted'])
        expect(registry.read().paragraphs.find((entry) => entry.id === 'ra000000001')?.state).toBe('active')
      } finally {
        await session.close()
      }
    } finally {
      await host.close()
    }
  })

  it('with refinement off a session open creates no registry and memory is unchanged', async () => {
    const { host, dataDir, workspace } = await setUp(false)
    try {
      const memory = host.memory(workspace, 'admin')
      if (!memory) throw new Error('no memory provider assembled')
      await memory.configure({ mode: 'auto' })
      const stored = await memory.readFile('MEMORY.md')
      await memory.editFile('MEMORY.md', 'Prefer short answers.\n', stored.hash)
      const session = await host.createSession({ cwd: workspace })
      await session.close()
      expect((await host.memory(workspace, 'reader')?.snapshot(1))?.content).toContain(
        'Prefer short answers.',
      )
      expect(existsSync(join(dataDir, 'refinement', 'workspaces'))).toBe(false)
    } finally {
      await host.close()
    }
  })
})

// The whole save-to-workspace path in an assembled host: the refine plugin's planner on a loopback
// model, Core's automatic offer, the Host's save service, registry, validity view and approvals, and
// the bundled file memory.
const PLANNER_MARK = 'You review one piece of finished agent work'
const NOTES = 'Ship the release on Friday.'
const ENTRY = 'The notes file is docs/notes.txt; there is no notes.txt at the workspace root.'
const QUOTE = 'tell me what it says'
const AGAIN = 'Read the notes again please'
const ONCE_MORE = 'And read the notes once more today'
const T0 = Date.UTC(2026, 10, 4, 9)
const DAY = 86_400_000
const E2E_PROFILE = 'workspace-save-e2e'

type Evidence = { id: string; kind: string; tool?: string; isError?: boolean; text: string }
type Session = Awaited<ReturnType<Awaited<ReturnType<typeof createTestHost>>['host']['createSession']>>
type Host = Awaited<ReturnType<typeof createTestHost>>['host']

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
const plan = (o: { edits?: unknown[]; confirmations?: unknown[]; evidenceIds: string[] }): WireReply => ({
  text: JSON.stringify({
    summary: 'Where the notes live.',
    rationale: 'The first read failed, the second worked.',
    expectedOutcome: 'The first read of the notes succeeds.',
    edits: o.edits ?? [],
    confirmations: o.confirmations ?? [],
    evidenceIds: o.evidenceIds,
  }),
})
/** One session entry, granted session level by a verbatim quote of the request and the corrected read. */
function lesson(body: unknown): WireReply {
  const evidence = evidenceOf(body)
  const failed = evidence.find((e) => e.tool === 'read' && e.isError === true)
  const fixed = evidence.find((e) => e.tool === 'read' && e.isError === false && e.text.includes(NOTES))
  const asked = evidence.find((e) => e.kind === 'user' && e.text.includes(QUOTE))
  if (!failed || !fixed || !asked) return plan({ evidenceIds: [] })
  const cited = [asked.id, failed.id, fixed.id]
  return plan({
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
    evidenceIds: cited,
  })
}
/** A confirmation of the entry by a later request, quoted word for word. */
const confirm =
  (quote: string) =>
  (body: unknown): WireReply => {
    const asked = evidenceOf(body).find((e) => e.kind === 'user' && e.text.includes(quote))
    if (!asked) return plan({ evidenceIds: [] })
    return plan({
      confirmations: [{ entryId: 'memory/notes-location', evidenceIds: [asked.id], quote }],
      evidenceIds: [asked.id],
    })
  }

/** Waits on the host's real work; the session clock may be frozen, so the deadline runs on its own. */
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
/** The user asks for a review; it is planned in the background and applied once the session is idle. */
async function refine(session: Session): Promise<void> {
  const { runId } = await requestRefinement(session as never)
  await until('the review is applied', () => {
    const run = session.state.refinementRuns.get(runId)
    if (run?.state === 'no-op' || run?.state === 'rejected')
      throw new Error(`the review ended ${run.state}: ${JSON.stringify(run)}`)
    return run?.state === 'applied'
  })
}
/** The conversation's replies for the next turn; a turn that was given none just answers. */
let script: (replies: WireReply[]) => void = () => {}
/** One session that learns the lesson and has it confirmed twice: three reviews, the third offers a save. */
async function learn(session: Session): Promise<void> {
  script([
    { toolCall: { name: 'read', args: { path: 'notes.txt' } } },
    { toolCall: { name: 'read', args: { path: 'docs/notes.txt' } } },
    { text: NOTES },
  ])
  await turn(session, `Please read notes.txt and ${QUOTE}.`)
  await refine(session)
  await turn(session, AGAIN)
  await refine(session)
  await turn(session, ONCE_MORE)
  await refine(session)
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

/** An assembled host on a loopback model, refinement on in automatic mode, workspace memory in `mode`. */
async function e2e(
  mode: 'ask' | 'auto',
  run: (t: {
    host: Host
    workspace: string
    dataDir: string
    main: () => CapturedRequest[]
  }) => Promise<void>,
) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-workspace-save-e2e-')))
  dirs.push(root)
  const dataDir = join(root, 'data')
  const workspace = join(root, 'ws')
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  writeFileSync(join(workspace, 'docs', 'notes.txt'), `${NOTES}\n`)
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
  const settings = new RefinementSettingsStore(dataDir, E2E_PROFILE)
  settings.save({ enabled: true, mode: 'auto' }, settings.read().revision)
  const queue: WireReply[] = []
  script = (replies) => {
    queue.splice(0, queue.length, ...replies)
  }
  const planner = [lesson, confirm(AGAIN), confirm(ONCE_MORE)]
  let reviews = 0
  const capture = await startWireCapture(async (body) => {
    if (JSON.stringify(body).includes(PLANNER_MARK))
      return (planner[reviews++ % planner.length] as (b: unknown) => WireReply)(body)
    return queue.shift() ?? { text: 'Done.' }
  })
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
    const { host } = await createTestHost({
      dataDir,
      workspaceRoot: workspace,
      packageDirs: { '@agnes/base': baseDir },
      packages: { '@agnes/code': { operations: codeOperations }, '@agnes/base': { plugins } },
      disableSessionTitle: true,
      profileInputs: {
        user: {
          name: E2E_PROFILE,
          provider: {
            package: '@agnes/ai',
            routes: [{ route: 'wire', api, baseUrl, credentialRef: 'secret://test/wire', models: [model] }],
          },
          adapters: { secrets: { kind: 'file', path: credentials } },
        },
      },
    })
    try {
      const admin = host.memory(workspace, 'admin')
      if (!admin) throw new Error('no memory provider assembled')
      await admin.configure({ mode })
      const stored = await admin.readFile('MEMORY.md')
      await admin.editFile('MEMORY.md', 'Human preference line.\n', stored.hash)
      await run({
        host,
        workspace,
        dataDir,
        main: () => capture.requests.filter((request) => !request.raw.includes(PLANNER_MARK)),
      })
    } finally {
      await host.close()
    }
  } finally {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    await capture.close()
  }
}

describe('saving task experience to the workspace in an assembled host', () => {
  it('a lesson confirmed twice is saved, read by the next session, left out after 30 days, and stays away once deleted', async () => {
    await e2e('auto', async ({ host, workspace, dataDir, main }) => {
      const registry = new RefinementRegistry(dataDir, workspace, Date.now)
      const memoryFile = async () =>
        (await host.memory(workspace, 'admin')?.readFile('MEMORY.md'))?.content ?? ''

      // Session 1 learns the lesson; the second confirmation saves it automatically.
      const first = await host.createSession({ cwd: workspace })
      await learn(first)
      await until('the save is recorded', () => registry.read().paragraphs.some((p) => p.state === 'active'))
      const [saved] = registry.read().paragraphs
      expect(saved).toMatchObject({ state: 'active', reviewAfter: T0 + REVIEW_AFTER_MS })
      expect(saved?.source).toMatchObject({
        sessionKey: first.key,
        entryId: 'notes-location',
        initiator: 'auto',
      })
      expect(await memoryFile()).toBe(
        `Human preference line.\n\n<!-- refinement:${saved?.id} -->\nNotes file location\n${ENTRY}\n<!-- /refinement:${saved?.id} -->\n`,
      )
      await until('the receipt reaches the session', () =>
        [...first.state.refinementSaves.values()].some((r) => r.outcome === 'saved'),
      )
      expect([...first.state.refinementSaves.values()]).toEqual([
        expect.objectContaining({ initiator: 'auto', outcome: 'saved' }),
      ])
      // No implicit hand-off: the entry stays in session 1.
      expect([...first.state.registers.harnessEntries.keys()].join(' ')).toContain('notes-location')

      // Session 2 is given it in its task-experience snapshot; the memory note carries only the rest.
      const second = await host.createSession({ cwd: workspace, key: 'second-session' })
      await turn(second, 'What do you remember about this workspace?')
      const before = main().at(-1)
      expect(before?.raw).toContain(`[memory/ws.${saved?.id} v1] (saved) Notes file location`)
      expect(latestMemoryNote(before)).not.toContain('docs/notes.txt')
      const revision = (await host.memory(workspace, 'probe-1')?.snapshot(1))?.revision

      // Past its review date the next request withdraws it; the system prompt is unchanged.
      vi.setSystemTime(T0 + REVIEW_AFTER_MS + DAY)
      await turn(second, 'And now?')
      const after = main().at(-1)
      expect(after?.raw).toContain(`[memory/ws.${saved?.id} v1] withdrawn`)
      expect(latestMemoryNote(after)).not.toContain('docs/notes.txt')
      expect(latestMemoryNote(after)).toContain('Human preference line.')
      expect(systemOf(after)).toBe(systemOf(before))
      expect((await host.memory(workspace, 'probe-2')?.snapshot(1))?.revision).not.toBe(revision)

      // The person deletes the paragraph: a third session learning the same lesson does not save it again.
      const admin = host.memory(workspace, 'admin')
      const file = await admin?.readFile('MEMORY.md')
      if (!admin || !file) throw new Error('no memory')
      await admin.editFile('MEMORY.md', 'Human preference line.\n', file.hash)
      const third = await host.createSession({ cwd: workspace, key: 'third-session' })
      await learn(third)
      await until('the automatic offer is judged', () => third.state.refinementSaves.size > 0)
      expect([...third.state.refinementSaves.values()]).toEqual([
        expect.objectContaining({ initiator: 'auto', outcome: 'refused', reason: 'user-revoked' }),
      ])
      expect(registry.read().revocations).toEqual([
        expect.objectContaining({ sessionKey: first.key, action: 'memory-deleted' }),
      ])
      expect(await memoryFile()).toBe('Human preference line.\n')
      for (const session of [first, second, third]) await session.close()
    })
  }, 120_000)

  it('under ask the save waits in the decision list and is written once approved', async () => {
    await e2e('ask', async ({ host, workspace, dataDir }) => {
      const registry = new RefinementRegistry(dataDir, workspace, Date.now)
      const session = await host.createSession({ cwd: workspace })
      await learn(session)
      await until('the save waits for approval', () =>
        registry.read().receipts.some((r) => r.outcome === 'awaiting-approval'),
      )
      expect((await host.memory(workspace, 'admin')?.readFile('MEMORY.md'))?.content).toBe(
        'Human preference line.\n',
      )
      const services = host.profileServices
      if (!services) throw new Error('no profile services')
      const decisions = await services.listDecisions({ kind: 'local' })
      const decision = decisions.find((d) => d.request.owner === 'core/refinement')
      if (!decision) throw new Error(`no task experience decision among ${JSON.stringify(decisions)}`)
      await services.answerDecision(
        {
          handle: decision.handle,
          revision: decision.revision,
          commandId: 'approve-1',
          response: { option: 'allowed-once', value: null },
        },
        { kind: 'local' },
      )
      await until('the approved save is written', () =>
        registry.read().paragraphs.some((p) => p.state === 'active'),
      )
      const content = (await host.memory(workspace, 'admin')?.readFile('MEMORY.md'))?.content ?? ''
      expect(content).toContain(`Notes file location\n${ENTRY}`)
      expect(content.startsWith('Human preference line.\n\n<!-- refinement:')).toBe(true)
      await session.close()
    })
  }, 120_000)
})
