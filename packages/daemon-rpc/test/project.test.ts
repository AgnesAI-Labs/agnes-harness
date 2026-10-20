import { attachmentLink, fromAcpPrompt, validateMethod } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { toSessionUpdate, toSessionUpdates } from '../src/local/project.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const ev = (type: string, data: unknown) =>
  ({
    seq: 1,
    ts: '2026-09-07T00:00:00Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
    type,
    data,
    actor,
    origin: 'model',
    trust: 'trusted',
    lane: 'main',
  }) as never

describe('toSessionUpdate', () => {
  it('replays file-only messages as a valid ACP embedded blob resource', () => {
    const projected = toSessionUpdate(
      ev('user/message', {
        content: [{ type: 'file', name: 'video.mp4', mimeType: 'video/mp4', data: 'AA==' }],
      }),
      { replay: true },
    )
    expect(projected?.payload.content).toEqual({
      type: 'resource',
      resource: { uri: 'agnes-attachment:video.mp4', mimeType: 'video/mp4', blob: 'AA==' },
    })
    expect(
      validateMethod('session/update', 'params', {
        sessionId: 's',
        update: { sessionUpdate: projected?.sessionUpdate, ...projected?.payload },
      }).ok,
    ).toBe(true)
  })
  it('maps tool call, tool result and plan; streamed text never comes from a row', () => {
    expect(
      toSessionUpdate(
        ev('assistant/output', {
          state: 'started',
          effectId: 'e1',
          chars: { text: 2, thinking: 0 },
          estimatedTokens: 1,
        }),
      ),
    ).toBeNull()
    expect(
      toSessionUpdate(ev('tool/call', { toolUseId: 't1', name: 'read', args: { path: 'a' }, ordinal: 0 })),
    ).toMatchObject({
      sessionUpdate: 'tool_call',
      payload: { toolCallId: 't1', title: 'read', kind: 'read', status: 'pending' },
    })
    expect(
      toSessionUpdate(
        ev('tool/result', {
          toolUseId: 't1',
          content: [{ type: 'text', text: 'x' }],
          isError: false,
          enforcement: { level: 'full', scope: ['file'] },
          authz: { decisionId: 'n/a' },
        }),
      ),
    ).toMatchObject({ sessionUpdate: 'tool_call_update', payload: { toolCallId: 't1', status: 'completed' } })
    expect(
      toSessionUpdate(ev('plan.items', { items: [{ id: 'a', text: 'do', status: 'todo' }] })),
    ).toMatchObject({ sessionUpdate: 'plan' })
  })

  it('does not project the other classes', () => {
    expect(toSessionUpdate(ev('cost/ledger', { credits: 1, creditSource: 'estimated' }))).toBeNull()
    expect(toSessionUpdate(ev('turn/end', { reason: 'completed', lastAssistantSeq: null }))).toBeNull()
  })

  it('does not disguise a runtime_context notice as a user_message_chunk, live or on replay', () => {
    const e = ev('user/message', {
      content: [{ type: 'text', text: '{"model":"x","cwd":"/repo"}' }],
      kind: 'runtime_context',
    })
    expect(toSessionUpdate(e)).toBeNull()
    expect(toSessionUpdate(e, { replay: true })).toBeNull()
  })

  it('does not emit a [nested result] note as a user_message_chunk', () => {
    const e = ev('user/message', {
      content: [
        {
          type: 'text',
          text: '[nested result]\nThe nested call shell inside outer finished later (status: ok). Preview:',
        },
        { type: 'text', text: 'ran' },
      ],
      kind: 'runtime_context',
    })
    expect(toSessionUpdate(e)).toBeNull()
    expect(toSessionUpdate(e, { replay: true })).toBeNull()
    expect(toSessionUpdates(e, { replay: true })).toEqual([])
  })

  it('projects a user message from its first content block', () => {
    expect(toSessionUpdate(ev('user/message', { content: [{ type: 'text', text: 'go' }] }))).toEqual({
      sessionUpdate: 'user_message_chunk',
      payload: { content: { type: 'text', text: 'go' } },
    })
    expect(toSessionUpdate(ev('user/message', { content: [] }))).toEqual({
      sessionUpdate: 'user_message_chunk',
      payload: { content: { type: 'text', text: '' } },
    })
  })

  it('assistant/message is silent live and carries the answer on a replay', () => {
    const e = ev('assistant/message', {
      content: [
        { type: 'thinking', text: 'hm' },
        { type: 'text', text: 'hello ' },
        { type: 'text', text: 'world' },
      ],
      stopReason: 'end_turn',
      requestSeq: 1,
    })
    // Live the previews already said it; the Feed adds only what they missed.
    expect(toSessionUpdate(e)).toBeNull()
    expect(toSessionUpdate(e, { replay: false })).toBeNull()
    // On a replay no preview is delivered at all, so this row is the assistant's only voice. The text
    // blocks join into one ACP chunk; the thinking block has no ACP content form and is left out.
    expect(toSessionUpdate(e, { replay: true })).toEqual({
      sessionUpdate: 'agent_message_chunk',
      payload: { content: { type: 'text', text: 'hello world' } },
    })
  })

  it('a replayed assistant/message with no text block projects nothing', () => {
    // Thinking and tool calls only: the calls come back as their own rows, and an empty chunk would
    // be a message the assistant never spoke.
    const e = ev('assistant/message', { content: [{ type: 'thinking', text: 'hm' }], stopReason: 'tool_use' })
    expect(toSessionUpdate(e, { replay: true })).toBeNull()
    expect(toSessionUpdate(ev('assistant/message', { stopReason: 'end_turn' }), { replay: true })).toBeNull()
  })

  it('the replay flag changes nothing for the other classes', () => {
    const e = ev('user/message', { content: [{ type: 'text', text: 'go' }] })
    expect(toSessionUpdate(e, { replay: true })).toEqual(toSessionUpdate(e))
    const c = ev('tool/call', { toolUseId: 't1', name: 'read', args: {}, ordinal: 0 })
    expect(toSessionUpdate(c, { replay: true })).toEqual(toSessionUpdate(c))
  })

  it('a tool with no entry in the kind table is other, and a failed result is failed', () => {
    expect(
      toSessionUpdate(ev('tool/call', { toolUseId: 't2', name: 'web_search', args: {}, ordinal: 0 })),
    ).toMatchObject({ payload: { kind: 'other', rawInput: {} } })
    expect(
      toSessionUpdate(ev('tool/call', { toolUseId: 't3', name: 'shell', args: {}, ordinal: 1 })),
    ).toMatchObject({ payload: { kind: 'execute' } })
    expect(toSessionUpdate(ev('tool/result', { toolUseId: 't2', content: [], isError: true }))).toMatchObject(
      { sessionUpdate: 'tool_call_update', payload: { toolCallId: 't2', status: 'failed' } },
    )
  })

  it('wraps each tool result block as an ACP content entry', () => {
    expect(
      toSessionUpdate(
        ev('tool/result', { toolUseId: 't4', content: [{ type: 'text', text: 'a' }], isError: false }),
      ),
    ).toEqual({
      sessionUpdate: 'tool_call_update',
      payload: {
        toolCallId: 't4',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'a' } }],
      },
    })
  })

  it('maps the three plan statuses and defaults the rest to pending', () => {
    const r = toSessionUpdate(
      ev('plan.items', {
        items: [
          { id: 'a', text: 'a', status: 'done' },
          { id: 'b', text: 'b', status: 'doing' },
          { id: 'c', text: 'c', status: 'todo' },
        ],
      }),
    )
    expect(r?.payload.entries).toEqual([
      { content: 'a', priority: 'medium', status: 'completed' },
      { content: 'b', priority: 'medium', status: 'in_progress' },
      { content: 'c', priority: 'medium', status: 'pending' },
    ])
  })
})

it('replays every stored image/file reference as bounded valid ACP blocks without original bytes', () => {
  const blocks = [
    { type: 'text' as const, text: 'see attachments' },
    attachmentLink({ sha256: 'a'.repeat(64), size: 20000000, mime: 'image/png' }, 'photo.png', {
      image: { width: 100, height: 50 },
    }),
    attachmentLink({ sha256: 'b'.repeat(64), size: 40000000, mime: 'application/pdf' }, 'report.pdf'),
  ]
  const updates = toSessionUpdates(ev('user/message', { kind: 'prompt', content: blocks }), { replay: true })
  expect(updates).toHaveLength(3)
  expect(fromAcpPrompt(updates.map((update) => update.payload.content))).toEqual(blocks)
  for (const update of updates)
    expect(
      validateMethod('session/update', 'params', {
        sessionId: 's',
        update: { sessionUpdate: update.sessionUpdate, ...update.payload },
      }).ok,
    ).toBe(true)
  expect(JSON.stringify(updates).length).toBeLessThan(2048)
})
