import type { ChannelCapabilities, UINode } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { contentHash, whatToDraw } from '../src/runner/draw.js'

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
  it('does not echo user, partial assistant, compaction, or sidebar nodes', () => {
    expect(whatToDraw({ kind: 'user', id: 'u', seq: 1, content: [] }, context)).toBeNull()
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
            table: { columns: ['战区', '金额'], rows: [['华东', '10']] },
            actions: [{ id: 'export', label: '导出' }],
          },
        },
      ],
    }
    const message = whatToDraw(tool, context)
    expect(message?.blocks[0]).toEqual({ kind: 'text', markdown: '⚙ query · 完成' })
    expect(message?.blocks[1]).toMatchObject({
      kind: 'table',
      title: '销售',
      columns: ['战区', '金额'],
    })
    expect(message?.blocks[2]).toMatchObject({
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
      ticket: 'abcdef123',
      expiresAt: 'T',
    }
    expect(whatToDraw(pending, context)?.blocks[0]).toMatchObject({
      kind: 'approval',
      ticket: 'abcdef123',
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
      ticket: 'abcdef123',
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
