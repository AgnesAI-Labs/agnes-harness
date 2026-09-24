import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOOK_EVENTS, HOOK_TABLE, THEME_TOKEN_NAMES } from '../src/index.js'
import {
  extractThemeTokenNames,
  renderHookTable,
  renderSlotTable,
  renderThemeTokenTable,
} from '../tools/gen-tables-core.js'

const hooks = JSON.parse(readFileSync(new URL('../../protocol/schema/hooks.json', import.meta.url), 'utf8'))[
  'x-agnes-hook-table'
]
const slots = JSON.parse(readFileSync(new URL('../../protocol/schema/slots.json', import.meta.url), 'utf8'))[
  'x-agnes-slot-table'
]
const EXPECTED = {
  session_start: ['parallel', 'observe', 'open', 500, true],
  resources_discover: ['waterfall', 'transform', 'open', 1000, true],
  before_step: ['serial', 'directive', 'closed', 1000, false],
  context: ['waterfall', 'transform', 'closed', 1500, false],
  before_request: ['waterfall', 'transform', 'closed', 1500, false],
  before_provider_headers: ['waterfall', 'transform', 'closed', 500, false],
  request_error: ['parallel', 'observe', 'open', 500, false],
  tool_call: ['serial', 'directive', 'closed', 2000, false],
  tool_result: ['waterfall', 'transform', 'open', 2000, false],
  turn_stopping: ['serial', 'directive', 'open', 1000, false],
  approval_request: ['waterfall', 'transform', 'closed', 1000, false],
  before_compact: ['waterfall', 'transform', 'closed', 3000, false],
  compact: ['parallel', 'observe', 'open', 1000, false],
  subagent_start: ['emit', 'observe', 'open', 200, false],
  subagent_end: ['emit', 'observe', 'open', 200, false],
  format_deviation: ['parallel', 'observe', 'open', 500, false],
  shutdown: ['parallel', 'observe', 'open', 1000, false],
} as const
describe('generated author tables', () => {
  it('pins all seventeen approved five-tuples independently of generation', () => {
    for (const name of HOOK_EVENTS) {
      const row = HOOK_TABLE[name]
      expect([row.mode, row.category, row.failPolicy, row.timeoutMs, row.replayOnResume], name).toEqual(
        EXPECTED[name],
      )
    }
  })
  it('matches every protocol hook and preserves stable event order', () => {
    expect(HOOK_TABLE).toEqual(hooks)
    const reverse = Object.fromEntries(Object.entries(hooks).reverse())
    expect(renderHookTable(reverse)).toBe(renderHookTable(hooks))
    expect(HOOK_EVENTS.filter((e) => HOOK_TABLE[e].replayOnResume)).toEqual([
      'session_start',
      'resources_discover',
    ])
    expect(HOOK_TABLE.context.failPolicy).toBe('closed')
    expect(HOOK_TABLE.tool_call.timeoutMs).toBe(2000)
    expect(Reflect.set(HOOK_TABLE.context, 'failPolicy', 'open')).toBe(false)
    expect(Reflect.set(HOOK_TABLE, 'context', {})).toBe(false)
    expect(renderSlotTable(slots)).toContain('surfaces: Object.freeze(')
  })
  it('rejects incomplete, unknown and malformed metadata instead of generating permissive tables', () => {
    const missing = { ...hooks }
    delete missing.context
    expect(() => renderHookTable(missing)).toThrow(/missing/)
    expect(() => renderHookTable({ ...hooks, fake: hooks.context })).toThrow(/unknown/)
    for (const patch of [{ mode: 'emit' }, { timeoutMs: NaN }, { failPolicy: 'ignore' }, { injected: 'x' }])
      expect(() => renderHookTable({ ...hooks, context: { ...hooks.context, ...patch } })).toThrow(/invalid/)
    expect(() => renderSlotTable({})).toThrow(/missing/)
    expect(() =>
      renderSlotTable({ ...slots, notification: { ...slots.notification, surfaces: ['shell'] } }),
    ).toThrow(/invalid/)
  })
})

// The theme-token whitelist is generated from the Web client's stylesheet rather than a protocol
// schema, so the extractor is what keeps `style.css` the single colour authority. These cases pin
// both the extraction rule (second `:root` block only) and the drift guard's failure modes.
describe('theme token table generation', () => {
  const css = [
    ':root {',
    '  --agnes-color-neutral-500: #8d98b3;',
    '}',
    ':root {',
    '  --agnes-bg-page: var(--agnes-color-white);',
    '  --shadow-elevation: 0 4px 20px -12px rgb(0 0 0 / 12%);',
    '}',
    ':root {',
    '  --radius-md: 8px;',
    '}',
  ].join('\n')
  it('reads only the semantic block and drops the raw colour scale', () => {
    expect(extractThemeTokenNames(css)).toEqual(['--agnes-bg-page', '--shadow-elevation'])
    expect(extractThemeTokenNames(css)).not.toContain('--agnes-color-neutral-500')
    expect(extractThemeTokenNames(css)).not.toContain('--radius-md')
  })
  it('rejects a stylesheet without a usable semantic block', () => {
    expect(() => extractThemeTokenNames(':root { --a: 1; }')).toThrow('missing its semantic')
    expect(() => extractThemeTokenNames(':root { --a: 1; }\n:root { --b: 2;')).toThrow('unterminated')
    expect(() => extractThemeTokenNames(':root {}\n:root { /* empty */ }')).toThrow('declares no tokens')
  })
  it('renders a frozen whitelist whose membership set matches the array', () => {
    const text = renderThemeTokenTable(['--agnes-bg-page'])
    expect(text).toContain('"--agnes-bg-page",')
    expect(text).toContain('export const THEME_TOKEN_NAMES = Object.freeze([')
    expect(() => renderThemeTokenTable([])).toThrow('at least one')
    expect(() => renderThemeTokenTable(['agnes-bg-page'])).toThrow('invalid theme token name')
    expect(() => renderThemeTokenTable(['--a', '--a'])).toThrow('duplicate')
    // The checked-in artifact and the live stylesheet must agree, or gen:check has drifted.
    const live = extractThemeTokenNames(
      readFileSync(new URL('../../web/public/style.css', import.meta.url), 'utf8'),
    )
    expect([...THEME_TOKEN_NAMES]).toEqual(live)
    expect(live.length).toBeGreaterThan(40)
  })
})
