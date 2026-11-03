import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { operations as codeOperations } from '@agnes/code'
import { CompactionRunner, refinementFacade } from '@agnes/core'
import type { HookPayloadMap } from '@agnes/extension-api'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'
import { describe, expect, it } from 'vitest'
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
  run: (session: Session, requests: CapturedRequest[], restart: () => Promise<Session>) => Promise<void>,
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
      packages: { '@agnes/code': { operations: codeOperations } },
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
      await run(session, capture.requests, restart)
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
})
