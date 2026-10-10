import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel } from '@agnes/ai/testkit'
import { operations as codeOperations } from '@agnes/code'
import { projectUI, scanAll } from '@agnes/core'
import { actor, fakeProvider, sent, textTurn, toolTurn } from '@agnes/core/testkit'
import { assertRuntimeRecord, type JsonValue, type RuntimeRecord } from '@agnes/jev-runtime'
import type { EventEnvelope, InferenceEvent, Provider, SessionPreviewParams, UINode } from '@agnes/protocol'
import { assistantHistoryContent } from '@agnes/runtime-jev'
import { expect, it, vi } from 'vitest'
import { createJevLedger } from '../src/runtime/jev-ledger.js'
import type { JevLoopOptions } from '../src/runtime/jev-loop.js'
import { createTestHost } from '../testkit/index.js'

function runtimeRecord(data: unknown): RuntimeRecord {
  if (!data || typeof data !== 'object' || !('record' in data)) throw new Error('Missing runtime record')
  const record = data.record
  assertRuntimeRecord(record)
  return record
}

function respondingJev(onInvoke = () => {}, purposeConfidence = 1): JevLoopOptions {
  return {
    decision: {
      backend: 'jev',
      endpoint: 'https://jev.invalid/v1',
      model: 'jev-test',
      transport: {
        async invoke({ questions }) {
          onInvoke()
          const answers: Record<string, JsonValue> = {}
          for (const [name, value] of Object.entries(questions)) {
            const criteria = (value as { criteria?: Record<string, unknown> }).criteria
            if (!criteria || (name !== 'purpose' && name !== 'operation_RESPOND')) continue
            const confidence = name === 'purpose' ? purposeConfidence : 1
            const choices = Object.keys(criteria)
            answers[name] = {
              type: 'choice',
              choice: 'RESPOND',
              confidence,
              probabilities: Object.fromEntries(
                choices.map((key) => [
                  key,
                  choices.length === 1
                    ? 1
                    : key === 'RESPOND'
                      ? confidence
                      : (1 - confidence) / (choices.length - 1),
                ]),
              ),
            }
          }
          return { output: { answers }, observedModel: 'jev-test' }
        },
      },
    },
  }
}

it.each(['subagent_spawn', 'ask_user_question', 'todo', 'find', 'tool_search'])(
  'mounts only the six JevLoop tools and refuses disabled %s proposals',
  async (disabled) => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-jev-tool-mount-'))
    const provider = fakeProvider([toolTurn(disabled, {}), textTurn('Recovered with the available tools.')])
    const jev = respondingJev(() => {}, 0.1)
    const invoke = jev.decision.transport.invoke
    jev.decision.transport.invoke = async (input, options) => {
      for (const [name, question] of Object.entries(input.questions)) {
        if (!name.startsWith('operation_')) continue
        const criteria = (question as { criteria: Record<string, unknown> }).criteria
        for (const excluded of ['subagent_spawn', 'ask_user_question', 'todo', 'find', 'tool_search'])
          expect(criteria).not.toHaveProperty(excluded)
      }
      return invoke(input, options)
    }
    const { host } = await createTestHost({
      dataDir: root,
      provider,
      disableSessionTitle: true,
      jev,
      packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    })
    const expected = ['edit', 'grep', 'ls', 'read', 'shell', 'write']
    try {
      const native = await host.createSession({ cwd: root, key: 'native-tools', runtime: 'native' })
      const nativeNames = native
        .currentTools()
        .list()
        .map((tool) => tool.name)
        .sort()
      expect(nativeNames).toContain(disabled)
      const session = await host.createSession({ cwd: root, key: 'jev-tools', runtime: 'jevloop' })
      expect(
        session
          .currentTools()
          .list()
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(expected)
      expect(
        native
          .currentTools()
          .list()
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(nativeNames)
      const nativePrepared = await host.prepareSessionConfiguration(native.key)
      const jevPrepared = await host.prepareSessionConfiguration(session.key)
      expect(jevPrepared.configuration.fingerprints.tools).toBe(
        nativePrepared.configuration.fingerprints.tools,
      )
      expect(jevPrepared.configuration.effective.tools.count).toBe(6)
      expect(nativePrepared.configuration.effective.tools.count).toBe(nativeNames.length)
      expect(jevPrepared.configuration.effective.tools.digest).not.toBe(
        nativePrepared.configuration.effective.tools.digest,
      )
      expect(jevPrepared.configuration.runtimeConfig).toMatchObject({
        toolMount: {
          policy: 'agnes-jev-basic-tools-v1',
          names: expected,
          baselineDigest: nativePrepared.configuration.fingerprints.tools,
          mountedDigest: jevPrepared.configuration.effective.tools.digest,
        },
      })
      await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'Use available tools.' }] })
      const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(outcome.reason).toBe('completed')
      expect(provider.requests.length).toBeGreaterThan(0)
      for (const request of provider.requests)
        expect(request.tools.map((tool) => tool.name).sort()).toEqual(expected)
      const records = (
        await scanAll((query) => session.scan(query), { type: 'runtime/record', toSeq: session.lastSeq })
      ).map((row) => runtimeRecord(row.data))
      for (const record of records) {
        if (record.kind === 'environment.observed')
          expect(record.catalog.map((tool) => tool.name).sort()).toEqual(expected)
        if (record.kind === 'action.intended') expect(record.intent.tool).not.toBe(disabled)
      }
      expect(await session.scan({ type: 'tool/call', limit: 20 })).toHaveLength(0)
      expect(host.questions.pending(session.key)).toHaveLength(0)
      await session.close()
      const reopened = await host.createSession({ cwd: root, key: 'jev-tools', runtime: 'jevloop' })
      expect(
        reopened
          .currentTools()
          .list()
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(expected)
      expect(
        native
          .currentTools()
          .list()
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(nativeNames)
      await reopened.close()
      await native.close()
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('appends changed Jev runtime facts without rewriting the language prefix or retaining stale decision state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-jev-context-'))
  const models = [
    fakeModel({
      route: 'gw',
      id: 'first-model',
      reasoning: true,
      thinkingLevelMap: { high: 'high', low: 'low' },
    }),
    fakeModel({
      route: 'gw',
      id: 'second-model',
      reasoning: true,
      thinkingLevelMap: { high: 'high', low: 'low' },
    }),
  ]
  const provider = Object.assign(
    fakeProvider([textTurn('first'), textTurn('second'), textTurn('third'), textTurn('reopened')]),
    {
      models: () => models,
    },
  )
  // The inspected simple RESPOND case scored 0.65: DSH's admitted defaults allow the answer path.
  const jev = respondingJev(undefined, 0.65)
  jev.decision = { ...jev.decision, endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' }
  const { host } = await createTestHost({
    dataDir: root,
    provider,
    profileInputs: {
      user: {
        name: 'local-dev',
        provider: {
          package: '@agnes/ai',
          adapters: ['@agnes/ai'],
          routes: [{ route: 'gw', api: 'openai-completions', baseUrl: 'https://example.invalid/v1', models }],
        },
      },
    },
    packages: { '@agnes/code': { operations: codeOperations } },
    disableSessionTitle: true,
    jev,
  })
  try {
    const session = await host.createSession({ cwd: root, runtime: 'jevloop' })
    let now = Date.UTC(2026, 0, 2)
    session.d.clock = () => now
    const ask = async (text: string) => {
      await session.enqueue('next-turn', { actor, content: [{ type: 'text', text }] })
      const result = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      const records = await session.scan({ type: 'runtime/record', order: 'desc', limit: 2 })
      expect(result.reason, JSON.stringify(records.map((row) => row.data))).toBe('completed')
    }
    await session.setModel({ slot: 'primary', route: 'gw', model: 'first-model', thinking: 'high' })
    await ask('first task')
    now = Date.UTC(2026, 0, 3)
    await session.setModel({ slot: 'primary', route: 'gw', model: 'second-model', thinking: 'low' })
    await ask('second task')
    await session.setModel({ slot: 'primary', route: 'gw', model: 'second-model', thinking: null })
    await ask('third task')
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests.map((request) => request.sampling?.thinking)).toEqual(['high', 'low', undefined])
    for (const [index, request] of provider.requests.entries()) {
      expect(request.system).toBe('')
      const facts = request.messages.flatMap((message) =>
        message.role === 'user'
          ? message.content.flatMap((block) =>
              block.type === 'text' ? [...block.text.matchAll(/\[runtime context\]\n([^\n]+)/g)] : [],
            )
          : [],
      )
      expect(facts).toHaveLength(index === 0 ? 1 : 2)
      const serialized = facts.at(-1)?.[1]
      if (!serialized) throw new Error('Missing runtime facts')
      const context = JSON.parse(serialized)
      expect(context).toMatchObject({
        environment: {
          sessionKey: session.key,
          cwd: session.d.cwd,
          model: index === 0 ? 'first-model' : 'second-model',
          route: 'gw',
          slot: 'primary',
          preset: session.preset.name,
          disclosure: session.preset.disclosure,
          date: index === 0 ? '2026-01-02' : '2026-01-03',
          enforcement: expect.any(String),
        },
        tools: { complete: expect.any(String) },
      })
      expect(request.messages.filter((message) => message.role === 'system')).toHaveLength(1)
      const previous = provider.requests[index - 1]
      if (previous) {
        expect(request.system).toBe(previous.system)
        expect(request.tools).toEqual(previous.tools)
        // The purpose instruction is appended per request and is not retained history, so the
        // comparable prefix is the previous request without its trailing instruction message.
        const retained = previous.messages.slice(0, -1)
        expect(JSON.stringify(request.messages.slice(0, retained.length))).toBe(JSON.stringify(retained))
      }
    }
    const rows = await scanAll((query) => session.scan(query), { toSeq: session.lastSeq })
    expect(rows.filter((row) => row.type === 'user/message')).toHaveLength(3)
    const decisions = rows
      .filter((row) => row.type === 'runtime/record')
      .map((row) => runtimeRecord(row.data))
      .filter((record) => record.kind === 'model.requested' && record.call.purpose === 'decision')
    expect(decisions).toHaveLength(3)
    expect(
      rows
        .filter((row) => row.type === 'runtime/record')
        .map((row) => runtimeRecord(row.data))
        .some((record) => record.kind === 'model.requested' && record.call.purpose === 'arbitration'),
    ).toBe(false)
    for (const [index, record] of decisions.entries()) {
      if (record.kind !== 'model.requested') throw new Error('Expected model request')
      expect(record.call.input).not.toHaveProperty('pricing')
      expect(record.call.input).toMatchObject({
        state: {
          environment: {
            runtimeContext: {
              environment: {
                cwd: session.d.cwd,
                date: index === 0 ? '2026-01-02' : '2026-01-03',
                enforcement: expect.any(String),
              },
            },
          },
        },
      })
      const state = (
        record.call.input as { state: { environment: Record<string, unknown>; history: unknown } }
      ).state
      expect(state.environment.runtimeContext).not.toHaveProperty('environment.sessionKey')
      expect(state.environment.runtimeContext).not.toHaveProperty('environment.model')
      expect(JSON.stringify(state.history)).not.toContain('[runtime context]')
      expect(JSON.stringify(state)).toContain(
        'You do not claim a task is done until the evidence for it exists in this session.',
      )
      expect(record.call.pricing).toMatchObject({
        route: 'jev',
        model: 'jev-latest',
        admittedAt: Date.UTC(2026, 0, index === 0 ? 2 : 3),
        policy: { perMillion: { inputUncached: 0.042, output: 0 } },
      })
    }
    const contexts = rows
      .filter((row) => row.type === 'runtime/record')
      .map((row) => runtimeRecord(row.data))
      .filter((record) => record.kind === 'input.admitted' && record.input.source === 'runtime-context')
    expect(contexts).toHaveLength(2)
    for (const record of contexts)
      if (record.kind === 'input.admitted')
        expect(record.input.snapshot?.codec).toBe('agnes-jev-runtime-context-v1')
    const languageRequests = rows
      .filter((row) => row.type === 'runtime/record')
      .map((row) => runtimeRecord(row.data))
      .filter((record) => record.kind === 'model.requested' && record.call.purpose === 'answer')
    expect(
      languageRequests.map((record) =>
        record.kind === 'model.requested'
          ? (record.call.input as { request: { sampling?: { thinking?: string } } }).request.sampling
              ?.thinking
          : null,
      ),
    ).toEqual(['high', 'low', undefined])
    await session.setModel({ slot: 'primary', route: 'gw', model: 'second-model', thinking: 'high' })
    const key = session.key
    await session.close()
    const reopened = await host.createSession({ key, cwd: root })
    reopened.d.clock = () => Date.UTC(2026, 0, 4)
    await reopened.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'restored settings' }] })
    expect((await reopened.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(provider.requests[3]?.sampling?.thinking).toBe('high')
    const previous = provider.requests[2]
    const restored = provider.requests[3]
    if (!previous || !restored) throw new Error('Missing requests around session reopen')
    expect(restored.system).toBe(previous.system)
    expect(restored.tools).toEqual(previous.tools)
    // Same retained-prefix rule as above: the trailing per-request instruction is not history.
    const retained = previous.messages.slice(0, -1)
    expect(JSON.stringify(restored.messages.slice(0, retained.length))).toBe(JSON.stringify(retained))
    expect(JSON.stringify(restored.messages.slice(retained.length))).toContain('2026-01-04')
    await reopened.close()
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('anchors real captured answer previews through Host and SDK, adopts once, and clears cancellation/restart leftovers', async () => {
  const capture = JSON.parse(
    await readFile(new URL('../../core/test/fixtures/jev-real-answer-preview.json', import.meta.url), 'utf8'),
  ) as {
    previews: SessionPreviewParams[]
    events: EventEnvelope[]
    firstProjection: { nodes: UINode[] }
  }
  // Cross-package acceptance uses the SDK's declared public entry, without a Host production dependency.
  const { PreviewMerger, applyUITimelinePatch } = await import(
    new URL('../../sdk/src/index.node.ts', import.meta.url).href
  )
  const before = new PreviewMerger()
  for (const preview of capture.previews) before.add(preview)
  expect(
    before
      .apply(capture.firstProjection)
      .nodes.filter((node: UINode) => node.kind === 'assistant' && node.streaming),
  ).toEqual([])
  const final = capture.events.find((row) => row.type === 'assistant/message')?.data as {
    content: { type: string; text: string }[]
  }
  const answer = final.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  const settlement = capture.events
    .map((row) => (row.type === 'runtime/record' ? runtimeRecord(row.data) : undefined))
    .find(
      (record) =>
        record?.kind === 'model.settled' &&
        record.settlement.output &&
        typeof record.settlement.output === 'object' &&
        !Array.isArray(record.settlement.output) &&
        record.settlement.output.kind === 'answer',
    )
  if (settlement?.kind !== 'model.settled' || !settlement.settlement.usage)
    throw new Error('Missing captured answer usage')
  const script: InferenceEvent[] = [
    sent(),
    ...capture.previews.map(
      (preview): InferenceEvent => ({
        type: preview.stream === 'text' ? 'text_delta' : 'thinking_delta',
        delta: preview.delta,
      }),
    ),
    settlement.settlement.usage as unknown as InferenceEvent,
    { type: 'done', reason: 'stop' },
  ]
  let release = () => {}
  let reached = () => {}
  let gate = Promise.resolve()
  let paused = Promise.resolve()
  const pause = () => {
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    paused = new Promise<void>((resolve) => {
      reached = resolve
    })
  }
  const tape = fakeProvider([script])
  let rejectAnswer = false
  const provider: Provider = {
    models: tape.models,
    async *infer(request, options) {
      let chunks = 0
      for await (const event of tape.infer(request, options)) {
        yield rejectAnswer && event.type === 'done' ? { ...event, reason: 'length' as const } : event
        if ((event.type === 'text_delta' || event.type === 'thinking_delta') && ++chunks === 1) {
          reached()
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(options.signal.reason)
            options.signal.addEventListener('abort', abort, { once: true })
            gate.then(resolve).finally(() => options.signal.removeEventListener('abort', abort))
          })
        }
      }
    },
  }
  const root = await mkdtemp(join(tmpdir(), 'agnes-answer-preview-'))
  const { host } = await createTestHost({
    dataDir: root,
    provider,
    disableSessionTitle: true,
    jev: respondingJev(),
  })
  try {
    const session = await host.createSession({ cwd: root, runtime: 'jevloop' })
    const merger = new PreviewMerger()
    const seen: { effectId: string; stream: string; offset: number; delta: string }[] = []
    session.onPreview((preview) => {
      seen.push(preview)
      merger.add(preview)
    })
    pause()
    await session.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: 'Return the captured answer' }],
    })
    const running = session.run({ until: 'turn-end', signal: new AbortController().signal })
    await paused
    const live = await session.projectUI()
    expect(live.nodes.filter((node) => node.kind === 'assistant')).toMatchObject([
      { text: '', streaming: true },
    ])
    expect(merger.apply(live).nodes.filter((node: UINode) => node.kind === 'assistant')).toMatchObject([
      { text: '', thinking: capture.previews[0]?.delta, streaming: true },
    ])
    expect(
      await scanAll((query) => session.scan(query), { type: 'assistant/message', toSeq: session.lastSeq }),
    ).toEqual([])
    release()
    expect((await running).reason).toBe('completed')
    expect(seen).toHaveLength(719)
    const completed = await session.projectUI()
    const update = await session.projectUIPatch(live.upto)
    expect(update.kind).toBe('patch')
    if (update.kind !== 'patch') throw new Error('Expected live presentation patch')
    expect(
      applyUITimelinePatch({ ...live, generation: 1 }, { ...update.patch, generation: 1 }).nodes,
    ).toEqual(completed.nodes)
    expect(completed.nodes.filter((node) => node.kind === 'assistant')).toMatchObject([
      { text: answer, streaming: false },
    ])
    merger.apply(completed)
    expect(merger.text(seen[0]?.effectId)).toBeUndefined()
    const events = await scanAll((query) => session.scan(query), { toSeq: session.lastSeq })
    const replayed = await projectUI(events, { sessionKey: session.key })
    expect(replayed.nodes).toEqual(completed.nodes)
    expect(replayed.turns).toEqual(completed.turns)
    const anchor = events.find((row) => row.type === 'assistant/output')
    expect(events.filter((row) => row.type === 'assistant/message')).toHaveLength(1)
    expect(events.find((row) => row.type === 'assistant/message')?.sourceEventSeqs).toContain(anchor?.seq)
    const key = session.key
    if (!anchor) throw new Error('Missing durable preview anchor')
    await session.close()
    const reopened = await host.createSession({ cwd: root, key })
    expect(
      (await reopened.projectUI()).nodes.filter((node) => node.kind === 'assistant' && node.streaming),
    ).toEqual([])
    expect(
      await scanAll((query) => reopened.scan(query), { type: 'assistant/message', toSeq: reopened.lastSeq }),
    ).toHaveLength(1)
    await reopened.close()

    const recovery = await host.createSession({
      cwd: root,
      key: 'agnes:jev-answer-preview-fixture',
      runtime: 'jevloop',
    })
    await recovery.d.log.append(
      capture.events
        .filter((row) => row.seq > 1 && row.seq <= 47)
        .map((row) => {
          const { seq: _seq, id: _id, ts: _ts, v: _v, ...event } = row
          return event
        }),
    )
    await recovery.d.log.append([
      recovery.ev(
        'assistant/output',
        {
          state: 'started',
          effectId: 'jev-answer:orphaned-process',
          chars: { text: 0, thinking: 0 },
          estimatedTokens: 0,
        },
        { origin: 'model', sourceEventSeqs: [47] },
      ),
    ])
    await recovery.close()
    const recovered = await host.createSession({ cwd: root, key: recovery.key })
    expect(
      (await recovered.projectUI()).nodes.filter((node) => node.kind === 'assistant' && node.streaming),
    ).toEqual([])
    expect([...recovered.state.assistantOutputs.values()].some((output) => !output.closed)).toBe(false)
    expect(
      await scanAll((query) => recovered.scan(query), {
        type: 'assistant/message',
        toSeq: recovered.lastSeq,
      }),
    ).toEqual([])
    await recovered.close()

    const cancelled = await host.createSession({
      cwd: root,
      key: 'agnes:preview-cancelled',
      runtime: 'jevloop',
    })
    pause()
    await cancelled.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'Cancel this answer' }] })
    const controller = new AbortController()
    const cancelRun = cancelled.run({ until: 'turn-end', signal: controller.signal })
    await paused
    const cancellingLive = await cancelled.projectUI()
    controller.abort(new Error('Captured stream cancellation'))
    await cancelRun
    expect(cancelled.previewSnapshot()).toEqual([])
    expect((await cancelled.projectUI()).nodes.filter((node) => node.kind === 'assistant')).toMatchObject([
      { text: '', streaming: false },
    ])
    expect(
      await scanAll((query) => cancelled.scan(query), {
        type: 'assistant/message',
        toSeq: cancelled.lastSeq,
      }),
    ).toEqual([])
    const cancelledEvents = await scanAll((query) => cancelled.scan(query), { toSeq: cancelled.lastSeq })
    const cancelledReplay = await projectUI(cancelledEvents, { sessionKey: cancelled.key })
    const cancelledLive = await cancelled.projectUI()
    const cancelUpdate = await cancelled.projectUIPatch(cancellingLive.upto)
    if (cancelUpdate.kind !== 'patch') throw new Error('Expected cancellation presentation patch')
    expect(
      applyUITimelinePatch({ ...cancellingLive, generation: 1 }, { ...cancelUpdate.patch, generation: 1 })
        .nodes,
    ).toEqual(cancelledLive.nodes)
    expect(cancelledReplay.nodes).toEqual(cancelledLive.nodes)
    expect(cancelledReplay.turns).toEqual(cancelledLive.turns)
    await cancelled.close()

    rejectAnswer = true
    pause()
    release()
    const rejected = await host.createSession({
      cwd: root,
      key: 'agnes:preview-rejected',
      runtime: 'jevloop',
    })
    await rejected.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: 'Incomplete captured answer' }],
    })
    await rejected.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(
      await scanAll((query) => rejected.scan(query), { type: 'assistant/message', toSeq: rejected.lastSeq }),
    ).toEqual([])
    expect(
      (await rejected.projectUI()).nodes
        .filter((node) => node.kind === 'assistant')
        .every((node) => node.text === '' && !node.streaming),
    ).toBe(true)
    expect(rejected.previewSnapshot()).toEqual([])
    await rejected.close()
  } finally {
    release()
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses stream/output answer forks on write and reopen, restores verified thinking, and keeps snapshot-less legacy readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-answer-settlement-'))
  const { host } = await createTestHost({
    dataDir: root,
    disableSessionTitle: true,
    jev: {
      decision: {
        backend: 'jev',
        endpoint: 'https://unused.invalid',
        model: 'unused',
        transport: {
          invoke() {
            throw new Error('No model calls allowed')
          },
        },
      },
    },
  })
  const thinking = Array.from({ length: 45 }, (_, index) => ({
    type: 'thinking_delta' as const,
    delta: `t${index}`,
  }))
  const thought = thinking.map((event) => event.delta).join('')
  const answerRequest = (sessionKey: string, id: string): RuntimeRecord =>
    runtimeRecord({
      record: {
        version: 1,
        id,
        turn: `${sessionKey}:main:1`,
        step: 'step:9000',
        attempt: 'attempt:9000',
        kind: 'model.requested',
        call: {
          purpose: 'answer',
          backend: 'agnes-provider',
          endpoint: 'gw',
          requestedModel: 'm1',
          codec: 'agnes-language-v1',
          inputCursor: '0',
          input: {
            request: {
              kind: 'inference',
              sessionKey,
              slot: 'primary',
              route: 'gw',
              model: 'm1',
              contractId: null,
              system: '',
              messages: [{ role: 'user', content: [{ type: 'text', text: 'Answer from evidence.' }] }],
              tools: [],
              derivedHash: 'a'.repeat(64),
            },
            requestNote: 'Answer from evidence.',
          },
        },
      },
    })
  const answerSettlement = (
    requested: string,
    id: string,
    sessionKey: string,
    settlement: {
      output: JsonValue
      snapshot?: { codec: string; response: JsonValue }
    },
  ): RuntimeRecord =>
    ({
      version: 1,
      id,
      turn: `${sessionKey}:main:1`,
      step: 'step:9000',
      attempt: 'attempt:9000',
      kind: 'model.settled',
      requested,
      settlement,
    }) as RuntimeRecord
  try {
    const forked = await host.createSession({ cwd: root, runtime: 'jevloop' })
    await forked.d.log.append([forked.ev('turn/start', { turn: 1, trigger: 'prompt' })])
    const forkedLedger = await createJevLedger(forked)
    await forkedLedger.commit(answerRequest(forked.key, 'record:9001'))
    await expect(
      forkedLedger.commit(
        answerSettlement('record:9001', 'record:9002', forked.key, {
          output: { kind: 'answer', content: [{ kind: 'text', text: 'OUTPUT_B_NOT_IN_STREAM' }] },
          snapshot: {
            codec: 'agnes-inference-v1',
            response: {
              events: [
                { type: 'text_delta', delta: 'STREAM_A' },
                { type: 'done', reason: 'stop' },
              ],
            },
          },
        }),
      ),
    ).rejects.toThrow('Completed Agnes answer lacks its native model stream')
    expect(
      await scanAll((query) => forked.scan(query), { type: 'assistant/message', toSeq: forked.lastSeq }),
    ).toEqual([])
    await forked.close()

    const matched = await host.createSession({ cwd: root, key: 'agnes:answer-match', runtime: 'jevloop' })
    await matched.d.log.append([matched.ev('turn/start', { turn: 1, trigger: 'prompt' })])
    const matchedLedger = await createJevLedger(matched)
    await matchedLedger.commit(answerRequest(matched.key, 'record:9001'))
    await matchedLedger.commit(
      answerSettlement('record:9001', 'record:9002', matched.key, {
        output: { kind: 'answer', content: [{ kind: 'text', text: 'STREAM_A' }] },
        snapshot: {
          codec: 'agnes-inference-v1',
          response: {
            events: [
              ...thinking,
              { type: 'text_delta', delta: 'STREAM_A' },
              { type: 'done', reason: 'stop' },
            ],
          },
        },
      }),
    )
    expect(
      (
        await scanAll((query) => matched.scan(query), { type: 'assistant/message', toSeq: matched.lastSeq })
      ).map((row) => row.data),
    ).toEqual([{ content: [{ type: 'text', text: 'STREAM_A' }], stopReason: 'end_turn' }])
    const matchedKey = matched.key
    await matched.close()
    const reopened = await host.createSession({ cwd: root, key: matchedKey })
    const restored = await createJevLedger(reopened)
    const restoredSettled = (await restored.read())
      .map((entry) => entry.record)
      .find((record) => record.kind === 'model.settled')
    if (restoredSettled?.kind !== 'model.settled') throw new Error('Missing restored settlement')
    expect(assistantHistoryContent(restoredSettled.settlement)).toEqual([
      { type: 'thinking', text: thought },
      { type: 'text', text: 'STREAM_A' },
    ])
    await reopened.close()

    const poisoned = await host.createSession({ cwd: root, key: 'agnes:answer-poison', runtime: 'jevloop' })
    await poisoned.d.log.append([
      poisoned.ev('turn/start', { turn: 1, trigger: 'prompt' }),
      poisoned.ev('runtime/record', {
        runtime: poisoned.runtimeIdentity,
        record: answerRequest(poisoned.key, 'record:9001'),
      }),
      poisoned.ev('runtime/record', {
        runtime: poisoned.runtimeIdentity,
        record: answerSettlement('record:9001', 'record:9002', poisoned.key, {
          output: { kind: 'answer', content: [{ kind: 'text', text: 'OUTPUT_B_NOT_IN_STREAM' }] },
          snapshot: {
            codec: 'agnes-inference-v1',
            response: {
              events: [
                { type: 'text_delta', delta: 'STREAM_A' },
                { type: 'done', reason: 'stop' },
              ],
            },
          },
        }),
      }),
    ])
    const poisonedKey = poisoned.key
    await poisoned.close()
    await expect(host.createSession({ cwd: root, key: poisonedKey })).rejects.toThrow(
      'Completed Agnes answer lacks its native model stream',
    )

    const legacy = await host.createSession({ cwd: root, key: 'agnes:answer-legacy', runtime: 'jevloop' })
    await legacy.d.log.append([
      legacy.ev('turn/start', { turn: 1, trigger: 'prompt' }),
      legacy.ev('runtime/record', {
        runtime: legacy.runtimeIdentity,
        record: answerRequest(legacy.key, 'record:66'),
      }),
      legacy.ev('runtime/record', {
        runtime: legacy.runtimeIdentity,
        record: answerSettlement('record:66', 'record:67', legacy.key, {
          output: { kind: 'answer', content: [{ kind: 'text', text: 'legacy portable answer' }] },
        }),
      }),
    ])
    const legacyKey = legacy.key
    await legacy.close()
    const reopenedLegacy = await host.createSession({ cwd: root, key: legacyKey })
    const legacyLedger = await createJevLedger(reopenedLegacy)
    const legacySettled = (await legacyLedger.read())
      .map((entry) => entry.record)
      .find((record) => record.kind === 'model.settled')
    if (legacySettled?.kind !== 'model.settled') throw new Error('Missing legacy settlement')
    expect(assistantHistoryContent(legacySettled.settlement)).toEqual([
      { type: 'text', text: 'legacy portable answer' },
    ])
    await reopenedLegacy.close()
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('runs the selected Jev owner through Host and preserves it across reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-loop-'))
  const provider = fakeProvider([textTurn('Jev accepted answer'), textTurn('Second session answer')])
  let decisions = 0
  const { host } = await createTestHost({
    dataDir: root,
    provider,
    disableSessionTitle: true,
    jev: respondingJev(() => decisions++),
  })
  try {
    expect(host.runtimeCatalog().find((item) => item.id === 'jevloop')?.available).toBe(true)
    const session = await host.createSession({ cwd: root, runtime: 'jevloop' })
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'Say hello' }] })
    const queued = session.latest('inbox')
    const cancelled = new AbortController()
    cancelled.abort(new Error('Cancelled before claiming the queued input'))
    expect((await session.run({ until: 'turn-end', signal: cancelled.signal })).reason).toBe('aborted')
    expect(session.latest('inbox')).toEqual(queued)
    expect(session.lastTurnNumber()).toBe(0)
    expect(provider.requests).toHaveLength(0)
    expect(decisions).toBe(0)
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    const events = await scanAll((query) => session.scan(query), { toSeq: session.lastSeq })
    expect(events.filter((row) => row.type === 'runtime/record').length).toBeGreaterThan(0)
    expect(events.some((row) => row.type === 'op.state')).toBe(false)
    expect(events.filter((row) => row.type === 'assistant/message').map((row) => row.data)).toEqual([
      { content: [{ type: 'text', text: 'Jev accepted answer' }], stopReason: 'end_turn' },
    ])
    const costs = events.filter((row) => row.type === 'cost/ledger')
    expect(costs).toHaveLength(1)
    const second = await host.createSession({ cwd: root, key: 'agnes:jev-cost-second', runtime: 'jevloop' })
    await second.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'Second input' }] })
    await second.run({ until: 'turn-end', signal: new AbortController().signal })
    const secondCosts = await scanAll((query) => second.scan(query), {
      type: 'cost/ledger',
      toSeq: second.lastSeq,
    })
    expect(secondCosts).toHaveLength(1)
    if (!secondCosts[0] || !costs[0]) throw new Error('Both sessions must have durable cost rows')
    expect((secondCosts[0].data as { effectId: string }).effectId).not.toBe(
      (costs[0].data as { effectId: string }).effectId,
    )
    await second.d.log.append([
      second.ev('turn/start', { turn: second.lastTurnNumber() + 1, trigger: 'prompt' }),
    ])
    const beforeAbortDecisions = decisions
    const abortReceipt = await second.abort(actor)
    expect(abortReceipt.alreadyTerminal).toBe(false)
    expect(second.state.openTurn.has(second.lane)).toBe(false)
    await second.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(provider.requests).toHaveLength(2)
    expect(decisions).toBe(beforeAbortDecisions)
    const aborts = await scanAll((query) => second.scan(query), { type: 'turn/end', toSeq: second.lastSeq })
    expect(aborts.at(-1)?.data).toMatchObject({ reason: 'aborted' })
    await second.close()
    const key = session.key
    await session.close()
    const reopened = await host.createSession({ cwd: root, key })
    expect(reopened.runtimeIdentity).toEqual({ id: 'jevloop', version: '1' })
    expect(reopened.runtimeState().phase).toBe('idle')
    await reopened.close()
    await expect(host.createSession({ cwd: root, key, runtime: 'native' })).rejects.toThrow(/runtime/i)
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps captured unresolved effects parked when recovering a cancelled turn', async () => {
  const captured = JSON.parse(
    await readFile(new URL('./fixtures/jev-real-unresolved-recovery.json', import.meta.url), 'utf8'),
  ) as { records: RuntimeRecord[] }
  const root = await mkdtemp(join(tmpdir(), 'agnes-cancelled-unknown-'))
  const provider = fakeProvider([])
  const { host } = await createTestHost({
    dataDir: root,
    provider,
    disableSessionTitle: true,
    jev: respondingJev(),
  })
  try {
    const session = await host.createSession({ cwd: root, runtime: 'jevloop' })
    const records = JSON.parse(
      JSON.stringify(captured.records).replaceAll('agnes:captured-unknown', session.key),
    ) as RuntimeRecord[]
    const unresolved = records.find(
      (record) => record.kind === 'action.settled' && record.effect === 'unknown',
    )
    expect(unresolved).toMatchObject({ kind: 'action.settled', effect: 'unknown' })
    await session.d.log.append([
      session.ev('turn/start', { turn: 1, trigger: 'prompt' }),
      ...records.map((record) => session.ev('runtime/record', { runtime: session.runtimeIdentity, record })),
      session.ev('runtime/cancel', {
        runtime: session.runtimeIdentity,
        turnId: `${session.key}:main:1`,
        by: actor,
      }),
    ])
    const key = session.key
    await session.close()
    const reopened = await host.createSession({ cwd: root, key })
    await reopened.resume()
    expect(reopened.runtimeState().phase).toBe('parked')
    expect(reopened.state.openTurn.has(reopened.lane)).toBe(false)
    expect((await reopened.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'blocked',
    )
    expect(provider.requests).toHaveLength(0)
    const after = await scanAll((query) => reopened.scan(query), {
      type: 'runtime/record',
      toSeq: reopened.lastSeq,
    })
    expect(
      after.map((row) => runtimeRecord(row.data)).some((record) => record.kind === 'action.resolved'),
    ).toBe(false)
    await reopened.close()
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['preflight-refusal', 'partial-write', 'closed-turn', 'closed-cancel', 'shell-exit'] as const)(
  'continues the real Jev Host task after a builtin operation failure: %s',
  async (mode) => {
    const workspace = await mkdtemp(join(tmpdir(), 'agnes-jev-file-recovery-'))
    await writeFile(join(workspace, 'target.ts'), 'old')
    const provider = fakeProvider(
      mode === 'shell-exit'
        ? [
            toolTurn('shell', { command: 'exit 1' }),
            toolTurn('edit', { path: 'target.ts', edits: [{ oldText: 'old', newText: 'fixed' }] }),
            textTurn('Finished after correcting the failed command.'),
          ]
        : mode !== 'preflight-refusal'
          ? [
              toolTurn('write', { path: 'target.ts', content: 'intended' }),
              toolTurn('read', { path: 'target.ts' }),
              toolTurn('edit', { path: 'target.ts', edits: [{ oldText: 'par', newText: 'fixed' }] }),
              textTurn('Finished after inspecting and repairing the current file.'),
            ]
          : [
              toolTurn('edit', { path: 'target.ts', edits: [{ oldText: 'missing', newText: 'fixed' }] }),
              toolTurn('edit', { path: 'target.ts', edits: [{ oldText: 'old', newText: 'fixed' }] }),
              textTurn('Finished after correcting the refused edit.'),
            ],
    )
    const { host } = await createTestHost({
      dataDir: workspace,
      packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base/', import.meta.url)) },
      provider,
      disableSessionTitle: true,
      approval: async () => 'allowed-once',
      ...(mode === 'shell-exit'
        ? {
            seams: {
              sandbox: {
                exec: async () => ({
                  code: 1,
                  stdout: 'compile failed',
                  stderr: '',
                  truncated: false,
                  timedOut: false,
                }),
              },
            },
          }
        : {}),
      jev: { ...respondingJev(() => {}, 0.8), config: { escalateBelow: 0.9 } },
    })
    try {
      const session = await host.createSession({ cwd: workspace, runtime: 'jevloop' })
      let fileFailed = false
      let paused = false
      if (mode.startsWith('closed-')) {
        const hooks = session.hooks
        const beforeStep = hooks.beforeStep.bind(hooks)
        const beforeStepWithPause: typeof hooks.beforeStep = async (input) => {
          if (fileFailed && !paused) {
            paused = true
            return { block: true, reason: 'synthetic recovery pause' }
          }
          return beforeStep(input)
        }
        const port = new Proxy(hooks, {
          get(target, key) {
            if (key === 'beforeStep') return beforeStepWithPause
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        Object.defineProperty(session, 'hooks', { configurable: true, get: () => port })
      }
      if (mode !== 'preflight-refusal' && mode !== 'shell-exit') {
        const port = session.d.workspaceInvocation
        if (!port) throw new Error('Missing workspace invocation')
        let fail = true
        session.d.workspaceInvocation = {
          run: (invoke) =>
            port.run(async (view) => {
              const fs = view.fs()
              return invoke({
                ...view,
                fs: () => ({
                  ...fs,
                  async write(path, bytes) {
                    if (fail) {
                      fail = false
                      fileFailed = true
                      await fs.write(path, new TextEncoder().encode('par'))
                      throw new Error('synthetic partial write')
                    }
                    return fs.write(path, bytes)
                  },
                }),
              })
            }),
        }
      }
      await session.enqueue('next-turn', {
        actor,
        content: [{ type: 'text', text: 'Repair target.ts so it contains fixed.' }],
      })
      if (mode.startsWith('closed-')) {
        const first = await session.run({ until: 'turn-end', signal: new AbortController().signal })
        expect(first.reason, JSON.stringify({ fileFailed, paused })).toBe('blocked')
        expect(session.state.openTurn.has(session.lane)).toBe(false)
      }
      if (mode === 'closed-cancel') {
        const count = provider.requests.length
        expect((await session.abort(actor)).seq).not.toBeNull()
        const key = session.key
        await session.close()
        const reopened = await host.createSession({ key, cwd: workspace })
        expect((await reopened.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
          'blocked',
        )
        expect(provider.requests).toHaveLength(count)
        expect(await reopened.scan({ type: 'turn/start', limit: 100 })).toHaveLength(1)
        const records = (
          await scanAll((query) => reopened.scan(query), { type: 'runtime/record', toSeq: reopened.lastSeq })
        ).map((row) => runtimeRecord(row.data))
        expect(records.some((record) => record.kind === 'action.resolved')).toBe(false)
        await reopened.close()
        return
      }
      const result = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      const records = (
        await scanAll((query) => session.scan(query), { type: 'runtime/record', toSeq: session.lastSeq })
      ).map((row) => runtimeRecord(row.data))
      expect(result.reason, JSON.stringify(records.findLast((record) => record.kind === 'run.stopped'))).toBe(
        'completed',
      )
      expect(await readFile(join(workspace, 'target.ts'), 'utf8')).toBe('fixed')
      const actions = records.filter((record) => record.kind === 'action.settled')
      expect(actions[0]).toMatchObject({
        effect:
          mode === 'shell-exit' ? 'acknowledged' : mode !== 'preflight-refusal' ? 'unknown' : 'not_applied',
      })
      const resolutions = records.filter((record) => record.kind === 'action.resolved')
      expect(resolutions).toHaveLength(mode !== 'preflight-refusal' && mode !== 'shell-exit' ? 1 : 0)
      if (mode !== 'preflight-refusal' && mode !== 'shell-exit') {
        expect(resolutions[0]).toMatchObject({
          resolution: 'reconciled_state',
          actor: 'host:effect-recovery',
        })
        expect(
          provider.requests[1]?.tools.some((tool) => ['write', 'edit', 'shell'].includes(tool.name)),
        ).toBe(false)
        expect(
          records.filter((record) => record.kind === 'action.intended' && record.intent.tool === 'write'),
        ).toHaveLength(1)
      }
      if (mode === 'shell-exit') {
        expect(actions[0]).toMatchObject({ outcome: { kind: 'error' } })
        expect(
          records.filter((record) => record.kind === 'action.intended' && record.intent.tool === 'shell'),
        ).toHaveLength(1)
        expect(
          records.some((record) => record.kind === 'action.settled' && record.effect === 'unknown'),
        ).toBe(false)
      }
      if (mode === 'closed-turn') {
        const bindings = await session.scan({ type: 'x/host/jev-loop/turn-decision', limit: 100 })
        expect(bindings.at(-1)?.data).toMatchObject({ turn: 2, runtimeTurn: 1 })
        expect(new Set(records.map((record) => record.turn))).toEqual(
          new Set([`${session.key}:${session.lane}:1`]),
        )
        expect(await session.scan({ type: 'user/message', limit: 100 })).toHaveLength(1)
      }
      await session.close()
    } finally {
      await host.close()
      await rm(workspace, { recursive: true, force: true })
    }
  },
)

it('offers persisted root facts, phase-bound tools and nested write verification through the real Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-loop-root-candidates-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'a.txt'), 'actual disk evidence')
  await mkdir(join(workspace, 'child'))
  await mkdir(join(workspace, '.git'))
  const written = 'actual nested disk evidence\n'
  const provider = fakeProvider([
    toolTurn('write', { path: 'child/result.txt', content: written }),
    textTurn('Answer after reading back'),
  ])
  let decisions = 0
  const jev = respondingJev()
  jev.decision.transport.invoke = async ({ questions }) => {
    const decision = decisions++
    const first = decision === 0
    if (first) {
      expect(questions.binding_read).toBeDefined()
      for (const phase of ['INSPECT', 'VERIFY']) {
        const criteria = (questions[`operation_${phase}`] as { criteria: Record<string, unknown> }).criteria
        expect(criteria).not.toHaveProperty('write')
        expect(criteria).not.toHaveProperty('edit')
        for (const name of ['read', 'grep', 'ls']) expect(criteria).toHaveProperty(name)
      }
      const act = (questions.operation_ACT as { criteria: Record<string, unknown> }).criteria
      expect(act).toHaveProperty('write')
      expect(act).toHaveProperty('edit')
      for (const name of ['read', 'grep', 'ls']) expect(act).not.toHaveProperty(name)
    }
    const answers: Record<string, JsonValue> = {}
    for (const [name, value] of Object.entries(questions)) {
      const criteria = (value as { criteria?: Record<string, unknown> }).criteria
      if (!criteria) continue
      let selected: string | undefined
      if (name === 'purpose') selected = ['INSPECT', 'ACT', 'VERIFY', 'RESPOND'][decision] ?? 'RESPOND'
      else if (name.startsWith('operation_'))
        selected = name === 'operation_RESPOND' ? 'RESPOND' : name === 'operation_ACT' ? 'write' : 'read'
      else if (name === 'binding_write') selected = 'LLM_PARAMETERS'
      else if (name === 'binding_read') {
        expect(criteria.LLM_PARAMETERS).toBeDefined()
        selected = Object.keys(criteria).find(
          (key) =>
            key !== 'LLM_PARAMETERS' &&
            String(criteria[key]).includes(decision >= 2 ? 'result.txt' : 'a.txt'),
        )
        if (first || decision === 2) expect(selected).toBeDefined()
        selected ??= 'LLM_PARAMETERS'
      } else continue
      answers[name] = {
        type: 'choice',
        choice: selected as string,
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(criteria).map((key) => [key, key === selected ? 1 : 0]),
        ),
      }
    }
    return { output: { answers }, observedModel: 'jev-test' }
  }
  const { host } = await createTestHost({
    dataDir: workspace,
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base/', import.meta.url)) },
    provider,
    disableSessionTitle: true,
    approval: async () => 'allowed-once',
    jev,
  })
  try {
    const session = await host.createSession({ cwd: workspace, runtime: 'jevloop' })
    const realRead = session.currentTools().snapshot(session.lastSeq).byName.get('read')
    expect(realRead?.source).toMatchObject({ source: 'agnes/tools-core', trust: 'builtin' })
    expect(realRead?.executionDomain).toBe('workspace')
    await session.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: 'Read the root text file' }],
    })
    const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const records = (
      await scanAll((query) => session.scan(query), { type: 'runtime/record', toSeq: session.lastSeq })
    ).map((event) => runtimeRecord(event.data))
    expect(outcome.reason, JSON.stringify(records.findLast((record) => record.kind === 'run.stopped'))).toBe(
      'completed',
    )
    const observed = records.findIndex(
      (record) =>
        record.kind === 'resource.observed' &&
        record.resource !== null &&
        typeof record.resource === 'object' &&
        !Array.isArray(record.resource) &&
        record.resource.kind === 'jev.workspace-directory.v1',
    )
    expect(observed).toBeGreaterThanOrEqual(0)
    expect(observed).toBeLessThan(records.findIndex((record) => record.kind === 'model.requested'))
    expect(JSON.stringify(records[observed])).not.toContain('.git')
    expect(records.find((record) => record.kind === 'model.requested')).toMatchObject({
      call: {
        input: {
          questions: {
            binding_read: {
              criteria: {
                LLM_PARAMETERS: expect.any(String),
                c1: expect.stringContaining('a.txt'),
              },
            },
          },
        },
      },
    })
    expect(records.filter((record) => record.kind === 'action.intended')).toMatchObject([
      { intent: { tool: 'read', arguments: { path: join(session.d.cwd, 'a.txt') } } },
      { intent: { tool: 'write', arguments: { path: 'child/result.txt', content: written } } },
      {
        intent: {
          tool: 'read',
          arguments: { path: join(session.d.cwd, 'child/result.txt'), offset: 1, limit: 200 },
        },
      },
    ])
    expect(records.find((record) => record.kind === 'action.settled')).toMatchObject({
      outcome: { kind: 'success', value: { codec: 'agnes-host-tool-fact-v1', tool: 'read' } },
    })
    expect(JSON.stringify(records.find((record) => record.kind === 'action.settled'))).toContain(
      'actual disk evidence',
    )
    expect(
      records.filter((record) => record.kind === 'model.requested').map((record) => record.call.purpose),
    ).toEqual(['decision', 'decision', 'parameters', 'decision', 'decision', 'answer'])
    expect(await readFile(join(workspace, 'child/result.txt'), 'utf8')).toBe(written)
    const writeIntent = records.find(
      (record) => record.kind === 'action.intended' && record.intent.tool === 'write',
    )
    if (writeIntent?.kind !== 'action.intended') throw new Error('Missing write')
    const writtenRecord = records.find(
      (record) => record.kind === 'action.settled' && record.intentId === writeIntent.intent.id,
    )
    expect(writtenRecord).toMatchObject({
      outcome: {
        kind: 'success',
        value: {
          codec: 'agnes-host-tool-fact-v1',
          tool: 'write',
          target: { path: join(session.d.cwd, 'child/result.txt') },
          write: { acknowledged: true, size: new TextEncoder().encode(written).length },
        },
      },
    })
    const verifyDecision = records.find(
      (record) => record.kind === 'decision.selected' && record.phase === 'VERIFY',
    )
    if (verifyDecision?.kind !== 'decision.selected' || !verifyDecision.candidateId)
      throw new Error('Missing verified candidate selection')
    const verifyManifest = records.find(
      (record) =>
        record.kind === 'resource.observed' &&
        JSON.stringify(record.resource).includes(verifyDecision.candidateId as string) &&
        JSON.stringify(record.resource).includes('jev.decision.manifest.v1'),
    )
    expect(JSON.stringify(verifyManifest)).toContain('/outcome/value/target/path')
    expect(JSON.stringify(verifyManifest)).toContain(writtenRecord?.id as string)
    expect(JSON.stringify(records.filter((record) => record.kind === 'action.settled').at(-1))).toContain(
      'actual nested disk evidence',
    )
    await session.close()
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['execution', 'approval'] as const)(
  'stops the arbitration tail for steering received during first-tool %s',
  async (timing) => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-batch-steering-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'source.txt'), 'evidence')
    const marker = 'Do not write anything. Answer using the current evidence.'
    const first =
      timing === 'execution'
        ? { name: 'read', args: { path: 'source.txt' } }
        : { name: 'write', args: { path: 'first.txt', content: 'must not execute' } }
    const provider = fakeProvider([
      [
        sent(),
        { type: 'toolcall_end', via: 'native', call: { ...first, toolUseId: 'first-call', ordinal: 0 } },
        {
          type: 'toolcall_end',
          via: 'native',
          call: {
            name: 'write',
            args: { path: 'tail.txt', content: 'must not execute' },
            toolUseId: 'tail-call',
            ordinal: 1,
          },
        },
        { type: 'done', reason: 'toolUse' },
      ],
      textTurn('Accepted the new instruction; no further writes.'),
    ])
    let inject: (() => Promise<void>) | undefined
    let steered = false
    let approvals = 0
    const { host } = await createTestHost({
      dataDir: workspace,
      packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base/', import.meta.url)) },
      provider,
      disableSessionTitle: true,
      jev: respondingJev(() => {}, 0.2),
      approval: async () => {
        approvals++
        if (timing === 'approval') {
          if (!inject) throw new Error('Session is not ready')
          await inject()
        }
        return 'allowed-once'
      },
    })
    try {
      const session = await host.createSession({ cwd: workspace, runtime: 'jevloop' })
      inject = async () => {
        if (steered) return
        steered = true
        await session.enqueue('next-step', {
          actor,
          kind: 'steer',
          content: [{ type: 'text', text: marker }],
        })
      }
      if (timing === 'execution') {
        const hooks = session.hooks
        Object.defineProperty(session, 'hooks', {
          configurable: true,
          get: () =>
            Object.assign(Object.create(hooks), {
              toolResult: async (input: Parameters<NonNullable<typeof hooks.toolResult>>[0]) => {
                if (input.name === 'read') await inject?.()
                return hooks.toolResult?.(input) ?? {}
              },
            }),
        })
      }
      await session.enqueue('next-turn', {
        actor,
        content: [{ type: 'text', text: 'Inspect then write the result.' }],
      })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      expect(steered).toBe(true)
      expect(approvals).toBe(timing === 'approval' ? 1 : 0)
      await expect(readFile(join(workspace, 'tail.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(workspace, 'first.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      const records = (
        await scanAll((query) => session.scan(query), { type: 'runtime/record', toSeq: session.lastSeq })
      ).map((row) => runtimeRecord(row.data))
      const actions = records.filter((record) => record.kind === 'action.intended')
      expect(actions).toHaveLength(1)
      expect(records.filter((record) => record.kind === 'action.dispatching')).toHaveLength(
        timing === 'execution' ? 1 : 0,
      )
      if (timing === 'approval')
        expect(records.find((record) => record.kind === 'action.settled')).toMatchObject({
          effect: 'not_applied',
        })
      const admitted = records.findIndex(
        (record) =>
          record.kind === 'input.admitted' &&
          record.input.content.some((block) => block.kind === 'text' && block.text === marker),
      )
      expect(admitted).toBeGreaterThan(0)
      const nextDecision = records
        .slice(admitted + 1)
        .find((record) => record.kind === 'model.requested' && record.call.purpose === 'decision')
      expect(nextDecision).toBeDefined()
      expect(JSON.stringify(nextDecision)).toContain(marker)
      expect(provider.requests).toHaveLength(2)
      expect(JSON.stringify(provider.requests[1]?.messages)).toContain(marker)
      expect(session.latest('inbox')).toMatchObject({ items: [] })
      await session.close()
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.each(['model', 'stopping-hook'] as const)(
  'recovers steering from %s committed before runtime admission exactly once',
  async (timing) => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-loop-steer-recovery-'))
    const provider = fakeProvider([textTurn('Before steering'), textTurn('After recovered steering')])
    const { host } = await createTestHost({
      dataDir: root,
      provider,
      disableSessionTitle: true,
      jev: respondingJev(),
    })
    const steerText = 'Durable steering survives the admission gap'
    try {
      const session = await host.createSession({ cwd: root, runtime: 'jevloop' })
      await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'Initial task' }] })
      const infer = provider.infer.bind(provider)
      let steered = false
      const inject = async () => {
        if (!steered) {
          steered = true
          await session.enqueue('next-step', {
            actor,
            content: [{ type: 'text', text: steerText }],
            kind: 'steer',
          })
        }
      }
      if (timing === 'model')
        vi.spyOn(provider, 'infer').mockImplementation(async function* (request, options) {
          await inject()
          yield* infer(request, options)
        })
      {
        const hooks = session.hooks
        Object.defineProperty(session, 'hooks', {
          configurable: true,
          get: () =>
            Object.assign(Object.create(hooks), {
              turnStopping: async () => {
                if (timing === 'stopping-hook') await inject()
                else
                  await session.enqueue('next-step', {
                    actor,
                    content: [{ type: 'text', text: 'premature stop hook input' }],
                    kind: 'steer',
                  })
                return { action: 'stop' as const }
              },
            }),
        })
      }
      const append = session.d.log.append.bind(session.d.log)
      // Preserve the genuine committed prefix, then fail the first missing runtime admission.
      const crash = vi.spyOn(session.d.log, 'append').mockImplementation(async (events) => {
        for (const event of events) {
          if (event.type !== 'runtime/record') continue
          const record = runtimeRecord(event.data)
          if (
            record.kind === 'input.admitted' &&
            record.input.content.some((block) => block.kind === 'text' && block.text === steerText)
          )
            throw new Error('simulated crash before steering runtime admission')
        }
        return append(events)
      })
      await expect(session.run({ until: 'turn-end', signal: new AbortController().signal })).rejects.toThrow(
        'simulated crash',
      )
      const prefix = await scanAll((query) => session.scan(query), { toSeq: session.lastSeq })
      expect(JSON.stringify(prefix)).not.toContain('premature stop hook input')
      const steerMessages = prefix.filter(
        (row) => row.type === 'user/message' && JSON.stringify(row.data).includes(steerText),
      )
      expect(steerMessages).toHaveLength(1)
      const messageSeq = steerMessages[0]!.seq
      const inputRecords = prefix
        .filter((row) => row.type === 'runtime/record')
        .flatMap((row) => {
          const record = runtimeRecord(row.data)
          return record.kind === 'input.admitted' ? [{ seq: row.seq, input: record.input }] : []
        })
      const original = inputRecords.find((row) =>
        row.input.content.some((block) => block.kind === 'text' && block.text === 'Initial task'),
      )
      expect(original).toBeDefined()
      expect(original!.seq).toBeLessThan(messageSeq)
      expect(inputRecords.some((row) => row.input.id === `message:${messageSeq}`)).toBe(false)
      expect(session.latest('inbox')).toMatchObject({ items: [] })
      expect(session.state.openTurn.has(session.lane)).toBe(true)
      crash.mockRestore()
      const key = session.key
      await session.close()

      const reopened = await host.createSession({ cwd: root, key })
      expect((await reopened.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      const recovered = await scanAll((query) => reopened.scan(query), {
        type: 'runtime/record',
        toSeq: reopened.lastSeq,
      })
      const inputs = recovered.flatMap((row) => {
        const record = runtimeRecord(row.data)
        return record.kind === 'input.admitted' ? [record.input] : []
      })
      expect(inputs.filter((input) => input.id === original!.input.id)).toHaveLength(1)
      expect(inputs.filter((input) => input.id === `message:${messageSeq}`)).toEqual([
        expect.objectContaining({ source: 'user', content: [{ kind: 'text', text: steerText }] }),
      ])
      expect(await reopened.scan({ type: 'user/message', limit: 100 })).toHaveLength(2)
      expect(provider.requests).toHaveLength(2)
      expect(JSON.stringify(provider.requests[1])).toContain(steerText)
      await reopened.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(provider.requests).toHaveLength(2)
      await reopened.close()
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.each([
  { kind: 'hook blocked', credits: 1, reason: 'blocked', code: undefined, message: undefined },
  { kind: 'unknown price', credits: 0, reason: 'budget', code: 'E_BUDGET', message: '可信费用估算' },
  { kind: 'exceeded cap', credits: 11, reason: 'budget', code: 'E_BUDGET', message: '超过预算上限' },
  { kind: 'tree quote missing', credits: 1, reason: 'budget', code: 'E_BUDGET', message: '树预算预留未通过' },
  {
    kind: 'private failure',
    credits: null,
    reason: 'error',
    code: 'E_RUNTIME_FAILED',
    message: 'Jev 执行失败',
  },
])('publishes a safe concrete turn error for $kind', async ({ kind, credits, reason, code, message }) => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-loop-budget-'))
  const provider = fakeProvider([])
  let decisions = 0
  const { host } = await createTestHost({
    dataDir: root,
    provider,
    disableSessionTitle: true,
    jev: respondingJev(() => decisions++),
    presets: {
      standard: {
        name: 'standard',
        extends: 'base',
        disclosure: 'standard',
        model: { route: { primary: 'default' } },
        budget: { per_request_cap: 10 },
        ...(kind === 'tree quote missing' ? { subagent: { tree_budget_credits: 2 } } : {}),
      },
    },
  })
  const privateDetail = 'private-path=/private/customer/account token=secret-runtime-test'
  try {
    const session = await host.createSession({ cwd: root, runtime: 'jevloop' })
    if (kind === 'hook blocked') {
      const hooks = session.hooks
      Object.defineProperty(session, 'hooks', {
        configurable: true,
        get: () => ({ ...hooks, beforeStep: async () => ({ block: true, reason: privateDetail }) }),
      })
    }
    const projection = vi.spyOn(session.d.runtime, 'ledgerProjected')
    if (credits === null) projection.mockRejectedValue(new Error(privateDetail))
    else projection.mockResolvedValue({ credits, creditSource: 'estimated' })
    await session.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: 'Trigger budget preflight' }],
    })
    const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    if (code && message)
      expect(outcome).toMatchObject({ reason, error: { code, message: expect.stringContaining(message) } })
    else {
      expect(outcome.reason).toBe('blocked')
      expect(outcome).not.toHaveProperty('error')
    }
    expect(JSON.stringify(outcome)).not.toContain(privateDetail)
    const ends = await session.scan({ type: 'turn/end', limit: 100 })
    expect(ends).toHaveLength(1)
    expect(ends[0]?.data).toEqual({
      reason,
      lastAssistantSeq: null,
      ...(outcome.error ? { error: outcome.error } : {}),
    })
    expect(JSON.stringify(ends)).not.toContain('secret-runtime-test')
    const records = await scanAll((query) => session.scan(query), {
      type: 'runtime/record',
      toSeq: session.lastSeq,
    })
    const stopped = records
      .map((row) => runtimeRecord(row.data))
      .findLast((record) => record.kind === 'run.stopped')
    expect(stopped).toMatchObject({
      kind: 'run.stopped',
      reason: reason === 'blocked' ? 'blocked' : 'failed',
    })
    if (credits === null) expect(JSON.stringify(stopped)).toContain(privateDetail)
    expect(provider.requests).toHaveLength(0)
    expect(decisions).toBe(0)
    expect(session.state.openTurn.has(session.lane)).toBe(false)
    expect(session.runtimeState().phase).toBe(reason === 'error' ? 'failed' : 'idle')
    await session.close()
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('applies preset step limits at new turns identically before and after reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-jev-step-policy-'))
  const provider = fakeProvider(Array.from({ length: 8 }, () => textTurn('answer')))
  const { host } = await createTestHost({
    dataDir: root,
    provider,
    disableSessionTitle: true,
    jev: respondingJev(),
    profileInputs: {
      user: { name: 'local-dev', presets: { default: 'standard', allowed: ['standard', 'coding'] } },
    },
    presets: {
      standard: {
        name: 'standard',
        extends: 'base',
        model: { route: { primary: 'gw' }, id: { primary: 'm1' } },
        budget: { max_steps: 3 },
      },
      coding: {
        name: 'coding',
        extends: 'base',
        model: { route: { primary: 'gw' }, id: { primary: 'm1' } },
        budget: { max_steps: 1 },
      },
    },
  })
  try {
    let session = await host.createSession({ cwd: root, runtime: 'jevloop' })
    const attach = () => {
      const continued = new Set<number>()
      const hooks = session.hooks
      Object.defineProperty(session, 'hooks', {
        configurable: true,
        get: () =>
          Object.assign(Object.create(hooks), {
            turnStopping: async ({ turn }: { turn: number }) => {
              if (continued.has(turn)) return { action: 'stop' as const }
              continued.add(turn)
              return { action: 'continue' as const, note: 'Check one further step' }
            },
          }),
      })
    }
    const run = async (cap: number, reason: string) => {
      await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'task' }] })
      const result = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      const records = (
        await scanAll((query) => session.scan(query), { type: 'runtime/record', toSeq: session.lastSeq })
      ).map((row) => runtimeRecord(row.data))
      expect(result.reason, JSON.stringify(records.slice(-3))).toBe(reason)
      const opened = records.findLast((record) => record.kind === 'run.opened')
      expect(opened).toMatchObject({ config: { maxSteps: cap } })
      const steps = new Set(
        records
          .filter((record) => record.turn === opened?.turn && record.step !== undefined)
          .map((record) => record.step),
      )
      expect(steps.size).toBe(reason === 'completed' ? 2 : 1)
    }
    attach()
    await run(3, 'completed')
    await host.setSessionPreset(session.key, 'coding')
    expect(
      (await host.prepareSessionConfiguration(session.key)).configuration.runtimeConfig?.config.maxSteps,
    ).toBe(1)
    await run(1, 'budget')
    const key = session.key
    await session.close()
    session = await host.createSession({ key, cwd: root })
    attach()
    await run(1, 'budget')
    await host.setSessionPreset(session.key, 'standard')
    await run(3, 'completed')
    await session.close()
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('restores an unfinished turn with its admitted step budget before adopting a changed preset limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agnes-jev-step-recovery-'))
  const provider = fakeProvider(Array.from({ length: 4 }, () => textTurn('answer')))
  const options = (maxSteps: number) => ({
    dataDir: root,
    provider,
    disableSessionTitle: true,
    jev: respondingJev(),
    presets: {
      standard: {
        name: 'standard',
        extends: 'base',
        model: { route: { primary: 'gw' }, id: { primary: 'm1' } },
        budget: { max_steps: maxSteps },
      },
    },
  })
  let { host } = await createTestHost(options(3))
  try {
    const initial = await host.createSession({ cwd: root, runtime: 'jevloop' })
    await initial.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'resume this turn' }] })
    const append = initial.d.log.append.bind(initial.d.log)
    const crash = vi.spyOn(initial.d.log, 'append').mockImplementation(async (events) => {
      if (
        events.some(
          (event) => event.type === 'runtime/record' && runtimeRecord(event.data).kind === 'model.requested',
        )
      )
        throw new Error('simulated crash after run.opened')
      return append(events)
    })
    await expect(initial.run({ until: 'turn-end', signal: new AbortController().signal })).rejects.toThrow(
      'simulated crash',
    )
    crash.mockRestore()
    const key = initial.key
    await host.close()
    ;({ host } = await createTestHost(options(1)))
    const restored = await host.createSession({ key, cwd: root })
    expect(restored.preset.budget.maxSteps).toBe(1)
    const hooks = restored.hooks
    const continued = new Set<number>()
    Object.defineProperty(restored, 'hooks', {
      configurable: true,
      get: () =>
        Object.assign(Object.create(hooks), {
          turnStopping: async ({ turn }: { turn: number }) => {
            if (continued.has(turn)) return { action: 'stop' as const }
            continued.add(turn)
            return { action: 'continue' as const, note: 'One more verification' }
          },
        }),
    })
    expect((await restored.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(provider.requests).toHaveLength(2)
    await restored.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'new policy' }] })
    expect((await restored.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'budget',
    )
    const records = (
      await scanAll((query) => restored.scan(query), { type: 'runtime/record', toSeq: restored.lastSeq })
    ).map((row) => runtimeRecord(row.data))
    expect(
      records.filter((record) => record.kind === 'run.opened').map((record) => record.config.maxSteps),
    ).toEqual([3, 1])
    expect(provider.requests).toHaveLength(3)
    await restored.close()
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})
