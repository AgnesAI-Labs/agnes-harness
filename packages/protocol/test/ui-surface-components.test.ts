import { describe, expect, it } from 'vitest'
import { validIntelligentSurface, validIntelligentSurfaceProjection } from '../src/ui-surface-validation.js'

const placement = { inline: true, workbench: true }
const sha = 'a'.repeat(64)
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const upload = (size = 128) => `agnes-upload://${sha}/${sha}/${size}/11111111-1111-4111-8111-111111111111`

function surface(components: unknown[], data: Record<string, unknown>, actions: unknown[] = []) {
  return { id: 'review', revision: 1, title: 'Review', placement, components, data, actions }
}
const accept = (value: unknown) => validIntelligentSurface(value)

describe('reviewed preset components', () => {
  it('keeps the phase-1 surface valid', () => {
    expect(
      accept(
        surface(
          [
            {
              id: 'differences',
              kind: 'table',
              dataKey: 'rows',
              rowKey: 'id',
              columns: [
                { key: 'id', label: 'Id' },
                { key: 'amount', label: 'Amount' },
              ],
              selection: 'multiple',
            },
            {
              id: 'amounts',
              kind: 'chart',
              chartType: 'bar',
              dataKey: 'chart',
              categoryKey: 'label',
              series: [{ key: 'amount', label: 'Amount' }],
            },
            {
              id: 'adjustment',
              kind: 'form',
              dataKey: 'form',
              schema: { type: 'object', properties: { reason: { type: 'string' } } },
            },
            { id: 'controls', kind: 'button-group', actionIds: [] },
            { id: 'summary', kind: 'status', dataKey: 'status' },
          ],
          {
            rows: [{ id: 'a', amount: 12 }],
            chart: [{ label: 'a', amount: 12 }],
            form: {},
            status: 'Review adjustments',
          },
        ),
      ),
    ).toBe(true)
  })

  const record = {
    id: 'card',
    kind: 'detail-card',
    title: 'Record',
    dataKey: 'record',
    fields: [
      { key: 'name', label: 'Name', format: 'text' },
      { key: 'amount', label: 'Amount', format: 'currency' },
      { key: 'posted', label: 'Posted', format: 'date' },
    ],
    statusKey: 'status',
    secondaryKey: 'note',
  }
  const steps = { id: 'flow', kind: 'steps', title: 'Review', dataKey: 'steps' }
  const progress = { id: 'posted', kind: 'progress', dataKey: 'progress' }
  const image = { id: 'scan', kind: 'image', dataKey: 'scan', alt: 'Receipt scan' }
  const when = {
    id: 'when',
    kind: 'form',
    dataKey: 'when',
    schema: {
      type: 'object',
      properties: {
        day: { type: 'string', format: 'date' },
        at: { type: 'string', format: 'date-time' },
        rows: {
          type: 'array',
          items: { type: 'object', properties: { day: { type: 'string', format: 'date' } } },
        },
      },
    },
  }

  it('accepts a detail card, steps, progress, an allowed image, and calendar fields', () => {
    const value = surface(
      [
        record,
        steps,
        progress,
        image,
        when,
        { id: 'sections', kind: 'tabs', tabs: [{ id: 'main', label: 'Main', componentIds: ['card'] }] },
      ],
      {
        record: { name: 'Ada', amount: 12, posted: '2026-10-10', status: 'open', note: 'Draft', extra: true },
        steps: [{ id: 'review', label: 'Review', state: 'active', description: 'Check the draft', extra: 1 }],
        progress: { label: 'Posted', value: 1, total: 4, percentage: 99 },
        scan: { source: { kind: 'data-url', dataUrl: png } },
        when: { day: '2024-02-29', at: '2026-10-10T00:00:00Z', rows: [{ day: '2026-10-10' }] },
      },
    )
    expect(accept(value)).toBe(true)
    expect(validIntelligentSurfaceProjection(value)).toBe(true)
  })

  it('accepts artifact and attachment image sources', () => {
    expect(
      accept(
        surface([image], {
          scan: { source: { kind: 'artifact', sha256: sha, size: 128, mime: 'image/jpeg' } },
        }),
      ),
    ).toBe(true)
    expect(accept(surface([image], { scan: { source: { kind: 'attachment', uri: upload() } } }))).toBe(true)
  })

  it('accepts an incomplete date draft and an offset time', () => {
    expect(accept(surface([when], { when: { day: '', at: null } }))).toBe(true)
    expect(accept(surface([when], { when: {} }))).toBe(true)
    expect(accept(surface([when], { when: { at: '2026-10-10T23:59:60Z' } }))).toBe(true)
    expect(accept(surface([when], { when: { at: '2026-10-10T00:00:00+00:00' } }))).toBe(true)
  })

  it('places a reviewed custom component inside a tab on a projection', () => {
    expect(
      validIntelligentSurfaceProjection(
        surface(
          [
            {
              id: 'diff',
              kind: 'finance/diff@1',
              dataKey: 'diff',
              fallback: 'Review the difference.',
              actionIds: [],
            },
            { id: 'sections', kind: 'tabs', tabs: [{ id: 'main', label: 'Main', componentIds: ['diff'] }] },
          ],
          { diff: { ok: true } },
        ),
      ),
    ).toBe(true)
  })

  it.each([
    ['missing field', { name: 'Ada', status: 'open', note: 'Draft' }],
    ['duplicate field key', { name: 'Ada', amount: 1, posted: '2026-10-10', status: 'open', note: 'Draft' }],
    ['empty status', { name: 'Ada', amount: 1, posted: '2026-10-10', status: '', note: 'Draft' }],
    ['numeric status', { name: 'Ada', amount: 1, posted: '2026-10-10', status: 1, note: 'Draft' }],
    ['long note', { name: 'Ada', amount: 1, posted: '2026-10-10', status: 'open', note: 'n'.repeat(1025) }],
  ])('refuses a detail card with %s', (_name, row) => {
    const fields =
      _name === 'duplicate field key'
        ? [
            { key: 'name', label: 'Name' },
            { key: 'name', label: 'Again' },
          ]
        : record.fields
    expect(accept(surface([{ ...record, fields }], { record: row }))).toBe(false)
  })

  it.each([
    ['bad state', [{ id: 'review', label: 'Review', state: 'later' }]],
    [
      'duplicate ids',
      [
        { id: 'review', label: 'Review', state: 'done' },
        { id: 'review', label: 'Again', state: 'pending' },
      ],
    ],
    ['empty list', []],
    ['empty description', [{ id: 'review', label: 'Review', state: 'done', description: '' }]],
    ['bad id', [{ id: '1review', label: 'Review', state: 'pending' }]],
    [
      'too many',
      Array.from({ length: 33 }, (_, index) => ({ id: `s${index}`, label: 'Step', state: 'pending' })),
    ],
  ])('refuses steps with %s', (_name, rows) => {
    expect(accept(surface([steps], { steps: rows }))).toBe(false)
  })

  it.each([
    ['negative', { label: 'Posted', value: -1, total: 4 }],
    ['zero total', { label: 'Posted', value: 0, total: 0 }],
    ['above total', { label: 'Posted', value: 5, total: 4 }],
    ['string value', { label: 'Posted', value: '1', total: 4 }],
    ['missing label', { value: 1, total: 4 }],
  ])('refuses progress with %s', (_name, row) => {
    expect(accept(surface([progress], { progress: row }))).toBe(false)
  })

  it.each([
    ['https', { source: { kind: 'data-url', dataUrl: 'https://example.com/a.png' } }],
    ['svg', { source: { kind: 'data-url', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' } }],
    ['javascript', { source: { kind: 'data-url', dataUrl: 'javascript:alert(1)' } }],
    ['blob', { source: { kind: 'data-url', dataUrl: 'blob:https://example.com/uuid' } }],
    ['file', { source: { kind: 'data-url', dataUrl: 'file:///tmp/a.png' } }],
    ['charset', { source: { kind: 'data-url', dataUrl: 'data:image/png;charset=utf-8;base64,AAAA' } }],
    [
      'oversized data url',
      { source: { kind: 'data-url', dataUrl: `data:image/png;base64,${'A'.repeat(17000)}` } },
    ],
    ['webp', { source: { kind: 'artifact', sha256: sha, size: 128, mime: 'image/webp' } }],
    [
      'uppercase digest',
      { source: { kind: 'artifact', sha256: 'A'.repeat(64), size: 128, mime: 'image/png' } },
    ],
    ['huge artifact', { source: { kind: 'artifact', sha256: sha, size: 33_554_433, mime: 'image/png' } }],
    [
      'extra source key',
      {
        source: {
          kind: 'artifact',
          sha256: sha,
          size: 128,
          mime: 'image/png',
          url: 'https://example.com/a.png',
        },
      },
    ],
    ['remote kind', { source: { kind: 'remote', url: 'https://example.com/a.png' } }],
    ['empty attachment', { source: { kind: 'attachment', uri: upload(0) } }],
    ['huge attachment', { source: { kind: 'attachment', uri: upload(33_554_433) } }],
    ['string source', { source: 'https://example.com/a.png' }],
  ])('refuses an image with %s', (_name, scan) => {
    expect(accept(surface([image], { scan }))).toBe(false)
  })

  it('refuses an image without alt text', () => {
    expect(
      accept(
        surface([{ id: 'scan', kind: 'image', dataKey: 'scan' }], {
          scan: { source: { kind: 'data-url', dataUrl: png } },
        }),
      ),
    ).toBe(false)
  })

  it.each([
    ['impossible day', { day: '2026-02-31' }],
    ['non-leap day', { day: '2023-02-29' }],
    ['bare time', { at: '2026-10-10T00:00' }],
    ['bad leap second', { at: '2026-10-10T23:58:60Z' }],
    ['number', { day: 20261010 }],
    ['nested day', { rows: [{ day: '2026-02-31' }] }],
  ])('refuses a form date with %s', (_name, whenData) => {
    expect(accept(surface([when], { when: whenData }))).toBe(false)
  })

  const note = { id: 'note', kind: 'text', dataKey: 'note' }
  const other = { id: 'other', kind: 'status', dataKey: 'status' }
  const tabs = (componentIds: string[], id = 'main') => ({
    id: 'sections',
    kind: 'tabs',
    tabs: [{ id, label: 'Main', componentIds }],
  })

  it.each([
    ['missing component', [tabs(['absent'])], { note: 'hello' }],
    ['self reference', [tabs(['sections'])], {}],
    [
      'nested tabs',
      [
        note,
        tabs(['inner']),
        { id: 'inner', kind: 'tabs', tabs: [{ id: 'child', label: 'Child', componentIds: ['note'] }] },
      ],
      { note: 'hello' },
    ],
    [
      'duplicate placement',
      [
        note,
        {
          id: 'sections',
          kind: 'tabs',
          tabs: [
            { id: 'main', label: 'Main', componentIds: ['note'] },
            { id: 'more', label: 'More', componentIds: ['note'] },
          ],
        },
      ],
      { note: 'hello' },
    ],
    [
      'duplicate tab ids',
      [
        note,
        other,
        {
          id: 'sections',
          kind: 'tabs',
          tabs: [
            { id: 'main', label: 'Main', componentIds: ['note'] },
            { id: 'main', label: 'Again', componentIds: ['other'] },
          ],
        },
      ],
      { note: 'hello', status: 'ok' },
    ],
    [
      'two tab groups',
      [
        note,
        tabs(['note']),
        { id: 'again', kind: 'tabs', tabs: [{ id: 'side', label: 'Side', componentIds: ['note'] }] },
      ],
      { note: 'hello' },
    ],
  ])('refuses tabs with %s', (_name, components, data) => {
    expect(accept(surface(components, data))).toBe(false)
  })
})
