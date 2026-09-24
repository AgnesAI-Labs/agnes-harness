import { describe, expect, it } from 'vitest'
import {
  assertBuiltinWebUnitContract,
  BUILTIN_WEB_UNITS,
  BuiltinWebUnitRegistry,
  builtinWebUnitRows,
  getBuiltinWebUnit,
} from '../src/index.js'

describe('built-in web unit contract', () => {
  it('publishes stable web rows with one contributes.client entry per unit', () => {
    expect(BUILTIN_WEB_UNITS.length).toBeGreaterThanOrEqual(12)
    const rowIds = new Set<string>()
    for (const definition of BUILTIN_WEB_UNITS) {
      assertBuiltinWebUnitContract(definition)
      expect(rowIds.has(definition.rowId)).toBe(false)
      rowIds.add(definition.rowId)
      expect(definition.rowId).toBe(`web:${definition.packageId}`)
      expect(definition.contributes.entry).toBe(definition.entry)
      expect(definition.contributes.slots.length).toBeGreaterThan(0)
    }
  })

  it('keeps settings panes and conversation child fills independently addressable', () => {
    for (const packageId of [
      '@agnes/web-settings-model',
      '@agnes/web-settings-plugins',
      '@agnes/web-settings-resources',
      '@agnes/web-settings-computer-use',
      '@agnes/web-settings-archived',
      '@agnes/web-settings-appearance',
      '@agnes/web-conversation-message-actions',
      '@agnes/web-conversation-attachments',
      '@agnes/web-conversation-tool-card',
      '@agnes/web-conversation-feedback',
    ]) {
      expect(getBuiltinWebUnit(packageId)?.rowId).toBe(`web:${packageId}`)
    }
  })

  it('projects rows without sharing mutable contribution arrays', () => {
    const first = builtinWebUnitRows()
    const second = builtinWebUnitRows()
    expect(first).not.toBe(second)
    const firstSlots = first[0]?.slots as string[]
    firstSlots.push('test-only')
    expect(second[0]?.slots).not.toContain('test-only')
  })

  it('unmounts one unit without touching a sibling unit', () => {
    const registry = new BuiltinWebUnitRegistry()
    const disposed: string[] = []
    registry.mount('@agnes/web-sidebar', () => disposed.push('sidebar'))
    registry.mount('@agnes/web-transcript', () => disposed.push('transcript'))

    registry.unmount('@agnes/web-sidebar')
    expect(disposed).toEqual(['sidebar'])
    expect(registry.get('@agnes/web-sidebar')).toBeUndefined()
    expect(registry.get('@agnes/web-transcript')?.definition.rowId).toBe('web:@agnes/web-transcript')
    expect(registry.snapshot().map((row) => row.rowId)).toEqual(['web:@agnes/web-transcript'])

    registry.dispose()
    expect(disposed).toEqual(['sidebar', 'transcript'])
  })

  it('requires parent units before mounting conversation child fills', () => {
    const registry = new BuiltinWebUnitRegistry()
    expect(() => registry.mount('@agnes/web-conversation-feedback', () => undefined)).toThrow(
      'requires mounted dependency @agnes/web-conversation',
    )
    registry.mount('@agnes/web-conversation', () => undefined)
    registry.mount('@agnes/web-conversation-feedback', () => undefined)
    expect(registry.snapshot().map((row) => row.rowId)).toEqual([
      'web:@agnes/web-conversation',
      'web:@agnes/web-conversation-feedback',
    ])
    registry.unmount('@agnes/web-conversation')
    expect(registry.snapshot()).toEqual([])
  })
})
