import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { UI_SLOT_MAX_BYTES, UI_SLOT_NAMES, UI_SLOT_TABLE, validateSlotPayload } from '../src/index.js'
import { type Fixture, runFixtureLine } from '../tools/conformance-core.js'

describe('slots', () => {
  it('four slots, each with a table row', () => {
    expect(UI_SLOT_NAMES).toEqual(['tool.card.inline', 'sidebar.action', 'status.line', 'notification'])
    expect(Object.keys(UI_SLOT_TABLE).sort()).toEqual([...UI_SLOT_NAMES].sort())
    expect(UI_SLOT_TABLE.notification.surfaces).toEqual(['web', 'channel'])
    expect(UI_SLOT_TABLE['sidebar.action'].trigger).toEqual(['turn_end', 'tick'])
    // The order values start at 100 and step by 100, leaving room to insert a slot between two
    // existing ones without renumbering anything.
    expect(UI_SLOT_NAMES.map((n) => UI_SLOT_TABLE[n].order)).toEqual([100, 200, 300, 400])
  })
  // The UI set must not shadow the seven model slots this package already exports. Importing both
  // under one name would have been a duplicate-export compile error; this keeps it from coming back.
  it('does not collide with the seven model slots', async () => {
    const { SLOT_NAMES } = await import('../src/index.js')
    expect(SLOT_NAMES).toHaveLength(7)
    expect(SLOT_NAMES).toContain('primary')
    expect(UI_SLOT_NAMES as readonly string[]).not.toContain('primary')
  })
  // The byte cap is data this package publishes and does NOT enforce. Pinning the number is all
  // this package can honestly do; the truncation happens at the extension host and in the UI
  // projection, so nothing here should be read as protection.
  it('publishes the slot payload byte cap without enforcing it', () => {
    expect(UI_SLOT_MAX_BYTES).toBe(65536)
    // Built entirely from values inside the schema's own per-field limits, and still far over the
    // cap once serialised. Valid here, and someone else's job to refuse.
    const overCap = {
      title: 'wide report',
      table: {
        columns: ['a'],
        rows: Array.from({ length: 200 }, () => ['x'.repeat(1024)]),
      },
    }
    expect(JSON.stringify(overCap).length).toBeGreaterThan(UI_SLOT_MAX_BYTES)
    const r = validateSlotPayload('tool.card.inline', overCap)
    expect(r.ok, r.ok ? '' : JSON.stringify(r.errors)).toBe(true)
  })
  it('validates tool.card.inline with a table and actions', () => {
    const ok = validateSlotPayload('tool.card.inline', {
      title: 'monthly sales',
      table: { columns: ['region', 'amount'], rows: [['east', '1,200']] },
      actions: [{ id: 'export', label: 'Export' }],
    })
    expect(ok.ok, ok.ok ? '' : JSON.stringify(ok.errors)).toBe(true)
    expect(
      validateSlotPayload('tool.card.inline', { title: 'x', actions: [{ id: 'Bad Id', label: 'y' }] }).ok,
    ).toBe(false)
  })
  it('rejects function-shaped junk and unknown keys', () => {
    const r = validateSlotPayload('status.line', { text: 'ok', level: 'info', onClick: 'fn' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toMatchObject({ code: 'UNKNOWN_KEY', key: 'onClick' })
  })
  // validateSlotPayload resolves its schema through the table, so a table row naming a definition
  // that does not exist is a real failure mode. Walk both refusals rather than leave them unproven.
  it('refuses a slot the table does not describe, and a row naming a missing payload', () => {
    expect(() => validateSlotPayload('nope' as (typeof UI_SLOT_NAMES)[number], {})).toThrow(
      /missing the table row/,
    )
    const row = UI_SLOT_TABLE['status.line']
    const original = row.payload
    ;(row as { payload: string }).payload = 'NoSuchPayload'
    try {
      expect(() => validateSlotPayload('status.line', {})).toThrow(/does not exist/)
    } finally {
      ;(row as { payload: string }).payload = original
    }
  })
  it('the checked-in slot fixtures agree with the validator', () => {
    const lines = readFileSync(new URL('../fixtures/slots/slots.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .filter(Boolean)
    expect(lines.length).toBe(8) // four slots x (one positive + one negative)
    for (const line of lines) {
      const f = JSON.parse(line) as Fixture
      expect(runFixtureLine(f).pass, f.id).toBe(true)
    }
  })
})
