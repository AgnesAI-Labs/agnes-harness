import type { UINode } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { renderTable, ToolCard } from '../../src/tui/views/tool-card.js'

// DBH LOG-001 verification. Oracle is external to the renderer:
//   - packages/protocol/schema/slots.json:55-60 — `rows`' inner arrays have neither minItems nor
//     maxItems nor any binding to `columns.length`, so a ragged row is schema-valid.
//   - packages/core/src/project/ui.ts:648-657 — after schema + byte-cap checks the payload is
//     structuredClone'd onto `tool.slots` with no row/column normalisation.
// A renderer sitting behind those two must therefore survive a row longer than the header.
describe('DBH LOG-001: renderTable must survive a schema-valid ragged row', () => {
  it('[control] renders a well-formed table', () => {
    expect(renderTable({ columns: ['a', 'b'], rows: [['1', '22']] }, 20).map((l) => l.trimEnd())).toEqual([
      'a │ b',
      '1 │ 22',
    ])
  })

  // Preservation: the other side of the same boundary. A short row is already safe today and must
  // stay padded to its column, so clamping the overflow must not turn into clamping everything.
  it('[preserve] a row with fewer cells than columns still pads to the column width', () => {
    expect(renderTable({ columns: ['aaa', 'b'], rows: [['1']] }, 20).map((l) => l.trimEnd())).toEqual([
      'aaa │ b',
      '1',
    ])
  })

  it('does not throw when a data row has more cells than there are columns', () => {
    expect(() => renderTable({ columns: ['a'], rows: [['1', '2']] }, 20)).not.toThrow()
  })

  // Same defect reached through the component the renderer actually paints: ToolCard builds the
  // table block at packages/cli-tui/src/views/tool-card.ts:95 and Renderer.renderNow() calls
  // render(width) on it from an untrapped queueMicrotask (renderer.ts:88-97).
  it('does not throw while rendering an expanded ToolCard carrying that slot fill', () => {
    const node: Extract<UINode, { kind: 'tool' }> = {
      kind: 'tool',
      id: 't1',
      seq: 1,
      toolUseId: 'call-1',
      name: 'report',
      status: 'completed',
      summary: 'table',
      slots: [
        {
          slot: 'tool.card.inline',
          extId: 'ext.demo',
          payload: { title: 'Rows', table: { columns: ['a'], rows: [['1', '2']] } },
        } as never,
      ],
    }
    const card = new ToolCard(node, { collapsed: false })
    expect(() => card.render(80)).not.toThrow()
  })
})
