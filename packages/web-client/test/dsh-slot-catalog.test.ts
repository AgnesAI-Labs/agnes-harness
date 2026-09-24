import { UI_SLOT_NAMES, WEB_CLIENT_MODULE_SLOT_NAMES } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  DSH_PUBLIC_SLOT_NAMES,
  DSH_RUNTIME_SUPPORTED_SLOT_NAMES,
  DSH_SLOT_CATALOG,
  DSH_SLOT_CATALOG_VERSION,
  DSH_SLOT_COUNTS,
  DSH_SLOT_NAMES,
  getDshSlotDefinition,
  isKnownDshSlot,
  isPublicDshSlot,
  isRuntimeSupportedDshSlot,
} from '../src/index.js'

describe('DSH client slot catalog', () => {
  it('freezes the 63 generated keys and their kind/scope counts', () => {
    expect(DSH_SLOT_CATALOG_VERSION).toBe('dsh-client-slots/v1')
    expect(DSH_SLOT_COUNTS).toEqual({
      total: 63,
      public: 62,
      hostOnly: 1,
      single: 30,
      list: 19,
      keyed: 11,
      chain: 3,
      root: 27,
      session: 33,
      sessionMaybe: 3,
    })
    expect(DSH_SLOT_NAMES).toHaveLength(63)
    expect(DSH_RUNTIME_SUPPORTED_SLOT_NAMES).toHaveLength(62)
    expect(new Set(DSH_SLOT_NAMES).size).toBe(63)
    expect(DSH_PUBLIC_SLOT_NAMES).not.toContain('root')
    expect(getDshSlotDefinition('root')).toMatchObject({
      kind: 'single',
      scope: 'root',
      hostOnly: true,
      public: false,
    })
  })

  it('keeps parent declarations unique and resolvable', () => {
    const names = new Set(DSH_SLOT_NAMES)
    for (const slot of DSH_SLOT_CATALOG) {
      if (slot.parent !== undefined) expect(names.has(slot.parent)).toBe(true)
      expect(slot.owner.length).toBeGreaterThan(0)
      expect(slot.fallback).toMatch(/^(host|empty|chain)$/)
    }
    expect(getDshSlotDefinition('sidebar.right.tab.document')?.parent).toBe('sidebar.right.pane.tab')
    expect(getDshSlotDefinition('conversation.composer')?.scope).toBe('session')
    expect(getDshSlotDefinition('conversation.composer.bar')?.scope).toBe('session-maybe')
  })

  it('separates the DSH component namespace from protocol data slots', () => {
    expect(UI_SLOT_NAMES).toEqual(['tool.card.inline', 'sidebar.action', 'status.line', 'notification'])
    expect(isKnownDshSlot('tool.card.inline')).toBe(false)
    expect(isKnownDshSlot('sidebar.right.tab.document')).toBe(true)
    expect(isPublicDshSlot('root')).toBe(false)
    expect(isPublicDshSlot('main')).toBe(true)
    expect(isRuntimeSupportedDshSlot('sidebar')).toBe(true)
    expect(isRuntimeSupportedDshSlot('settings.models.provider-card')).toBe(true)
    expect(isRuntimeSupportedDshSlot('rightbar')).toBe(true)
    expect(isRuntimeSupportedDshSlot('conversation.input.left')).toBe(true)
    expect(isRuntimeSupportedDshSlot('conversation.approval.detail')).toBe(true)
    expect(isRuntimeSupportedDshSlot('conversation.session.header.actions')).toBe(true)
    expect(isRuntimeSupportedDshSlot('conversation.composer.dock')).toBe(true)
    expect(isRuntimeSupportedDshSlot('conversation.hero.workspace')).toBe(true)
    expect(isRuntimeSupportedDshSlot('conversation.chat.assistant-actions')).toBe(true)
    expect(isRuntimeSupportedDshSlot('tool.view.cordis')).toBe(true)
    expect(isRuntimeSupportedDshSlot('sidebar.workspaces.directoryFlow')).toBe(true)
    expect(isRuntimeSupportedDshSlot('main')).toBe(true)
    expect(isRuntimeSupportedDshSlot('main.conversation')).toBe(true)
    expect(isRuntimeSupportedDshSlot('shell.overlay')).toBe(true)
    expect(isRuntimeSupportedDshSlot('conversation.composer')).toBe(true)
    expect(isRuntimeSupportedDshSlot('conversation.composer.bar')).toBe(true)
    expect(isRuntimeSupportedDshSlot('conversation.view')).toBe(true)
    expect(DSH_RUNTIME_SUPPORTED_SLOT_NAMES).not.toContain('root')
    expect(new Set(WEB_CLIENT_MODULE_SLOT_NAMES.filter((name) => isKnownDshSlot(name)))).toEqual(
      new Set(DSH_RUNTIME_SUPPORTED_SLOT_NAMES),
    )
  })
})
