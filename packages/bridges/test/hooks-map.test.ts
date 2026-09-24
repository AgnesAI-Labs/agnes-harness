import { HOOK_EVENTS } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { CC_HOOK_EVENTS, checkHooksMap, loadHooksMap, parseHooksMapJson } from '../src/index.js'

describe('hooks-map', () => {
  const map = loadHooksMap()

  it('contains exactly 27 Claude Code events, with 12 mapped and 15 explained gaps', () => {
    expect(Object.keys(map.events).sort()).toEqual([...CC_HOOK_EVENTS].sort())
    const mapped = Object.values(map.events).filter((entry) => entry.to !== null)
    const unmapped = Object.values(map.events).filter((entry) => entry.to === null)
    expect(mapped).toHaveLength(12)
    expect(unmapped).toHaveLength(15)
    expect(unmapped.every((entry) => Boolean(entry.reason))).toBe(true)
  })

  it('targets only the current 17-event protocol and extension-api vocabulary', () => {
    expect(HOOK_EVENTS).toHaveLength(17)
    for (const entry of Object.values(map.events))
      for (const target of entry.to ?? []) expect(HOOK_EVENTS).toContain(target)
  })

  it('pins corrected current field contracts instead of stale schema paths', () => {
    expect(map.events.PreCompact?.fields?.in).toEqual({
      trigger: 'reason (manual→requested, auto→threshold)',
      custom_instructions: 'customInstructions',
    })
    expect(map.events.PermissionRequest?.fields?.in).toEqual({
      tool_name: 'request.tool',
      tool_input: 'request.argvHash (sha256 of canonical JSON)',
    })
    expect(map.events.PermissionRequest?.unsupportedFields).toEqual(['decision', 'updatedPermissions'])
    expect(map.events.SessionStart?.unsupportedFields).toContain('additionalContext')
    expect(map.events.UserPromptSubmit?.unsupportedFields).toContain('prompt')
  })

  it('rejects malformed JSON without throwing', () => {
    const result = parseHooksMapJson('{broken')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems[0]).toMatch(/^invalid JSON:/)
  })

  it('rejects missing/unknown events, illegal targets, duplicates, and unknown keys', () => {
    const events = structuredClone(map.events) as Record<string, unknown>
    delete events.Notification
    events.Bogus = { to: null, reason: 'x' }
    events.Stop = { to: ['turn_stopping', 'turn_stopping', 'not_a_hook'], surprise: true }
    events.Setup = { to: null }
    const result = checkHooksMap({ version: 1, events, extra: true })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.problems).toContain('root: unknown key extra')
      expect(result.problems).toContain('missing Notification')
      expect(result.problems).toContain('unknown CC event Bogus')
      expect(result.problems).toContain('Stop: unknown key surprise')
      expect(result.problems).toContain('Stop.to: duplicate turn_stopping')
      expect(result.problems).toContain('Stop: unknown target not_a_hook')
      expect(result.problems).toContain('Setup: unmapped entry needs reason')
    }
  })

  it('accepts the checked-in fact table', () => {
    expect(checkHooksMap(map).ok).toBe(true)
  })
})
