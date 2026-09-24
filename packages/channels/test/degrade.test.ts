import type { ChannelCapabilities } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import type { ChannelMessage } from '../src/adapter.js'
import { approvalAsText, degrade, escapeText, markdownSubset } from '../src/degrade.js'

const full: ChannelCapabilities = {
  edit: true,
  card: true,
  thread: true,
  attachment: true,
  reactions: true,
  typing: true,
  voice: true,
}

const none: ChannelCapabilities = {
  edit: false,
  card: false,
  thread: false,
  attachment: false,
}

describe('degrade', () => {
  it('passes everything through unchanged when capabilities are full', () => {
    const message: ChannelMessage = {
      blocks: [
        {
          kind: 'card',
          title: 'T',
          body: 'B',
          actions: [{ id: 'export', label: '导出' }],
        },
      ],
    }

    const result = degrade(message, full)

    expect(result.degraded).toEqual([])
    expect(result.msg).toEqual(message)
    expect(result.msg).not.toBe(message)
    expect(result.msg.blocks).not.toBe(message.blocks)
  })

  it('turns card, table and approval blocks into text without card capability', () => {
    const message: ChannelMessage = {
      blocks: [
        {
          kind: 'card',
          title: 'T',
          body: 'B',
          fields: [['k', 'v']],
          actions: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
        {
          kind: 'table',
          title: '销售',
          columns: ['战区', '金额'],
          rows: [
            ['华东', '10'],
            ['华北', '7'],
          ],
        },
        {
          kind: 'approval',
          title: '审批',
          summary: 'rm -rf tmp',
          risk: 'destructive',
          options: ['allow_once', 'reject_once'],
          ticket: 'a1b2c3d4e5f6',
        },
      ],
    }

    const result = degrade(message, none)

    expect(result.degraded).toEqual(['card'])
    expect(result.msg.blocks.every((block) => block.kind === 'text')).toBe(true)
    const texts = result.msg.blocks.map((block) => (block as { markdown: string }).markdown)
    expect(texts[0]).toContain('T')
    expect(texts[0]).toContain('k: v')
    expect(texts[0]).toContain('回复 1 / 2 选择')
    expect(texts[1]).toContain('华东 | 10')
    expect(texts[2]).toContain('同意 a1b2c3')
    expect(texts[2]).toContain('拒绝 a1b2c3')
    expect(message.blocks[0]?.kind).toBe('card')
  })

  it('turns a file into a link or an unavailable note without attachment capability', () => {
    const withUrl = degrade(
      { blocks: [{ kind: 'file', name: 'r.xlsx', mime: 'x', url: 'https://d/r.xlsx' }] },
      none,
    )
    expect(withUrl.msg.blocks[0]).toEqual({
      kind: 'link',
      title: 'r.xlsx',
      url: 'https://d/r.xlsx',
    })
    expect(withUrl.degraded).toEqual(['attachment'])

    const noUrl = degrade(
      {
        blocks: [{ kind: 'file', name: 'r.xlsx', mime: 'x', bytes: new Uint8Array(1) }],
      },
      none,
    )
    expect(noUrl.msg.blocks[0]).toEqual({ kind: 'text', markdown: 'r.xlsx（无法发送）' })
    expect(noUrl.degraded).toEqual(['attachment'])
  })

  it('prefixes text updates when edit is missing', () => {
    const result = degrade({ blocks: [{ kind: 'text', markdown: 'hello' }] }, none, { updating: true })

    expect(result.msg.blocks[0]).toEqual({ kind: 'text', markdown: '（更新）hello' })
    expect(result.degraded).toEqual(['edit'])
  })

  it('adds an update marker block before a non-text first block', () => {
    const result = degrade(
      { blocks: [{ kind: 'link', title: 'report', url: 'https://example.test/report' }] },
      none,
      { updating: true },
    )

    expect(result.msg.blocks[0]).toEqual({ kind: 'text', markdown: '（更新）' })
    expect(result.msg.blocks[1]).toEqual({
      kind: 'link',
      title: 'report',
      url: 'https://example.test/report',
    })
    expect(result.degraded).toEqual(['edit'])
  })
})

describe('escapeText and markdownSubset', () => {
  it('removes active HTML, keeps ordinary element text, removes zero-width chars and escapes text', () => {
    expect(escapeText('a<script>x</script>b\u200bc & d')).toBe('abc &amp; d')
    expect(escapeText('<b>safe</b> 1 < 2')).toBe('safe 1 &lt; 2')
  })

  it('keeps only allowed markdown and never renders remote images or autolinks', () => {
    const source = '**b** `c` [t](https://u) ![i](https://img) https://raw.example'

    expect(markdownSubset(source, new Set(['bold', 'code']))).toBe(
      '**b** `c` t (https://u) i https://raw.example',
    )
    expect(markdownSubset(source, new Set(['bold', 'code', 'link']))).toBe(
      '**b** `c` [t](https://u) i https://raw.example',
    )
    expect(markdownSubset('**b**', new Set())).toBe('b')
  })

  it('removes list syntax when list markdown is unavailable', () => {
    expect(markdownSubset('- one\n* two', new Set())).toBe('one\ntwo')
    expect(markdownSubset('- one\n* two', new Set(['list']))).toBe('- one\n* two')
  })
})

describe('approvalAsText', () => {
  it('uses the first six ticket characters in the approval reply protocol', () => {
    const text = approvalAsText({
      kind: 'approval',
      title: 'A',
      summary: 's',
      risk: 'always',
      options: ['allow_once', 'reject_once'],
      ticket: 'a1b2c3d4',
    })

    expect(text).toContain('同意 a1b2c3')
    expect(text).toContain('拒绝 a1b2c3')
  })

  it('falls back to requestSeq without a ticket', () => {
    const text = approvalAsText({
      kind: 'approval',
      title: 'A',
      summary: 's',
      risk: 'always',
      options: ['allow_once', 'reject_once'],
      requestSeq: 42,
    })

    expect(text).toContain('同意 #42')
    expect(text).toContain('拒绝 #42')
  })
})
