import type { HookPayloadMap } from '@agnes/extension-api'
import type { ModelRecord, RequestBody } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { CompactionRunner } from '../src/step/compaction.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

const signal = () => new AbortController().signal
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const model: ModelRecord = {
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}

async function prompt(session: Awaited<ReturnType<Kernel['session']>>, text: string, untrusted = false) {
  await session.enqueue('next-turn', {
    content: [{ type: 'text', text }],
    actor,
    ...(untrusted ? { trust: 'untrusted' as const } : {}),
  })
  expect((await session.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
}

const envelopeId = (messages: RequestBody['messages'], marker: string) => {
  const message = messages.find((item) => JSON.stringify(item).includes(marker))
  return /<untrusted id=\\?"([^"]+)/u.exec(JSON.stringify(message))?.[1]
}

async function plan(payload: HookPayloadMap['before_compact']) {
  const nodes = payload.getSurface()
  const first = nodes[0]
  const summarizedLast = nodes.at(-2)
  const kept = nodes.at(-1)
  if (!first || !summarizedLast || !kept) throw new Error('missing compactable history')
  return {
    keepFromSeq: kept.seq,
    summarizeRange: [first.seq, summarizedLast.seq] as [number, number],
    ...(payload.previousSummarySeq === undefined ? {} : { previousSummarySeq: payload.previousSummarySeq }),
    prompts: {
      system: 'Summarize the prior working memory.',
      history:
        payload.previousSummarySeq === undefined
          ? 'Summarize the preceding conversation segment.'
          : 'Update the existing summary with the new conversation segment.',
    },
    maxTokens: 100,
    details: { readFiles: [], modifiedFiles: [] },
  }
}

it('updates a summary inherited from the parent and preserves historical envelope ids', async () => {
  const provider = fakeProvider([
    textTurn('parent one'),
    textTurn('parent two'),
    textTurn('PARENT SUMMARY'),
    textTurn('parent tail'),
    textTurn('child answer'),
    textTurn('CHILD SUMMARY'),
    textTurn('child after summary'),
  ])
  let primaryWindow = model.contextWindow
  provider.models = () => [
    { ...model, contextWindow: primaryWindow },
    { ...model, id: 'summary-model', slot: 'compaction', contextWindow: 1_000_000 },
  ]
  const infer = provider.infer.bind(provider)
  provider.infer = (request, options) => {
    if (request.sessionKey === 'child' && request.kind === 'summary') primaryWindow = 1_000_000
    return infer(request, options)
  }
  const preset = presetDefaults()
  preset.compaction.reserveTokens = 1_000
  preset.compaction.keepRecentTokens = 0
  preset.model.id.compaction = 'summary-model'
  const kernel = Kernel.create({
    storage: new MemoryStorage(),
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset,
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
  })
  try {
    const parent = await kernel.session('parent', {
      actor,
      resolvedProfileHash: 'h1',
      cwd: '/w',
      writerRunId: 'parent-run',
    })
    await prompt(parent, 'historical untrusted marker', true)
    await prompt(parent, 'second parent turn')
    parent.compaction = new CompactionRunner({ plan, onCompact: async () => undefined })
    await parent.requestCompaction({ actor, admissionId: 'parent-summary' })
    expect((await parent.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
    const inheritedSummary = parent.surface()[0]
    expect(inheritedSummary?.kind).toBe('summary')
    await prompt(parent, 'inherited untrusted marker', true)
    const parentRequest = provider.requests.at(-1)
    if (!parentRequest || !inheritedSummary) throw new Error('missing parent summary or request')
    const inheritedId = envelopeId(parentRequest.messages, 'inherited untrusted marker')
    expect(inheritedId).toBeTruthy()

    const child = await kernel.session('child', {
      actor,
      resolvedProfileHash: 'h1',
      cwd: '/w',
      writerRunId: 'child-run',
      parent: { key: 'parent', boundarySeq: parent.lastSeq },
    })
    expect(child.surface()[0]?.seq).toBe(inheritedSummary.seq)
    await prompt(child, 'child task')
    let observedPrevious: number | undefined
    let observedHistory = ''
    let observedReason = ''
    child.compaction = new CompactionRunner({
      plan: async (payload: HookPayloadMap['before_compact']) => {
        observedPrevious = payload.previousSummarySeq
        observedReason = payload.reason
        const selected = await plan(payload)
        observedHistory = selected.prompts.history
        return selected
      },
      onCompact: async () => undefined,
    })
    primaryWindow = 1
    await prompt(child, 'cross the child compaction threshold')
    expect(observedReason).toBe('threshold')
    expect(observedPrevious).toBe(inheritedSummary.seq)
    expect(observedHistory).toContain('Update the existing summary with the new conversation segment.')
    const summaryRequest = provider.requests.findLast(
      (request) => request.sessionKey === 'child' && request.kind === 'summary',
    )
    if (!summaryRequest) throw new Error('missing child summary request')
    expect(summaryRequest.kind).toBe('summary')
    expect(envelopeId(summaryRequest.messages, 'inherited untrusted marker')).toBe(inheritedId)
    const ownRows = await child.d.log.scan({ fromSeq: parent.lastSeq + 1, limit: 500 })
    expect(ownRows.filter((row) => row.type === 'x/core/compaction-failed')).toEqual([])
    expect(
      ownRows.find((row) => typeof row.surfaceOp === 'object' && row.surfaceOp?.op === 'replace')?.surfaceOp,
    ).toMatchObject({ op: 'replace', start: inheritedSummary.seq })
    expect(child.surface()[0]?.kind).toBe('summary')
    expect(child.surface()[0]?.seq).not.toBe(inheritedSummary.seq)
  } finally {
    await kernel.close()
  }
})

it('routes an unconfigured child compaction slot to the child model target', async () => {
  const provider = fakeProvider([
    textTurn('parent answer'),
    textTurn('child answer'),
    textTurn('CHILD SUMMARY'),
  ])
  provider.models = () => [
    { ...model, route: 'parent-route', id: 'parent-id', name: 'parent-id' },
    { ...model, route: 'child-route', id: 'child-id', name: 'child-id' },
  ]
  const preset = presetDefaults()
  preset.model.route.primary = 'parent-route'
  preset.model.id.primary = 'parent-id'
  expect(preset.model.route.compaction).toBeUndefined()
  expect(preset.model.id.compaction).toBeUndefined()
  const kernel = Kernel.create({
    storage: new MemoryStorage(),
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset,
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
  })
  try {
    const parent = await kernel.session('parent', {
      actor,
      resolvedProfileHash: 'h1',
      cwd: '/w',
      writerRunId: 'parent-run',
    })
    await prompt(parent, 'parent history')
    expect(provider.requests[0]).toMatchObject({ route: 'parent-route', model: 'parent-id' })
    const handle = await parent.d.children.create({
      parent: parent.key,
      cwd: '/w',
      model: 'child-id',
      input: 'child task',
    })
    try {
      const child = kernel.get(handle.key)
      if (!child) throw new Error('missing child session')
      expect(child.preset.model.route.primary).toBe('child-route')
      expect(child.preset.model.id.primary).toBe('child-id')
      expect(child.preset.model.route.compaction).toBeUndefined()
      expect(child.preset.model.id.compaction).toBeUndefined()
      await prompt(child, 'child history')
      child.compaction = new CompactionRunner({ plan, onCompact: async () => undefined })
      await child.requestCompaction({ actor, admissionId: 'child-model-target-summary' })
      expect((await child.run({ until: 'turn-end', signal: signal() })).reason).toBe('completed')
      const summaryRequest = provider.requests.findLast(
        (request) => request.sessionKey === child.key && request.kind === 'summary',
      )
      expect(summaryRequest).toMatchObject({ route: 'child-route', model: 'child-id' })
      const rows = await child.d.log.scan({ fromSeq: parent.lastSeq + 1, limit: 500 })
      expect(rows.some((row) => row.type === 'x/core/compaction-failed')).toBe(false)
    } finally {
      await handle.close()
    }
  } finally {
    await kernel.close()
  }
})
