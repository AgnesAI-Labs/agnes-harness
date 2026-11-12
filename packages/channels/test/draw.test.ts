import type { ChannelCapabilities, UINode } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { contentHash, drawSurfaceMessage, whatToDraw } from '../src/runner/draw.js'

const caps: ChannelCapabilities = {
  edit: true,
  card: true,
  thread: false,
  attachment: true,
  reactions: false,
  typing: false,
  voice: false,
}
const context = { costLine: true, caps }

describe('whatToDraw', () => {
  it('forwards correlated human input but omits legacy input, channel echoes, partial answers and internal nodes', () => {
    expect(whatToDraw({ kind: 'user', id: 'u', seq: 1, content: [] }, context)).toBeNull()
    const input: UINode = {
      kind: 'user',
      id: 'typed',
      seq: 2,
      commandId: 'web-input',
      content: [{ type: 'text', text: 'hello' }],
    }
    expect(whatToDraw(input, context)).toEqual({
      blocks: [{ kind: 'text', markdown: '来自 AGH 的用户消息：\n\nhello' }],
    })
    expect(whatToDraw({ ...input, commandId: `channel:${'a'.repeat(64)}` }, context)).toBeNull()
    expect(whatToDraw({ ...input, origin: 'system' }, context)).toBeNull()
    expect(
      whatToDraw(
        { ...input, content: [{ type: 'image', data: 'private-bytes', mimeType: 'image/png' }] },
        context,
      ),
    ).toEqual({ blocks: [{ kind: 'text', markdown: '来自 AGH 的用户消息：\n\n[附件请在 AGH 中查看]' }] })
    expect(
      whatToDraw(
        {
          ...input,
          content: [
            {
              type: 'text',
              text: 'private reference',
              reference: {
                source: 'file',
                id: 'private',
                label: 'private',
                hash: 'a'.repeat(64),
                truncated: false,
              },
            },
          ],
        },
        context,
      ),
    ).toBeNull()

    expect(
      whatToDraw({ kind: 'assistant', id: 'a', seq: 2, text: 'partial', streaming: true }, context),
    ).toBeNull()
    // An attempt whose streamed text died with its process: nothing to say, a retry follows.
    expect(
      whatToDraw(
        { kind: 'assistant', id: 'a', seq: 2, text: '', streaming: false, effectId: 'e1', lostChars: 40 },
        context,
      ),
    ).toBeNull()
    expect(whatToDraw({ kind: 'compaction', id: 'c', seq: 3, range: [1, 2] }, context)).toBeNull()
    expect(
      whatToDraw(
        { kind: 'slot', id: 's', fill: { slot: 'sidebar.action', extId: 'x', payload: {} } },
        context,
      ),
    ).toBeNull()
  })

  it('does not push a harness-internal context notice into the chat surface', () => {
    // A hook note or per-request fact snapshot is not a message meant for a chat surface's human
    // audience -- same "no channel presence" treatment as 'user'/'compaction' above.
    expect(whatToDraw({ kind: 'context', id: 'x', seq: 4, text: '{"model":"x"}' }, context)).toBeNull()
  })

  it('draws complete assistant text and only the tool summary plus inline fills', () => {
    expect(whatToDraw({ kind: 'assistant', id: 'a', seq: 2, text: '**done**' }, context)).toEqual({
      blocks: [{ kind: 'text', markdown: '**done**' }],
    })
    const tool: UINode = {
      kind: 'tool',
      id: 't',
      seq: 3,
      toolUseId: 'x',
      name: 'query',
      status: 'completed',
      summary: 'must not leak',
      argsPreview: 'secret arguments',
      resultPreview: 'secret result',
      slots: [
        {
          slot: 'tool.card.inline',
          extId: 'xinwei/sales',
          requestSeq: 3,
          payload: {
            title: '销售',
            actions: [{ id: 'export', label: '导出' }],
          },
        },
      ],
    }
    const message = whatToDraw(tool, context)
    expect(message?.blocks[0]).toEqual({ kind: 'text', markdown: '⚙ query · 完成' })
    expect(message?.blocks[1]).toMatchObject({
      kind: 'card',
      title: '销售',
      actions: [{ id: 'export', label: '导出' }],
      requestSeq: 3,
    })
    expect(JSON.stringify(message)).not.toContain('secret')
  })

  it('draws approval, cost, artifact, notification, and status states', () => {
    const pending: UINode = {
      kind: 'approval',
      id: 'p',
      seq: 4,
      state: 'pending',
      summary: 'delete report',
      risk: 'destructive',
      options: ['allow_once', 'reject_once'],
      decisionRef: { sessionId: 's', id: 'abcdef123', revision: 1 },
      expiresAt: 'T',
    }
    expect(whatToDraw(pending, context)?.blocks[0]).toMatchObject({
      kind: 'approval',
      decisionKey: 's/abcdef123/1',
    })
    expect(
      whatToDraw(
        {
          ...pending,
          state: 'decided',
          decision: { verdict: 'allowed-once', via: 'callback', byLabel: '财务经理' },
        },
        context,
      )?.blocks[0],
    ).toEqual({ kind: 'text', markdown: '已批准 by 财务经理' })
    expect(whatToDraw({ ...pending, state: 'expired' }, context)?.blocks[0]).toEqual({
      kind: 'text',
      markdown: '审批已超时',
    })

    expect(
      whatToDraw(
        {
          ...pending,
          state: 'expired',
          decision: { verdict: 'allowed-once', via: 'human', reason: 'stopped' },
        },
        context,
      )?.blocks[0],
    ).toEqual({ kind: 'text', markdown: '任务已停止，审批已撤销' })

    const cost: UINode = { kind: 'cost', id: 'cost', seq: 5, credits: 12.5, source: 'gateway' }
    expect(whatToDraw(cost, context)?.blocks[0]).toEqual({
      kind: 'text',
      markdown: '本轮费用 12.5 credits',
    })
    expect(whatToDraw(cost, { ...context, costLine: false })).toBeNull()

    const artifact: UINode = {
      kind: 'artifact',
      id: 'f',
      seq: 6,
      name: 'r.xlsx',
      ref: { sha256: 'abc', size: 10, mime: 'application/x-sheet' },
    }
    expect(whatToDraw(artifact, context)?.blocks[0]).toEqual({
      kind: 'file',
      name: 'r.xlsx',
      mime: 'application/x-sheet',
    })
    expect(
      whatToDraw(artifact, { ...context, artifactsUrl: 'https://files.example/artifacts/' })?.blocks[0],
    ).toMatchObject({ kind: 'file', url: 'https://files.example/artifacts/abc' })

    expect(
      whatToDraw(
        {
          kind: 'slot',
          id: 'n',
          fill: {
            slot: 'notification',
            extId: 'x',
            payload: { title: '日报', body: '已生成', link: 'https://example.test/report' },
          },
        },
        context,
      )?.blocks[0],
    ).toMatchObject({ kind: 'card', title: '日报', body: '已生成' })
    expect(
      whatToDraw(
        {
          kind: 'slot',
          id: 'status',
          fill: { slot: 'status.line', extId: 'x', payload: { text: 'running' } },
        },
        context,
      )?.blocks[0],
    ).toEqual({ kind: 'text', markdown: 'running' })
  })

  it('drops the durable-grant option: channels has no card button for it', () => {
    // UINode's approval options carry Agnes' own vocabulary, including 'allow_permanent' for the
    // durable-grant flow (core/src/project/ui.ts). The channel Block only understands ACP's four
    // native PermissionOptionKind values and has never offered a "grant permanently" button
    // (OFFERED_OPTION_KINDS), so that entry must not reach the wire.
    const pending: UINode = {
      kind: 'approval',
      id: 'p',
      seq: 4,
      state: 'pending',
      summary: 'grant tool access',
      risk: 'destructive',
      options: ['allow_once', 'allow_always', 'allow_permanent'],
      decisionRef: { sessionId: 's', id: 'abcdef123', revision: 1 },
    }
    expect(whatToDraw(pending, context)?.blocks[0]).toMatchObject({
      kind: 'approval',
      options: ['allow_once', 'allow_always'],
    })
  })

  it('hashes byte length rather than byte contents without mutating the message', () => {
    const bytes = new Uint8Array([1, 2])
    const message = { blocks: [{ kind: 'file' as const, name: 'x', mime: 'm', bytes }] }
    const first = contentHash(message)
    expect(first).toBe(
      contentHash({ blocks: [{ kind: 'file', name: 'x', mime: 'm', bytes: new Uint8Array([8, 9]) }] }),
    )
    expect(first).not.toBe(
      contentHash({ blocks: [{ kind: 'file', name: 'x', mime: 'm', bytes: new Uint8Array(3) }] }),
    )
    expect(message.blocks[0]?.bytes).toBe(bytes)
  })
})

it('renders numbered surface choices with an authenticated Web fallback and no permission buttons', async () => {
  const { choiceSurface } = await import('../testkit/choice-surface.js')
  const record = {
    surface: choiceSurface('questions'),
    status: 'open' as const,
    owner: 'agnes/intelligent-ui',
    lane: 'main',
    taskId: 'task',
    createdSeq: 1,
    updatedSeq: 1,
  }
  record.surface.components.push({
    id: 'custom',
    kind: 'example/review@1',
    dataKey: 'custom',
    fallback: 'Review the preset form',
    actionIds: [],
  })
  record.surface.data.custom = {}
  const message = drawSurfaceMessage(record, 'session x', 'https://web.example/')
  expect(JSON.stringify(message)).toContain('1. A')
  expect(JSON.stringify(message)).toContain('2. B')
  expect(JSON.stringify(message)).toContain('Review the preset form')
  expect(JSON.stringify(message)).toContain('https://web.example/?session=session%20x&surface=questions')
  expect(JSON.stringify(message)).toContain('认证 Web')
  expect(message.blocks).toHaveLength(1)
  expect(message.blocks[0]?.kind).toBe('text')
})

it('projects all collector answer modes and closes the same surface without actions', async () => {
  const { choiceSurface } = await import('../testkit/choice-surface.js')
  const surface = choiceSurface('q')
  const form = surface.components.at(0)
  if (!form || form.kind !== 'form' || 'fallback' in form) throw new Error('form fixture missing')
  form.schema = {
    type: 'object',
    required: ['single', 'multi', 'text'],
    properties: {
      single: { type: 'string', title: 'One', enum: ['A', 'B'] },
      multi: {
        type: 'array',
        title: 'Many',
        items: { type: 'string', enum: ['A', 'B'] },
        minItems: 1,
        maxItems: 2,
      },
      text: { type: 'string', title: 'Details', maxLength: 8192 },
      custom: { type: 'array', title: 'Custom', items: { type: 'string' }, 'x-ui-choices': ['C'] },
    },
  }
  const record = {
    surface,
    status: 'open' as const,
    owner: 'agnes/intelligent-ui',
    lane: 'main',
    taskId: 't',
    createdSeq: 1,
    updatedSeq: 1,
  }
  const block = drawSurfaceMessage(record, 's', 'https://web.example', true).blocks.at(0)
  expect(block).toMatchObject({
    kind: 'surface',
    sessionId: 's',
    surfaceId: 'q',
    form: {
      state: 'open',
      fields: [
        {
          kind: 'single',
          name: 'single',
          inputKey: 'answers',
          required: true,
          options: [{ value: 'A' }, { value: 'B' }],
        },
        { kind: 'multi', name: 'multi', minItems: 1, maxItems: 2 },
        { kind: 'text', name: 'text', maxLength: 8192 },
        { kind: 'multi', name: 'custom', allowFreeText: true, options: [{ value: 'C' }] },
      ],
    },
  })
  expect(
    drawSurfaceMessage({ ...record, status: 'closed' }, 's', undefined, true).blocks.at(0),
  ).toMatchObject({ kind: 'surface', form: { state: 'closed' } })
  surface.components.push({
    id: 'custom-widget',
    kind: 'example/view@1',
    dataKey: 'draft',
    fallback: 'Use Web',
    actionIds: [],
  })
  expect(drawSurfaceMessage(record, 's', undefined, true).blocks.at(0)?.kind).toBe('text')
})
