/** @vitest-environment happy-dom */

import { settingsRoute } from '@agnes/web-units'
import { afterEach, expect, it, vi } from 'vitest'
import {
  clearSettingsLink,
  consumeSettingsLink,
  movedSettingsTarget,
  needsModelNotice,
  openMovedSettings,
  openMovedSettingsLink,
  rewriteMovedSettingsLink,
} from '../src/settings-redirects.js'

afterEach(() => history.replaceState(null, '', '/'))

it.each([
  ['plugins', '?page=plugins'],
  ['skills', '?page=plugins&tab=skills'],
  ['mcp', '?page=plugins&tab=mcp'],
  ['feedback', '?page=plugins&tab=review'],
  ['discover', '?page=plugins&tab=market'],
  ['examples', '?page=agents'],
  ['computer-use', '?page=plugins&tab=plugins.computer-use'],
  ['search', '?page=plugins&tab=plugins.search'],
  ['engines', '?page=plugins&tab=plugins.subagents'],
  ['subagents', '?page=plugins&tab=plugins.subagents'],
  ['schedules', '?page=automation&tab=schedules'],
  ['triggers', '?page=automation&tab=triggers'],
])('opens the new home of an old settings link (%s)', (id, search) => {
  history.replaceState(null, '', `/?settings=${id}#settings-subsection-${id}`)
  expect(rewriteMovedSettingsLink()?.kind).toBe('page')
  expect(location.search).toBe(search)
  expect(location.hash).toBe('')
})

it('leaves links to pages the dialog still owns, and to sidebar targets, for the caller', () => {
  for (const id of [
    'model',
    'general',
    'security',
    'credentials',
    'models',
    'bundles',
    'diagnostics',
    'memory',
    'personalization',
    'execution',
    'custom-instructions',
  ]) {
    history.replaceState(null, '', `/?settings=${id}#keep`)
    expect(rewriteMovedSettingsLink()).toBeUndefined()
    expect(location.search).toBe(`?settings=${id}`)
    expect(location.hash).toBe('#keep')
  }
  history.replaceState(null, '', '/?settings=history')
  expect(rewriteMovedSettingsLink()).toEqual({ kind: 'session-search' })
  expect(location.search).toBe('?settings=history')
  expect(movedSettingsTarget('archived')).toEqual({ kind: 'archived-sessions' })
  history.replaceState(null, '', '/?session=abc')
  expect(rewriteMovedSettingsLink()).toBeUndefined()
  expect(location.search).toBe('?session=abc')
})

it('opens the sidebar search or the archived list for an old history or archive link', () => {
  const actions = { searchSessions: vi.fn(), showArchived: vi.fn() }
  history.replaceState(null, '', '/?settings=history&session=abc')
  expect(openMovedSettingsLink('history', actions)).toBe(true)
  expect(actions.searchSessions).toHaveBeenCalledOnce()
  expect(location.search).toBe('?session=abc')
  history.replaceState(null, '', '/?settings=archived')
  expect(openMovedSettingsLink('archived', actions)).toBe(true)
  expect(actions.showArchived).toHaveBeenCalledOnce()
  expect(location.search).toBe('')
  // Pages and sections the dialog owns are not this function's to open.
  for (const id of ['plugins', 'security', 'nope']) expect(openMovedSettingsLink(id, actions)).toBe(false)
  expect(actions.searchSessions).toHaveBeenCalledOnce()
  expect(actions.showArchived).toHaveBeenCalledOnce()
})

it('opens a moved page by its target: a home page with its tab, the search, or the archived list', () => {
  const actions = { openPage: vi.fn(), searchSessions: vi.fn(), showArchived: vi.fn() }
  for (const id of ['search', 'schedules', 'examples', 'history', 'archived']) {
    const target = movedSettingsTarget(id)
    if (target) openMovedSettings(target, actions)
  }
  expect(actions.openPage.mock.calls).toEqual([
    ['plugins', 'plugins.search'],
    ['automation', 'schedules'],
    ['agents', undefined],
  ])
  expect(actions.searchSessions).toHaveBeenCalledOnce()
  expect(actions.showArchived).toHaveBeenCalledOnce()
})

it.each([
  ['execution', 'models', 'settings-subsection-session-loop'],
  ['auxiliary-models', 'model', 'auxiliary-models'],
  ['personalization', 'general', 'settings-subsection-personalization'],
  ['memory', 'general', 'settings-subsection-memory'],
  ['custom-instructions', 'general', 'settings-subsection-custom-instructions'],
])(
  'a built-in capability that left the plugins page opens its one settings place (%s)',
  (id, page, anchor) => {
    expect(movedSettingsTarget(id)).toBeUndefined()
    expect(settingsRoute(id)).toEqual({ id: page, anchor })
  },
)

it('drops the settings page from the address when the dialog closes', () => {
  history.replaceState(null, '', '/?session=s1&settings=general#settings-subsection-general-language')
  clearSettingsLink()
  expect(location.search).toBe('?session=s1')
  expect(location.hash).toBe('')
  history.replaceState(null, '', '/?page=agents#keep')
  clearSettingsLink()
  expect(`${location.search}${location.hash}`).toBe('?page=agents#keep')
})

it('points at settings only when accounts exist and no model is usable', () => {
  expect(needsModelNotice({ modelsRead: true, models: 0, accounts: 1 })).toBe(true)
  // A first run with no account is guided by the first-run flow, a configured one needs nothing,
  // and a failed model read reports its own error.
  expect(needsModelNotice({ modelsRead: true, models: 0, accounts: 0 })).toBe(false)
  expect(needsModelNotice({ modelsRead: true, models: 2, accounts: 1 })).toBe(false)
  expect(needsModelNotice({ modelsRead: false, models: 0, accounts: 1 })).toBe(false)
})

it('redirects legacy settings links and preserves their destination across startup reads', () => {
  history.replaceState(null, '', '/?session=s1&settings=context#settings-subsection-context')
  expect(consumeSettingsLink()).toEqual({ id: 'models', anchor: 'settings-subsection-context' })
  expect(new URL(location.href).searchParams.get('settings')).toBe('models')
  expect(location.hash).toBe('#settings-subsection-context')
  expect(consumeSettingsLink()).toEqual({ id: 'models', anchor: 'settings-subsection-context' })
  history.replaceState(null, '', '/?page=plugins&tab=skills&settings=security#launcher-token')
  expect(consumeSettingsLink()).toEqual({ id: 'security', anchor: '' })
  expect(`${location.search}${location.hash}`).toBe(
    '?page=plugins&tab=skills&settings=security#launcher-token',
  )
  history.replaceState(null, '', '/#settings-subsection-context')
  expect(consumeSettingsLink()).toEqual({ id: '', anchor: '' })
  expect(location.hash).toBe('')
})

it('keeps a settings address readable across repeated startup reads', () => {
  history.replaceState(null, '', '/?session=s1&settings=diagnostics/otlp')
  expect(consumeSettingsLink()).toEqual({ id: 'diagnostics', anchor: '' })
  expect(consumeSettingsLink()).toEqual({ id: 'diagnostics', anchor: '' })
  expect(new URL(location.href).searchParams.get('settings')).toBe('diagnostics/otlp')
})
