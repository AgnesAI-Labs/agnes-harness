import { MemoryStorage, SessionLogImpl } from '@agnes/core'
import { defaultIds } from '@agnes/core-common/ids'
import { ProviderError } from '@agnes/extension-api'
import {
  rpcError,
  type Actor,
  type AuthoringCandidate,
  type InferenceEvent,
  type Provider,
} from '@agnes/protocol'
import { expect, it } from 'vitest'
import {
  createFeedbackOwner,
  createFeedbackService,
  draftFeedbackSkill,
  FEEDBACK_EVENT,
  FEEDBACK_GROWTH_EVENT,
  feedbackSkillFiles,
  type FeedbackAuthority,
  type HostSession,
} from '../src/index.js'

const actor: Actor = { id: 'human', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const target = { messageSeq: 3, turn: 1 }
const signal = new AbortController().signal

it('persists feedback revisions and withdrawal in the ledger, restores them, and links only reviewed growth', async () => {
  const storage = new MemoryStorage()
  let log = await SessionLogImpl.open({
    storage,
    key: 's',
    writerRunId: 'writer',
    ttlMs: 30000,
    ids: defaultIds(),
    clock: Date.now,
  })
  await log.append([
    {
      type: 'turn/start',
      data: { turn: 1, trigger: 'prompt' },
      actor,
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
    },
    {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Summarize evidence' }] },
      actor,
      origin: 'principal',
      trust: 'untrusted',
      lane: 'main',
    },
    {
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: 'Unsupported conclusion' }], stopReason: 'end_turn' },
      actor,
      origin: 'model',
      trust: 'untrusted',
      lane: 'main',
    },
    {
      type: 'turn/end',
      data: { reason: 'completed', lastAssistantSeq: 3 },
      actor,
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
    },
  ])
  let candidate: AuthoringCandidate | undefined
  const candidates = new Map<string, AuthoringCandidate>()
  let failLink = false,
    drafts = 0
  const ports: FeedbackAuthority = {
    sessions: async () => ({ ids: ['s'], truncated: false }),
    scan: (_id, types) => log.scan({ type: [...types], order: 'asc', limit: 100 }),
    append: async (_id, type, data, author) => {
      if (type === FEEDBACK_GROWTH_EVENT && failLink) throw new Error('ledger link interrupted')
      return (
        await log.append([
          {
            type,
            data: data as never,
            actor: author,
            origin: 'system',
            trust: 'trusted',
            ignorable: true,
            lane: 'main',
          },
        ])
      ).firstSeq
    },
    now: () => '2026-10-09T00:00:00Z',
    id: (() => {
      let id = 0
      return () => `feedback-${++id}`
    })(),
    recoverCandidate: async (id, item) =>
      [...candidates.values()].find(
        (value) =>
          value.origin.sessionKey === id &&
          value.origin.feedbackId === item.id &&
          value.origin.feedbackRevision === item.revision,
      ) ?? null,
    draft: async (_id, item, evidence) => {
      drafts++
      expect(evidence.map((e) => e.seq)).toEqual([1, 2, 3, 4])
      return feedbackSkillFiles(
        {
          name: 'cite-evidence',
          description: 'Use when summarizing evidence',
          body: 'Cite observations before drawing a conclusion.',
        },
        item,
      )
    },
    candidate: async (id, item, files) => {
      candidate = {
        candidateId: 'candidate-' + item.revision.toString(16).padStart(32, '0'),
        packageId: 'feedback-skill-cite-evidence',
        candidateHash: 'sha256-' + 'b'.repeat(64),
        baseHash: null,
        reviewHash: null,
        state: 'draft',
        sourceFiles: [...files],
        files: [],
        tests: null,
        preview: null,
        installer: 'agent',
        reviewer: null,
        message: '',
        origin: {
          sessionKey: id,
          turn: 1,
          toolUseId: 'feedback:feedback-1',
          packageId: '@agnes/feedback',
          rowId: 'feedback:default',
          snapshotId: 'builtin',
          feedbackId: item.id,
          feedbackRevision: item.revision,
          messageSeq: 3,
        },
      }
      candidates.set(candidate.candidateId, candidate)
      return candidate
    },
    evidence: async (id) => {
      const saved = candidates.get(id)
      if (!saved) throw new Error('Missing candidate')
      return structuredClone(saved)
    },
  }
  let service = createFeedbackService(ports)
  const first = await service.execute(
    {
      action: 'put',
      sessionId: 's',
      target,
      rating: 'down',
      category: 'accuracy',
      note: 'Cite evidence.',
      expectedRevision: null,
    },
    actor,
    signal,
  )
  expect(first.items[0]).toMatchObject({ actor: 'human', revision: 5, withdrawn: false, candidateId: null })
  await expect(
    service.execute(
      {
        action: 'put',
        sessionId: 's',
        target,
        id: 'feedback-1',
        rating: 'up',
        category: '',
        note: '',
        expectedRevision: null,
      },
      actor,
      signal,
    ),
  ).rejects.toMatchObject({ data: { reason: 'FEEDBACK_STALE' } })
  for (const [request, author, reason] of [
    [
      { action: 'put', sessionId: 's', id: 'missing', expectedRevision: null, rating: 'down', target },
      actor,
      'FEEDBACK_NOT_FOUND',
    ],
    [
      { action: 'withdraw', sessionId: 's', id: 'feedback-1', expectedRevision: 5 },
      { ...actor, id: 'other' },
      'FEEDBACK_ACTOR_MISMATCH',
    ],
    [
      {
        action: 'put',
        sessionId: 's',
        id: 'feedback-1',
        expectedRevision: 5,
        rating: 'down',
        target: { messageSeq: 2, turn: 1 },
      },
      actor,
      'FEEDBACK_TARGET_MISMATCH',
    ],
    [
      {
        action: 'put',
        sessionId: 's',
        expectedRevision: null,
        rating: 'down',
        target: { messageSeq: 2, turn: 1 },
      },
      actor,
      'FEEDBACK_TARGET_NOT_SETTLED',
    ],
  ] as const) {
    await expect(service.execute(request, author, signal)).rejects.toMatchObject({ data: { reason } })
  }
  failLink = true
  await expect(
    service.execute(
      { action: 'generate', sessionId: 's', id: 'feedback-1', expectedRevision: 5 },
      actor,
      signal,
    ),
  ).rejects.toThrow('ledger link interrupted')
  expect(candidates.size).toBe(1)
  expect(drafts).toBe(1)
  service = createFeedbackService(ports)
  failLink = false
  const generated = await service.execute(
    { action: 'generate', sessionId: 's', id: 'feedback-1', expectedRevision: 5 },
    actor,
    signal,
  )
  expect(generated.growth[0]).toMatchObject({
    feedbackId: 'feedback-1',
    feedbackRevision: 5,
    messageSeq: 3,
    state: 'draft',
    reviewer: null,
    reviewHash: null,
    version: null,
  })
  expect(candidate?.state).toBe('draft')
  expect(candidates.size).toBe(1)
  expect(drafts).toBe(1)
  await service.execute(
    { action: 'generate', sessionId: 's', id: 'feedback-1', expectedRevision: 5 },
    actor,
    signal,
  )
  expect((await log.scan({ type: FEEDBACK_GROWTH_EVENT, limit: 100 })).length).toBe(1)
  // Publication metadata comes from the hash-checked candidate owner, never from the feedback ledger.
  const originalHash = candidate!.candidateHash
  candidate!.candidateHash = 'sha256-' + 'c'.repeat(64)
  candidate!.reviewHash = 'sha256-' + 'd'.repeat(64)
  candidate!.state = 'published'
  candidate!.reviewer = 'reviewer'
  const published = await service.execute(
    { action: 'list', hasCandidate: true, rating: 'down' },
    actor,
    signal,
  )
  expect(published.items[0]?.candidateHash).toBe(originalHash)
  expect(published.growth[0]).toMatchObject({
    candidateHash: candidate!.candidateHash,
    reviewHash: candidate!.reviewHash,
    state: 'published',
    reviewer: 'reviewer',
  })
  const origin = candidate!.origin
  candidate!.origin = { ...origin, sessionKey: 'foreign' }
  const unavailable = await service.execute({ action: 'list' }, actor, signal)
  expect(unavailable.items[0]?.note).toBe('Cite evidence.')
  expect(unavailable.growth[0]).toMatchObject({
    state: 'unavailable',
    reviewer: null,
    reviewHash: null,
    version: null,
  })
  candidate!.origin = origin
  expect((await service.execute({ action: 'list', category: 'style' }, actor, signal)).counts.down).toBe(0)
  expect(candidate?.sourceFiles.find((f) => f.path === 'SKILL.md')?.content).toContain(
    'feedback feedback-1, revision 5',
  )
  await service.execute(
    { action: 'withdraw', sessionId: 's', id: 'feedback-1', expectedRevision: 5 },
    actor,
    signal,
  )
  await log.close()
  log = await SessionLogImpl.open({
    storage,
    key: 's',
    writerRunId: 'restored',
    ttlMs: 30000,
    ids: defaultIds(),
    clock: Date.now,
  })
  service = createFeedbackService(ports)
  try {
    const restored = await service.execute({ action: 'list' }, actor, signal)
    expect(restored.items[0]).toMatchObject({ withdrawn: true, revision: 7, actor: 'human' })
    expect(restored.counts).toEqual({ up: 0, down: 0, withdrawn: 1, withCandidate: 1 })
    await expect(
      service.execute(
        { action: 'generate', sessionId: 's', id: 'feedback-1', expectedRevision: 7 },
        actor,
        signal,
      ),
    ).rejects.toMatchObject({ data: { reason: 'FEEDBACK_GROWTH_INELIGIBLE' } })
    const edited = await service.execute(
      {
        action: 'put',
        sessionId: 's',
        id: 'feedback-1',
        expectedRevision: 7,
        rating: 'up',
        category: 'do-again',
        note: 'Keep citing evidence',
      },
      actor,
      signal,
    )
    expect(edited.items[0]).toMatchObject({
      revision: 8,
      withdrawn: false,
      createdAt: first.items[0]!.createdAt,
    })
    const rows = await log.scan({ type: [FEEDBACK_EVENT, FEEDBACK_GROWTH_EVENT], order: 'asc', limit: 100 })
    expect(rows.map((row) => row.type)).toEqual([
      FEEDBACK_EVENT,
      FEEDBACK_GROWTH_EVENT,
      FEEDBACK_EVENT,
      FEEDBACK_EVENT,
    ])
    expect((rows[0]!.data as { note: string }).note).toBe('Cite evidence.')
    const repeated = await service.execute(
      { action: 'generate', sessionId: 's', id: 'feedback-1', expectedRevision: 8 },
      actor,
      signal,
    )
    expect(repeated.growth.find((g) => g.feedbackRevision === 8)).toMatchObject({
      state: 'draft',
      reviewHash: null,
      reviewer: null,
    })
    // Session feedback is persisted without starting growth, even with the do-again category.
    const sessionFeedback = await service.execute(
      {
        action: 'put',
        sessionId: 's',
        target: { messageSeq: null, turn: null },
        rating: 'up',
        expectedRevision: null,
      },
      actor,
      signal,
    )
    const item = sessionFeedback.items.find((item) => item.target.messageSeq === null)!
    expect(item).toMatchObject({ note: '', category: '', actor: 'human' })
    await expect(
      service.execute(
        { action: 'generate', sessionId: 's', id: item.id, expectedRevision: item.revision },
        actor,
        signal,
      ),
    ).rejects.toMatchObject({ data: { reason: 'FEEDBACK_GROWTH_INELIGIBLE' } })
  } finally {
    await log.close()
  }
})

it('uses only local scripted inference, rejects invalid drafts, and never executes tools or applies changes', async () => {
  const feedback = {
    id: 'feedback-1',
    sessionId: 's',
    target,
    rating: 'down' as const,
    category: 'accuracy' as const,
    note: 'Cite evidence',
    actor: 'human',
    createdAt: '2026-10-09T00:00:00Z',
    updatedAt: '2026-10-09T00:00:00Z',
    revision: 5,
    withdrawn: false,
    candidateId: null,
    candidateHash: null,
  }
  let baseUrl = 'https://example.invalid/v1'
  let doneReason: Extract<InferenceEvent, { type: 'done' }>['reason'] = 'stop'
  const requests: Parameters<Provider['infer']>[0][] = []
  const provider: Provider = {
    models: () => [
      {
        id: 'script',
        name: 'Script',
        route: 'local',
        api: 'openai-completions',
        baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
        toolCallFormats: ['native'],
        thinkingReplay: 'drop',
        contract_id: null,
      },
    ],
    async *infer(request, options): AsyncGenerator<InferenceEvent> {
      requests.push(request)
      expect(options.toolNames).toEqual([])
      expect(options.retry).toBe(false)
      yield {
        type: 'text_delta',
        delta: JSON.stringify({
          name: 'cite-evidence',
          description: 'When reporting observations',
          body: 'Cite evidence.',
        }),
      }
      yield { type: 'done', reason: doneReason }
    },
  }
  // A narrow fixture deliberately has no turn, tool, memory-edit or package-publication methods.
  const session = {
    preset: { model: { route: { primary: 'local' }, id: { primary: 'script' } } },
    d: { provider, contract: { contract_id: null, parser_version: '1' } },
  } as unknown as HostSession
  await expect(draftFeedbackSkill(session, feedback, [], signal)).rejects.toMatchObject({
    data: { reason: 'FEEDBACK_LOCAL_MODEL_REQUIRED' },
  })
  expect(requests).toEqual([])
  baseUrl = 'http://127.0.0.1:12345/v1'
  const files = await draftFeedbackSkill(session, feedback, [], signal)
  expect(files.find((file) => file.path === 'SKILL.md')?.content).toContain('assistant ledger sequence 3')
  const manifest = JSON.parse(files.find((file) => file.path === 'package.json')!.content)
  expect(manifest.agnes).toMatchObject({
    kinds: ['skills'],
    plugins: [{ id: 'ext:feedback-skill-cite-evidence/main', inject: ['skills'] }],
  })
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0])).toContain('Cite evidence')
  doneReason = 'length'
  await expect(draftFeedbackSkill(session, feedback, [], signal)).rejects.toMatchObject({
    data: { reason: 'FEEDBACK_DRAFT_INCOMPLETE' },
  })
  doneReason = 'stop'
  const aborted = new AbortController()
  aborted.abort()
  await expect(draftFeedbackSkill(session, feedback, [], aborted.signal)).rejects.toThrow()
  expect(requests).toHaveLength(2)
  for (const name of ['bad-', 'bad--name', '../escape'])
    expect(() =>
      feedbackSkillFiles({ name, description: 'When needed', body: 'Use evidence' }, feedback),
    ).toThrow()
  const closing = {
    closingOrClosed: false,
    preset: { model: { route: { primary: 'local' }, id: { primary: 'script' } } },
    d: {
      provider: {
        models: () => provider.models(),
        async *infer(): AsyncGenerator<InferenceEvent> {
          closing.closingOrClosed = true
          yield {
            type: 'text_delta',
            delta: JSON.stringify({
              name: 'cite-evidence',
              description: 'When reporting observations',
              body: 'Cite evidence.',
            }),
          }
          yield { type: 'done', reason: 'stop' }
        },
      },
      contract: { contract_id: null, parser_version: '1' },
    },
  }
  await expect(
    draftFeedbackSkill(closing as unknown as HostSession, feedback, [], signal),
  ).rejects.toMatchObject({ data: { reason: 'FEEDBACK_SESSION_CLOSED' } })
  expect(requests).toHaveLength(2)
})

function bareAuthority(patch: Partial<FeedbackAuthority> = {}): FeedbackAuthority {
  return {
    sessions: async () => ({ ids: ['s'], truncated: false }),
    scan: async () => [],
    append: async () => 1,
    draft: async () => [],
    recoverCandidate: async () => null,
    candidate: async () => {
      throw new Error('candidate')
    },
    evidence: async () => {
      throw new Error('evidence')
    },
    now: () => '2026-10-09T00:00:00Z',
    id: () => 'feedback-1',
    ...patch,
  }
}

it('fails a list closed when any owned session refuses the read', async () => {
  const scanned: string[] = []
  const service = createFeedbackService(
    bareAuthority({
      sessions: async () => ({ ids: ['owned', 'foreign'], truncated: false }),
      scan: async (id) => {
        scanned.push(id)
        if (id === 'foreign') throw rpcError('CAPABILITY_DENIED')
        return []
      },
    }),
  )
  await expect(service.execute({ action: 'list' }, actor, signal)).rejects.toMatchObject({
    data: { code: 'CAPABILITY_DENIED' },
  })
  expect(scanned).toEqual(['owned', 'foreign'])
})

it('opens one instance per bind and keeps profiles, actors, and in-flight reads apart', async () => {
  const written: string[] = []
  const scanned: string[] = []
  const alpha = createFeedbackOwner('alpha')
  const beta = createFeedbackOwner('beta')
  const left = new AbortController()
  const right = new AbortController()
  const other = new AbortController()
  try {
    const first = await alpha.bind({
      actor,
      signal: left.signal,
      sessionId: 's',
      authority: bareAuthority({
        id: () => 'left',
        append: async (_id, _type, data) => {
          written.push(String((data as { id?: unknown }).id))
          return written.length
        },
      }),
    })
    const second = await alpha.bind({
      actor,
      signal: right.signal,
      sessionId: 's',
      authority: bareAuthority({
        id: () => 'right',
        append: async (_id, _type, data) => {
          written.push(String((data as { id?: unknown }).id))
          return written.length
        },
      }),
    })
    expect(second).not.toBe(first)
    const put = {
      action: 'put' as const,
      sessionId: 's',
      target: { messageSeq: null, turn: null },
      rating: 'up' as const,
      expectedRevision: null,
    }
    await first.execute(put, actor, left.signal)
    await second.execute(put, actor, right.signal)
    expect(written).toEqual(['left', 'right'])
    const forged = await alpha.bind({
      actor,
      signal: other.signal,
      sessionId: 's',
      authority: bareAuthority({
        append: async () => {
          written.push('forged')
          return 1
        },
      }),
    })
    await expect(
      forged.execute(put, { ...actor, id: 'other' }, other.signal),
    ).rejects.toMatchObject({ data: { reason: 'FEEDBACK_ACTOR_MISMATCH' } })
    expect(written).toEqual(['left', 'right'])
    const betaSignal = new AbortController()
    const betaInstance = await beta.bind({
      actor,
      signal: betaSignal.signal,
      authority: bareAuthority({
        sessions: async () => ({ ids: ['beta-only'], truncated: false }),
        scan: async (id) => {
          scanned.push(id)
          return []
        },
      }),
    })
    await betaInstance.execute({ action: 'list' }, actor, betaSignal.signal)
    expect(scanned).toEqual(['beta-only'])
    let release: (value?: void) => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const liveSignal = new AbortController()
    const live = await alpha.bind({
      actor,
      signal: liveSignal.signal,
      authority: bareAuthority({
        scan: async () => {
          await gate
          return []
        },
      }),
    })
    const pending = live.execute({ action: 'list' }, actor, liveSignal.signal)
    const closing = alpha.close()
    release()
    await expect(pending).resolves.toMatchObject({ items: [] })
    expect(liveSignal.signal.aborted).toBe(false)
    await closing
    await expect(
      alpha.bind({ actor, signal: new AbortController().signal, authority: bareAuthority() }),
    ).rejects.toBeInstanceOf(ProviderError)
  } finally {
    await alpha.close().catch(() => undefined)
    await beta.close().catch(() => undefined)
  }
})
