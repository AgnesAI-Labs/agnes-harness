import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOOK_EVENTS, HOOK_TABLE, SLOT_NAMES, SLOT_TABLE, TOOL_META_KEYS } from '../src/index.js'
import {
  generateAll,
  renderHooksDoc,
  renderSlotsDoc,
  renderToolsMetaDoc,
  schemaSummary,
} from '../tools/gen-docs-core.js'

describe('author documentation generation', () => {
  it('has all hooks, their policy and nonempty schema-linked descriptions', () => {
    const docs = generateAll(),
      hooks = docs['hooks.md'] ?? ''
    expect(hooks.match(/^\| `[a-z_]+` \|/gm)).toHaveLength(17)
    expect(hooks).toContain('| `tool_call` | serial | directive | closed | 2000 | – |')
    expect(hooks).toContain('| `session_start` | parallel | observe | open | 500 | ✓ |')
    expect(hooks).toContain('hooks.json#/$defs/ContextPayload')
    expect(hooks).toContain('required: sections, surfaceDigest')
    expect(hooks).toContain('wire schema')
    expect(hooks).not.toContain(' |  |')
  })
  it('documents the new author contracts from their schemas', () => {
    const docs = generateAll()
    expect(docs['services.md']).toContain(
      'required: name, kind, inputSchema, outputSchema, timeoutMs, maxResultBytes',
    )
    expect(docs['projections.md']).toContain('required: name, inputEventTypes, maxStateBytes')
  })
  it('uses all four real slots and eight metadata keys in order', () => {
    const docs = generateAll(),
      slots = docs['slots.md'] ?? '',
      tools = docs['tools-meta.md'] ?? ''
    expect(slots).toContain('| `notification` | multi | 400 | web, channel | open |')
    expect(slots.match(/^\| `[a-z.]+` \|/gm)).toHaveLength(4)
    expect((tools.match(/^\| `([^`]+)` \|/gm) ?? []).map((row) => row.split('`')[1])).toEqual([
      ...TOOL_META_KEYS,
    ])
    expect(tools).toContain('does not override explicit approval or concurrency flags')
  })
  it('escapes table delimiters, newlines and HTML while retaining generated links', () => {
    const descriptions = Object.fromEntries(
      HOOK_EVENTS.map((e) => [e, { payload: '<x>|a\nb', ret: 'null' }]),
    ) as Parameters<typeof renderHooksDoc>[0]['descriptions']
    expect(renderHooksDoc({ table: HOOK_TABLE, descriptions })).toContain('&lt;x&gt;&#124;a<br>b')
    const payloadDescriptions = Object.fromEntries(SLOT_NAMES.map((s) => [s, 'payload|text'])) as Parameters<
      typeof renderSlotsDoc
    >[0]['payloadDescriptions']
    expect(renderSlotsDoc({ table: SLOT_TABLE, payloadDescriptions })).toContain('payload&#124;text')
    expect(renderToolsMetaDoc({ keys: ['a'], descriptions: { a: 'x|y' } })).toContain('x&#124;y')
  })
  it('refuses missing source definitions or descriptions', () => {
    expect(() => schemaSummary({ $defs: {} }, 'hooks.json', 'Missing')).toThrow(/missing definition/)
    expect(() => renderToolsMetaDoc({ keys: ['a'], descriptions: {} })).toThrow(/missing/)
  })
  it('checked-in documents exactly match generation', () => {
    for (const [file, fresh] of Object.entries(generateAll()))
      expect(readFileSync(new URL(`../docs/${file}`, import.meta.url), 'utf8'), file).toBe(fresh)
  })
})
