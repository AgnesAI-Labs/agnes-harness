import type { UITimeline } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { escapeHtml, renderHtml } from '../src/html/template.js'

const timeline = (nodes: UITimeline['nodes']): UITimeline => ({
  sessionId: 's1',
  upto: 8,
  generation: 1,
  opState: null,
  nodes,
  turns: [],
})

describe('export --html', () => {
  it('renders the projection as an escaped, self-contained inert document', () => {
    const html = renderHtml(
      timeline([
        {
          id: 'u',
          kind: 'user',
          seq: 1,
          content: [
            { type: 'text', text: '<b>x</b> & y' },
            { type: 'resource_link', uri: 'https://example.test/?x=<bad>', name: 'reference' },
          ],
        },
        { id: 'a', kind: 'assistant', seq: 2, text: '**bold** <script>alert(1)</script>' },
        {
          id: 't',
          kind: 'tool',
          seq: 3,
          toolUseId: 'call',
          name: 'shell',
          status: 'completed',
          summary: 'ls',
        },
        {
          id: 'p',
          kind: 'approval',
          seq: 4,
          state: 'decided',
          summary: 'rm',
          risk: 'destructive',
          options: ['reject_once'],
          decision: { verdict: 'rejected', via: 'user' },
        },
      ]),
      { sessionId: 's1<title>', exportedAt: '2026-09-08T00:00:00Z', redacted: true },
    )

    expect(html).toContain('<style>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<link')
    expect(html).not.toContain('<img')
    expect(html).not.toMatch(/(?:src|href)=["']https?:/)
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('https://example.test/?x=&lt;bad&gt;')
    expect(html).toContain('<details')
    expect(html).toContain('shell · completed')
    expect(html).toContain('Approval · rejected')
    expect(html).toContain('redacted')
    expect(html).toContain('<title>s1&lt;title&gt;</title>')
  })

  it('renders cost, artifact, compaction and slot nodes, and drops context nodes', () => {
    const html = renderHtml(
      timeline([
        { id: 'c', kind: 'cost', seq: 5, source: 'estimated', credits: 1.25, purpose: 'turn' },
        {
          id: 'r',
          kind: 'artifact',
          seq: 6,
          name: 'report.pdf',
          ref: { sha256: 'a'.repeat(64), size: 42, mime: 'application/pdf' },
        },
        { id: 'x', kind: 'compaction', seq: 7, range: [1, 5], summary: 'summary' },
        {
          id: 's',
          kind: 'slot',
          seq: 8,
          fill: { slot: 'status.line', extId: 'example', payload: { text: 'ready' } },
        },
        { id: 'ctx', kind: 'context', seq: 9, text: '{"model":"x"}' },
      ]),
      { sessionId: 's1', exportedAt: 'now', redacted: false },
    )

    expect(html).toContain('credits 1.25 (estimated) · turn')
    expect(html).toContain('Artifact · report.pdf · 42 B · application/pdf')
    expect(html).toContain('compacted 1–5 · summary')
    expect(html).toContain('Extension slot · status.line · example')
    expect(html).toContain('raw')
    // A harness-internal environment snapshot gets no section in the export: not the label, not
    // the payload, not an empty shell where it used to be.
    expect(html).not.toContain('class="node minor context"')
    expect(html).not.toContain('<div class="label">Context</div>')
    expect(html).not.toContain('{&quot;model&quot;:&quot;x&quot;}')
    // The four nodes that do render are still joined one per line, with no blank line left behind.
    expect(html).not.toContain('\n\n')
    expect(html).not.toContain('User · system')
  })

  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
  })
})
