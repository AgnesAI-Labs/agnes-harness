import type { Event } from '@agnes/core-common/types'
import { validateAgainst } from '@agnes/protocol'
import { UITimeline } from '@agnes/protocol/gen/agnes-v1'
import { expect, it } from 'vitest'
import { projectUI } from '../src/project/ui.js'
import { pendingDecision } from '../testkit/decision.js'

const EMOJI = '\u{1F600}'

function builder(actorId = 'u') {
  let seq = 0
  return (type: string, data: Event['data'], extra: Partial<Event> = {}): Event => {
    seq += 1
    return {
      seq,
      ts: new Date(Date.UTC(2026, 8, 24, 0, 0, seq)).toISOString(),
      id: `01K0000000000000000000${String(seq).padStart(4, '0')}`,
      type,
      data,
      actor: { id: actorId, org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
      ...extra,
    }
  }
}

/** No unpaired surrogate anywhere in the text. */
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, out)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out)
  return out
}

/** The published schema counts `maxLength` in UTF-16 code units; every string must also stay well formed. */
function expectPublishable(timeline: Awaited<ReturnType<typeof projectUI>>): void {
  const checked = validateAgainst(UITimeline, { ...timeline, generation: 1 })
  expect(checked.ok ? [] : checked.errors).toEqual([])
  expect(strings(timeline).filter((text) => !wellFormed(text))).toEqual([])
}

function toolTurn(args: Record<string, string>, result: string, name = 'shell', actorId = 'u') {
  const event = builder(actorId)
  return [
    event('user/message', { content: [{ type: 'text', text: 'go' }] }),
    event('turn/start', { turn: 1, trigger: 'prompt' }),
    event('tool/call', { toolUseId: 'tool-1', name, args, ordinal: 0 }),
    event('tool/result', { toolUseId: 'tool-1', content: [{ type: 'text', text: result }], isError: false }),
    event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
  ]
}

it('keeps tool previews of astral characters within the published limits', async () => {
  const events = toolTurn({ cmd: EMOJI.repeat(1100) }, EMOJI.repeat(3000))
  const presentation = {
    title: 'Review selected report',
    description: 'Read the source before signing',
    summary: 'Verify record-1',
  }
  const call = events[2]!.data
  if (!call || typeof call !== 'object' || Array.isArray(call)) throw new Error('Expected call object')
  Object.assign(call, { presentation })
  const review = {
    scopePreview: { args: 'printf reviewed', cwd: '/synthetic', mode: 'workspace-write' },
    model: 'demo',
    promptHash: 'a'.repeat(64),
    argsHash: 'b'.repeat(64),
    scopeHash: 'c'.repeat(64),
    decision: 'deny',
    risk: 'high',
    reason: 'Human rejected after reviewer budget exhaustion',
    latencyMs: 0,
    cost: 0,
    costSource: 'unavailable',
    source: 'human-override',
  }
  for (const event of events.slice(3)) event.seq += 1
  events.splice(3, 0, {
    ...events[2]!,
    seq: 4,
    type: 'x/approval/review',
    sourceEventSeqs: [3],
    data: { toolUseId: 'tool-1', review },
  })
  const subject = { call: { name: 'shell', args: { command: EMOJI.repeat(1100) }, cwd: '/synthetic' } }
  events.push({
    ...events.at(-1)!,
    seq: events.at(-1)!.seq + 1,
    type: 'decision/state',
    register: 'decision/state',
    data: pendingDecision('review', { subject, sessionId: 'bounds', operationId: 'tool-1' }),
  })
  const timeline = await projectUI(events, {
    sessionKey: 'bounds',
  })
  const tool = timeline.nodes.find((node) => node.kind === 'tool')
  expect(tool?.kind === 'tool' && tool.argsPreview?.length).toBeLessThanOrEqual(2048)
  expect(tool?.kind === 'tool' && tool.resultPreview?.length).toBeLessThanOrEqual(4096)
  expect(tool?.kind === 'tool' && tool.review).toEqual(review)
  expect(tool?.kind === 'tool' && tool.presentation).toEqual(presentation)
  const approval = timeline.nodes.find((node) => node.kind === 'approval')
  expect(approval?.kind === 'approval' && JSON.parse(approval.subjectText!)).toEqual(subject)
  expect(approval?.kind === 'approval' && approval.toolName).toBe('shell')
  expect(approval?.kind === 'approval' && approval.toolUseId).toBe('tool-1')
  expectPublishable(timeline)
})

it('never splits a surrogate pair at the cut', async () => {
  // `{"a":"` is 6 code units, so the emoji occupies units 2047-2048 and the 2048-unit cut falls inside it.
  const timeline = await projectUI(toolTurn({ a: `${'x'.repeat(2041)}${EMOJI}tail` }, 'ok'), {
    sessionKey: 'bounds',
  })
  const tool = timeline.nodes.find((node) => node.kind === 'tool')
  expect(tool?.kind === 'tool' && tool.argsPreview).toBe(`{"a":"${'x'.repeat(2041)}`)
  expectPublishable(timeline)
})

it('keeps the user actor label and a long tool name within their limits', async () => {
  const name = `${'n'.repeat(255)}${EMOJI}`
  const timeline = await projectUI(toolTurn({}, 'ok', name, EMOJI.repeat(100)), { sessionKey: 'bounds' })
  const user = timeline.nodes.find((node) => node.kind === 'user')
  expect(user?.kind === 'user' && user.actorLabel?.length).toBeLessThanOrEqual(128)
  expectPublishable(timeline)
})

it('bounds extension-supplied context section and contribution conflict names', async () => {
  const event = builder()
  const long = `${'s'.repeat(300)}${EMOJI}`
  const timeline = await projectUI(
    [
      event('user/message', { content: [{ type: 'text', text: 'go' }] }),
      event(
        'x/core/context-breakdown',
        { sections: [{ id: long, order: 0, source: long, tokens: 1 }] },
        { ignorable: true },
      ),
      event('x/core/contribute-conflict', { key: long, ops: [long, 'b'] }, { ignorable: true }),
    ],
    { sessionKey: 'bounds' },
  )
  expect(timeline.nodes.map((node) => node.kind)).toEqual(['user', 'context-sections', 'contribute-conflict'])
  expectPublishable(timeline)
})

it('projects durable automatic permission evidence beside its tool without a pending approval card', async () => {
  const event = builder()
  const actor = {
    id: 'owner',
    org: 'local',
    role: 'system',
    deptPath: [],
    attrs: { permissionPolicy: 'full-access' },
  }
  const timeline = await projectUI(
    [
      event('tool/call', { toolUseId: 'call', name: 'plugin_test', args: {}, ordinal: 0 }),
      event(
        'x/core/permission-auto-allowed',
        {
          requestId: 'candidate-test',
          sessionKey: 'bounds',
          toolUseId: 'call',
          scope: 'plugin.test',
          summary: 'Run candidate',
          bindingHash: 'exact',
          verdict: 'allowed-once',
          reason: 'full-access',
          answeredBy: actor,
        },
        { ignorable: true },
      ),
    ],
    { sessionKey: 'bounds' },
  )
  expectPublishable(timeline)
  expect(timeline.nodes.find((node) => node.kind === 'tool')).toMatchObject({
    permissionDecision: { reason: 'full-access', decisionId: 'candidate-test', actor },
  })
  expect(timeline.nodes.find((node) => node.kind === 'approval')).toMatchObject({
    state: 'decided',
    toolName: 'plugin_test',
    toolUseId: 'call',
    decision: { reason: 'full-access' },
    options: [],
  })
})
