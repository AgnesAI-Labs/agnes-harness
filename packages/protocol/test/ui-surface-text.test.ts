import { describe, expect, it } from 'vitest'
import type { UiSurface } from '../gen/ts/intelligent-ui.js'
import { surfaceText } from '../src/ui-surface-text.js'

const sha = 'a'.repeat(64)
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('preset surface text', () => {
  it('keeps declared table columns and omits extra row keys', () => {
    const surface: UiSurface = {
      id: 'rows',
      revision: 1,
      title: 'Rows',
      placement: { inline: true, workbench: true },
      components: [
        {
          id: 'table',
          kind: 'table',
          dataKey: 'rows',
          rowKey: 'id',
          selection: 'none',
          columns: [
            { key: 'a', label: 'a' },
            { key: 'b', label: 'b' },
          ],
        },
      ],
      data: { rows: [{ id: '1', a: '1', b: '22', extra: 'hidden' }] },
      actions: [],
    }
    expect(surfaceText(surface)).toBe('Rows (revision 1)\na | b\n1 | 22')
  })

  it('prints detail, steps, progress, image identity, dates and tabs once', () => {
    const surface: UiSurface = {
      id: 'presets',
      revision: 1,
      title: 'Presets',
      placement: { inline: true, workbench: true },
      components: [
        {
          id: 'card',
          kind: 'detail-card',
          title: 'Record',
          dataKey: 'record',
          fields: [
            { key: 'name', label: 'Name' },
            { key: 'amount', label: 'Amount', format: 'currency' },
            { key: 'posted', label: 'Posted', format: 'date' },
          ],
          statusKey: 'status',
          secondaryKey: 'note',
        },
        { id: 'flow', kind: 'steps', title: 'Flow', dataKey: 'steps' },
        { id: 'posted', kind: 'progress', dataKey: 'progress' },
        { id: 'scan', kind: 'image', dataKey: 'scan', alt: 'Receipt scan' },
        { id: 'proof', kind: 'image', title: 'Proof', dataKey: 'proof', alt: 'Authorized receipt' },
        {
          id: 'when',
          kind: 'form',
          dataKey: 'when',
          schema: {
            type: 'object',
            properties: {
              day: { type: 'string', format: 'date', title: 'Day' },
              at: { type: 'string', format: 'date-time', title: 'At' },
              empty: { type: 'string', format: 'date', title: 'Empty' },
              reason: { type: 'string', title: 'Reason' },
            },
          },
        },
        { id: 'note', kind: 'text', title: 'Note', dataKey: 'note' },
        { id: 'state', kind: 'status', dataKey: 'state' },
        {
          id: 'sections',
          kind: 'tabs',
          title: 'Sections',
          tabs: [
            { id: 'main', label: 'Main', componentIds: ['note'] },
            { id: 'more', label: 'More', componentIds: ['state'] },
          ],
        },
      ],
      data: {
        record: { name: 'Ada', amount: 250, posted: '2026-10-10', status: 'open', note: 'Draft' },
        steps: [
          { id: 'review', label: 'Review', state: 'active', description: 'Check' },
          { id: 'record', label: 'Record', state: 'pending' },
        ],
        progress: { label: 'Posted', value: 1, total: 4, percentage: 99 },
        scan: { source: { kind: 'data-url', dataUrl: png } },
        proof: { source: { kind: 'artifact', sha256: sha, size: 128, mime: 'image/png' } },
        when: { day: '2026-10-10', at: '2026-10-10T00:00:00Z', empty: '', reason: 'reviewed' },
        note: 'Inside the first tab',
        state: 'Inside the second tab',
      },
      actions: [],
    }
    expect(surfaceText(surface)).toBe(
      [
        'Presets (revision 1)',
        'Record',
        'Name: Ada',
        'Amount: 250',
        'Posted: 2026-10-10',
        'open',
        'Draft',
        'Flow',
        'Review — active',
        'Check',
        'Record — pending',
        'Posted: 1/4 (25%)',
        'Receipt scan',
        'data-url',
        'Proof',
        'Authorized receipt',
        `artifact ${sha}`,
        'day: Day',
        'day: Day = 2026-10-10',
        'at: At',
        'at: At = 2026-10-10T00:00:00Z',
        'empty: Empty',
        'reason: Reason',
        'Sections',
        'Main',
        'Note',
        'Inside the first tab',
        'More',
        'Inside the second tab',
      ].join('\n'),
    )
    expect(surfaceText(surface)).not.toContain(png)
    expect(surfaceText(surface)).not.toContain('99')
  })
})
