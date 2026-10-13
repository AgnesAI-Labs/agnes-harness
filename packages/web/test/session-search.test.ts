/** @vitest-environment happy-dom */

import { expect, it } from 'vitest'
import { groupSessionHits, isSessionSearchShortcut, snippetParts } from '../src/session-search.js'

const hit = (sessionId: string, snippet: string, title = `Session ${sessionId}`) => ({
  sessionId,
  title,
  workspace: '/work/app',
  snippet,
  ts: '2026-10-14T00:00:00Z',
})

it('groups hits by session in first-hit order and keeps two distinct lines per session', () => {
  const groups = groupSessionHits([
    hit('a', 'first [refund]'),
    hit('b', 'other [refund]'),
    hit('a', 'first [refund]'),
    hit('a', 'second [refund]'),
    hit('a', 'third [refund]'),
  ])
  expect(groups.map((group) => group.sessionId)).toEqual(['a', 'b'])
  expect(groups[0]).toMatchObject({
    title: 'Session a',
    workspace: '/work/app',
    snippets: ['first [refund]', 'second [refund]'],
    matches: 4,
  })
  expect(groups[1]?.matches).toBe(1)
})

it('splits a snippet into matched and plain runs', () => {
  expect(snippetParts('…ask about the [refund] window, then [refund] it')).toEqual([
    { text: '…ask about the ', match: false },
    { text: 'refund', match: true },
    { text: ' window, then ', match: false },
    { text: 'refund', match: true },
    { text: ' it', match: false },
  ])
  expect(snippetParts('no match here')).toEqual([{ text: 'no match here', match: false }])
  expect(snippetParts('empty [] stays')).toEqual([{ text: 'empty [] stays', match: false }])
})

it('opens on the platform chord only', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
  expect(isSessionSearchShortcut(key({ key: 'k', metaKey: true }))).toBe(true)
  expect(isSessionSearchShortcut(key({ key: 'K', ctrlKey: true }))).toBe(true)
  expect(isSessionSearchShortcut(key({ key: 'k' }))).toBe(false)
  expect(isSessionSearchShortcut(key({ key: 'k', metaKey: true, shiftKey: true }))).toBe(false)
  expect(isSessionSearchShortcut(key({ key: 'k', ctrlKey: true, altKey: true }))).toBe(false)
})
