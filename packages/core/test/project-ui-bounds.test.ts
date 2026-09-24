import { validateAgainst } from '@agnes/protocol'
import { UITimeline } from '@agnes/protocol/gen/agnes-v1'
import { expect, it } from 'vitest'
import { projectUI } from '../src/project/ui.js'
import type { Event } from '../src/types.js'

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
  const timeline = await projectUI(toolTurn({ cmd: EMOJI.repeat(1100) }, EMOJI.repeat(3000)), {
    sessionKey: 'bounds',
  })
  const tool = timeline.nodes.find((node) => node.kind === 'tool')
  expect(tool?.kind === 'tool' && tool.argsPreview?.length).toBeLessThanOrEqual(2048)
  expect(tool?.kind === 'tool' && tool.resultPreview?.length).toBeLessThanOrEqual(4096)
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
