import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { defaultLoopPlugin, memoryPlugin } from '@agnes/base'
import { operations as codeOperations } from '@agnes/code'
import { CompactionRunner, refinementFacade } from '@agnes/core'
import type { HookPayloadMap } from '@agnes/extension-api'
import { normalizedContentHash, RefinementRegistry } from '@agnes/host-infrastructure/refinement-registry'
import { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it, vi } from 'vitest'
import {
  type CapturedRequest,
  createTestHost,
  expectExtends,
  startWireCapture,
  type WireApi,
} from '../../testkit/index.js'

const baseDir = fileURLToPath(new URL('../../../base/', import.meta.url))
const apis: readonly WireApi[] = ['anthropic-messages', 'openai-completions', 'openai-responses']
// The note's first line as it reaches the wire inside a JSON string.
const MARKER = '[task-experience]\\n'
const ENTRY_TEXT = 'run pnpm build before the tests'
// The entry block as it reaches the wire inside a JSON string: one envelope under the request's
// nonce, its id naming the block's content rather than a sequence number, the entry inside it.
const ENVELOPED_ENTRY =
  /<untrusted id=\\"[0-9a-f]{32,64}-n[0-9a-f]{16}-0\\" bytes=\\"\d+\\">[^<]*run pnpm build before the tests[^<]*<\/untrusted id=\\"/

type Session = Awaited<ReturnType<Awaited<ReturnType<typeof createTestHost>>['host']['createSession']>>

async function turn(session: Session, prompt: string) {
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text: prompt }],
    actor: session.d.actor,
    kind: 'prompt',
  })
  await expect(
    session.run({ until: 'turn-end', signal: new AbortController().signal }),
  ).resolves.toMatchObject({ reason: 'completed' })
}

const memoryPlugins = [
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

/** The system prompt bytes of a wire request, whatever field the API keeps them in. */
const systemOf = (request: CapturedRequest): string => {
  const body = request.body as { system?: unknown; instructions?: unknown; messages?: { role?: string }[] }
  const leading = (body.messages ?? []).filter(
    (message) => message.role === 'system' || message.role === 'developer',
  )
  return JSON.stringify([body.system ?? null, body.instructions ?? null, leading])
}
/** The latest memory note of a wire request (each turn carries its own; earlier ones stay as history). */
const memoryNote = (request: CapturedRequest): string => {
  const from = request.raw.lastIndexOf('memory:index')
  return from < 0 ? '' : request.raw.slice(from, request.raw.indexOf('"', from))
}
/** Seeds the registry of a workspace with one saved paragraph; set once the data directory exists. */
let seed: (root: string) => void = () => {
  throw new Error('seed before use')
}

/** How many task-experience notes one wire request carries. */
const notesIn = (request: CapturedRequest | undefined): number => request?.raw.split(MARKER).length ?? 1

/**
 * Saves two entries the way the model's direct proposal does, through the session's refinement
 * facade, while the session is idle so they apply at once. The switch the facade reads is on only for
 * this call; whether the entries are delivered is the separate `refinementEnabled` read.
 */
async function applyEntries(session: Session) {
  const wired = session.d.refinement
  session.d.refinement = {
    settings: () => ({ enabled: true, mode: 'manual', revision: 'wire-fixture' }),
    planner: () => undefined,
  }
  try {
    const outcome = await refinementFacade(session).propose({
      rationale: 'fixture',
      evidenceSeqs: [1],
      edits: [
        { op: 'upsert', kind: 'memory', id: 'build', title: 'Build first', content: ENTRY_TEXT },
        {
          op: 'upsert',
          kind: 'skill',
          id: 'release',
          title: 'Release notes',
          content: 'Draft release notes from the merged pull requests.\nStep one: SKILL-BODY-ONLY',
        },
      ],
    })
    const runId = 'runId' in outcome ? outcome.runId : ''
    expect(session.state.refinementRuns.get(runId)?.state).toBe('applied')
  } finally {
    if (wired) session.d.refinement = wired
    else delete session.d.refinement
  }
}

function compactPlan(payload: HookPayloadMap['before_compact']) {
  const nodes = payload.getSurface()
  const first = nodes[0]
  const end = nodes.at(-2)
  const kept = nodes.at(-1)
  if (!first || !end || !kept) throw new Error('fixture needs two completed turns')
  return {
    keepFromSeq: kept.seq,
    summarizeRange: [first.seq, end.seq] as [number, number],
    prompts: { system: 'Summarize the ledger safely.', history: 'Summarize the main range.' },
    maxTokens: 96,
    details: { readFiles: [], modifiedFiles: [] },
  }
}

async function fixture(
  api: WireApi,
  run: (
    session: Session,
    requests: CapturedRequest[],
    restart: () => Promise<Session>,
    host: Awaited<ReturnType<typeof createTestHost>>['host'],
  ) => Promise<void>,
  before?: (dataDir: string) => Promise<void> | void,
  /** Assemble the default loop and the bundled file memory as the only base plugins. */
  withMemory = false,
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-wire-refinement-'))
  const credentials = join(dataDir, 'credentials')
  createPrivateDirectorySync(credentials)
  createPrivateDirectorySync(join(credentials, 'test'))
  const credential = createPrivateFileSync(join(credentials, 'test', 'wire'))
  try {
    writeFileSync(credential, 'synthetic-wire-capture')
  } finally {
    closeSync(credential)
  }
  const capture = await startWireCapture(() => ({ text: 'fixture reply' }))
  try {
    const baseUrl = capture.baseUrl(api)
    const model = fakeModel({ route: 'wire', id: 'fixture', api, baseUrl, contextWindow: 100_000 })
    const hostOptions = {
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      packages: {
        '@agnes/code': { operations: codeOperations },
        ...(withMemory ? { '@agnes/base': { plugins: memoryPlugins } } : {}),
      },
      disableSessionTitle: true,
      profileInputs: {
        user: {
          name: 'wire-refinement',
          provider: {
            package: '@agnes/ai',
            routes: [{ route: 'wire', api, baseUrl, credentialRef: 'secret://test/wire', models: [model] }],
          },
          adapters: { secrets: { kind: 'file' as const, path: credentials } },
        },
      },
    }
    await before?.(dataDir)
    let current = await createTestHost(hostOptions)
    const key = 'wire-refinement'
    // Closes the Host and opens the same session in a new one: a cold process with no memo.
    const restart = async () => {
      await current.host.close()
      current = await createTestHost(hostOptions)
      return current.host.createSession({ cwd: dataDir, key })
    }
    try {
      const session = await current.host.createSession({ cwd: dataDir, key })
      await run(session, capture.requests, restart, current.host)
    } finally {
      await current.host.close()
    }
  } finally {
    await capture.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

describe('refinement experience on the provider wire', () => {
  it.each(apis)('%s sends no experience note while refinement is off', async (api) => {
    await fixture(api, async (session, requests) => {
      await applyEntries(session)
      await turn(session, 'First question')
      await turn(session, 'Second question')
      expect(requests).toHaveLength(2)
      for (const request of requests) {
        expect(notesIn(request)).toBe(1)
        expect(request.raw).not.toContain(ENTRY_TEXT)
      }
    })
  })

  it.each(apis)(
    '%s turning it on reaches the sessions opened after it; one already open keeps its bytes, also reopened',
    async (api) => {
      let dataDir = ''
      const switchTo = (enabled: boolean) => {
        const settings = new RefinementSettingsStore(dataDir, 'wire-refinement')
        settings.save({ enabled, mode: 'manual' }, settings.read().revision)
      }
      await fixture(
        api,
        async (open, requests, restart, host) => {
          await turn(open, 'First question')
          switchTo(true)
          await turn(open, 'Second question')
          const fresh = await host.createSession({ cwd: open.d.cwd, key: 'wire-refinement-after' })
          await turn(fresh, 'First question')
          switchTo(false)
          await turn(fresh, 'Second question')
          switchTo(true)
          const reopened = await restart()
          await turn(reopened, 'Third question')
          expect(requests).toHaveLength(5)
          const [first, second, newFirst, newSecond, third] = requests
          if (!first || !second || !newFirst || !newSecond || !third)
            throw new Error('missing loopback request')
          // The session open before the switch went on: the same prefix, no refinement tool and no note,
          // and so after a restart, since its first requests went out without task experience.
          expectExtends(first, second)
          expectExtends(second, third)
          for (const request of [first, second, third]) {
            expect(notesIn(request)).toBe(1)
            expect(request.raw).not.toContain('harness_')
          }
          // The session opened after it: the tools and the experience note.
          expect(newFirst.raw).toContain('harness_refine')
          expect(notesIn(newFirst)).toBe(2)
          // Turning it off stops it at once: one notice, and the tool list stays as it was.
          expectExtends(newFirst, newSecond)
          expect(newSecond.raw).toContain('Task experience is switched off')
        },
        (dir) => {
          dataDir = dir
        },
      )
    },
  )

  it.each(apis)('%s turns with no change keep a byte-identical prefix', async (api) => {
    await fixture(api, async (session, requests) => {
      // Stands in for the Host switch, which the refinement settings port supplies.
      session.d.refinementEnabled = () => true
      await applyEntries(session)
      await turn(session, 'First question')
      await turn(session, 'Second question')
      await turn(session, 'Third question')
      expect(requests).toHaveLength(3)
      const [first, second, third] = requests
      if (!first || !second || !third) throw new Error('missing loopback request')
      expectExtends(first, second)
      expectExtends(second, third)
      // One snapshot, sent with the first request and then only carried as history.
      for (const request of requests) expect(notesIn(request)).toBe(2)
      expect(first.raw).toContain(ENTRY_TEXT)
      // The entry text is untrusted content: once on the wire, and only inside its envelope.
      expect(first.raw.split(ENTRY_TEXT)).toHaveLength(2)
      expect(first.raw).toMatch(ENVELOPED_ENTRY)
      expect(first.raw).toContain('[skill/release v1]')
      // A skill is listed by its metadata line; its body stays behind harness_inspect.
      expect(first.raw).toContain('Draft release notes from the merged pull requests.')
      expect(first.raw).not.toContain('SKILL-BODY-ONLY')
    })
  })

  it.each(apis)('%s a Host restart keeps the experience prefix byte-identical', async (api) => {
    await fixture(api, async (session, requests, restart) => {
      session.d.refinementEnabled = () => true
      await applyEntries(session)
      await turn(session, 'First question')
      await turn(session, 'Second question')
      const reopened = await restart()
      reopened.d.refinementEnabled = () => true
      await turn(reopened, 'Third question')
      expect(requests).toHaveLength(3)
      const [first, second, third] = requests
      if (!first || !second || !third) throw new Error('missing loopback request')
      expectExtends(first, second)
      // A new process renders the committed note from the ledger alone, to the bytes first sent.
      expectExtends(second, third)
      expect(notesIn(third)).toBe(2)
      expect(third.raw).toMatch(ENVELOPED_ENTRY)
    })
  })

  it.each(apis)('%s a snapshot is rebuilt after compaction and delivered once', async (api) => {
    await fixture(api, async (session, requests) => {
      session.d.refinementEnabled = () => true
      session.compaction = new CompactionRunner({
        plan: async (payload) => compactPlan(payload),
        onCompact: async () => undefined,
      })
      await applyEntries(session)
      await turn(session, 'First question')
      await turn(session, 'Second question')
      await session.requestCompaction({ actor: session.d.actor, admissionId: 'wire-refinement' })
      await session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(requests).toHaveLength(3)
      await turn(session, 'Third question')
      await turn(session, 'Fourth question')
      expect(requests).toHaveLength(5)
      const [, , , third, fourth] = requests
      if (!third || !fourth) throw new Error('missing post-compaction request')
      expect(notesIn(third)).toBe(2)
      expect(third.raw).toContain(ENTRY_TEXT)
      expect(third.raw).toMatch(ENVELOPED_ENTRY)
      expectExtends(third, fourth)
      expect(notesIn(fourth)).toBe(2)
      const rebuilds = await session.d.log.scan({ type: 'x/core/refinement-prefix-change', limit: 10 })
      expect(rebuilds).toHaveLength(2)
    })
  })

  it.each(apis)(
    '%s a saved paragraph past its review date leaves only the memory note, and is recorded as a prefix change',
    async (api) => {
      const T0 = Date.UTC(2026, 10, 4, 9)
      const DAY = 86_400_000
      const LESSON = 'Saved lesson: run pnpm build before the tests.'
      const ID = 'ra000000001'
      let switchTo: (enabled: boolean) => void = () => undefined
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(T0)
      try {
        await fixture(
          api,
          async (session, requests, _restart, host) => {
            // A session opened while the switch was off runs without task experience: the saved paragraph
            // is in neither its memory note nor any note of its own, and nothing is recorded for it.
            switchTo(false)
            const older = await host.createSession({ cwd: session.d.cwd, key: 'wire-refinement-older' })
            switchTo(true)
            const root = session.workspaceRoot
            const admin = host.memory(root, 'admin')
            if (!admin) throw new Error('no memory provider assembled')
            await admin.configure({ mode: 'auto' })
            seed(root)
            const stored = await admin.readFile('MEMORY.md')
            await admin.editFile(
              'MEMORY.md',
              `Human preference line.\n\n<!-- refinement:${ID} -->\n${LESSON}\n<!-- /refinement:${ID} -->\n`,
              stored.hash,
            )
            const probe = host.memory(root, 'probe')
            const before = (await probe?.snapshot(1))?.revision
            await turn(session, 'First question')
            await turn(older, 'First question')
            vi.setSystemTime(T0 + 2 * DAY)
            const after = (await host.memory(root, 'probe-later')?.snapshot(1))?.revision
            await turn(session, 'Second question')
            await turn(older, 'Second question')
            expect(requests).toHaveLength(4)
            const [first, olderFirst, second, olderSecond] = requests
            if (!olderFirst || !olderSecond) throw new Error('missing loopback request')
            expect(olderFirst.raw).not.toContain(LESSON)
            expect(olderSecond.raw).not.toContain(LESSON)
            expect(await older.d.log.scan({ type: 'x/core/refinement-prefix-change', limit: 10 })).toEqual([])
            if (!first || !second) throw new Error('missing loopback request')
            // The paragraph reaches the model in the task-experience snapshot while it is in force, never
            // in the memory note, and is withdrawn once its date passed.
            expect(first.raw).toContain(`/ws.${ID} v1] (saved) ${LESSON}`)
            expect(memoryNote(first)).not.toContain(LESSON)
            expect(memoryNote(second)).not.toContain(LESSON)
            expect(memoryNote(second)).toContain('Human preference line.')
            expect(second.raw).toContain(`/ws.${ID} v1] withdrawn`)
            // Only the memory note changes: the system prompt keeps its bytes, the memory revision moves.
            expect(systemOf(second)).toBe(systemOf(first))
            expect(after).not.toBe(before)
            const changes = (
              await session.d.log.scan({ type: 'x/core/refinement-prefix-change', limit: 10 })
            ).map((row) => row.data as { reason?: string })
            // The experience snapshot of the first request, then the saved paragraph leaving the note.
            expect(changes.map((data) => data.reason)).toEqual(['experience-snapshot', 'workspace-memory'])
            expect(changes[1]).toEqual({ reason: 'workspace-memory', inForce: 0, expired: 1 })
          },
          (dataDir) => {
            switchTo = (enabled) => {
              const settings = new RefinementSettingsStore(dataDir, 'wire-refinement')
              settings.save({ enabled, mode: 'manual' }, settings.read().revision)
            }
            switchTo(true)
            seed = (root) => {
              const registry = new RefinementRegistry(dataDir, root, Date.now)
              registry.update((draft) => {
                draft.paragraphs.push({
                  id: ID,
                  source: {
                    sessionKey: 'earlier',
                    kind: 'memory',
                    entryId: 'build',
                    contentHash: normalizedContentHash(LESSON),
                    initiator: 'auto',
                  },
                  contentHash: normalizedContentHash(LESSON),
                  reviewAfter: T0 + DAY,
                  state: 'active',
                  fileHash: 'f',
                })
              }, registry.read().revision)
            }
          },
          true,
        )
      } finally {
        vi.useRealTimers()
      }
    },
  )
})
