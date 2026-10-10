import { describe, expect, it } from 'vitest'
import {
  componentDataValid,
  uiDataBinding,
  validIntelligentSurface,
  validIntelligentSurfaceProjection,
} from '../src/ui-surface-validation.js'

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
            { id: 'controls', kind: 'button-group', actionIds: ['approve'] },
            { id: 'summary', kind: 'status', dataKey: 'status' },
          ],
          {
            rows: [{ id: 'a', amount: 12 }],
            chart: [{ label: 'a', amount: 12 }],
            form: {},
            status: 'Review adjustments',
          },
          [
            {
              id: 'approve',
              label: 'Approve',
              tool: 'approve',
              argsTemplate: {},
              paramsSchema: true,
            },
          ],
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

  const boundTable = {
    id: 'differences',
    kind: 'table',
    dataKey: 'rows',
    rowKey: 'id',
    columns: [
      { key: 'id', label: 'Id' },
      { key: 'amount', label: 'Amount' },
    ],
    selection: 'none',
  }
  const boundChart = {
    id: 'amounts',
    kind: 'chart',
    chartType: 'bar',
    dataKey: 'rows',
    categoryKey: 'label',
    series: [{ key: 'amount', label: 'Amount' }],
  }
  const source = (params: Record<string, unknown> = {}, id = 'finance/differences') => ({
    $source: id,
    params,
  })

  it('accepts one binding shared by a table and a chart, and an empty literal table', () => {
    const value = surface([boundTable, boundChart], { rows: source() })
    expect(uiDataBinding(source() as never)).toBe(true)
    expect(accept(value)).toBe(true)
    expect(validIntelligentSurfaceProjection(value)).toBe(true)
    expect(accept(surface([boundTable], { rows: [] }))).toBe(true)
  })

  it('rejects a binding that widens authority, breaks shape, or disagrees across components', () => {
    expect(accept(surface([boundTable], { rows: source({ actor: 'root' }) }))).toBe(false)
    expect(accept(surface([boundTable], { rows: source({ filter: { role: 'admin' } }) }))).toBe(false)
    expect(accept(surface([boundTable], { rows: { ...source(), note: true } }))).toBe(false)
    expect(accept(surface([boundTable], { rows: { $source: 'finance/differences' } }))).toBe(false)
    expect(accept(surface([boundTable], { rows: source({}, 'Finance/differences') }))).toBe(false)
    expect(accept(surface([boundTable], { rows: source({}, 'finance') }))).toBe(false)
    expect(accept(surface([boundTable], { rows: source({ blob: 'x'.repeat(5000) }) }))).toBe(false)
    const wide = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, 1]))
    expect(accept(surface([boundTable], { rows: source(wide) }))).toBe(false)
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let index = 0; index < 8; index += 1) deep = { child: deep }
    expect(accept(surface([boundTable], { rows: source(deep) }))).toBe(false)
    expect(
      accept(surface([boundTable, { id: 'summary', kind: 'text', dataKey: 'rows' }], { rows: source() })),
    ).toBe(false)
    expect(accept(surface([boundTable], { rows: [{ amount: 1 }] }))).toBe(false)
    const many = Array.from({ length: 9 }, (_, index) => ({
      id: `t${index}`,
      kind: 'text',
      dataKey: `k${index}`,
    }))
    expect(accept(surface(many, Object.fromEntries(many.map((item) => [item.dataKey, source()]))))).toBe(
      false,
    )
    expect(
      accept(
        surface(
          many.slice(0, 8),
          Object.fromEntries(many.slice(0, 8).map((item) => [item.dataKey, source()])),
        ),
      ),
    ).toBe(true)
  })

  it('checks resolved rows per component and does not treat a binding as rows', () => {
    const component = boundTable as never
    expect(componentDataValid(component, source() as never)).toBe(false)
    expect(componentDataValid(component, [{ id: 'a', amount: 12 }] as never)).toBe(true)
    expect(componentDataValid(component, [{ amount: 12 }] as never)).toBe(false)
  })
})
