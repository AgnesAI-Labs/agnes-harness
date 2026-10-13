/** @vitest-environment happy-dom */

import { afterEach, expect, it, vi } from 'vitest'
import {
  movedSettingsTarget,
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
  ['computer-use', '?page=plugins'],
  ['search', '?page=plugins'],
  ['schedules', '?page=automation&tab=schedules'],
  ['triggers', '?page=automation&tab=triggers'],
])('opens the new home of an old settings link (%s)', (id, search) => {
  history.replaceState(null, '', `/?settings=${id}#settings-subsection-${id}`)
  expect(rewriteMovedSettingsLink()?.kind).toBe('page')
  expect(location.search).toBe(search)
  expect(location.hash).toBe('')
})

it('leaves links to pages the dialog still owns, and to sidebar targets, for the caller', () => {
  for (const id of ['model', 'general', 'security', 'credentials', 'models', 'bundles', 'diagnostics']) {
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
