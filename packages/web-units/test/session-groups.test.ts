import { describe, expect, it } from 'vitest'
import {
  groupSessionsByTime,
  isNewSessionShortcut,
  newSessionShortcutLabel,
  sessionTimeGroup,
} from '../src/session-groups.js'

const now = new Date(2026, 9, 13, 15, 30)
const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString()

describe('sidebar session time groups', () => {
  it.each([
    ['this afternoon', at(13, 14), 'today'],
    ['the first minute of today', new Date(2026, 9, 13, 0, 0).toISOString(), 'today'],
    ['a clock slightly ahead', at(13, 23), 'today'],
    ['the last hour of yesterday', at(12, 23), 'yesterday'],
    ['the first minute of yesterday', new Date(2026, 9, 12, 0, 0).toISOString(), 'yesterday'],
    ['two days ago', at(11, 23), 'earlier'],
    ['an unreadable timestamp', 'not a date', 'earlier'],
    ['a missing timestamp', undefined, 'earlier'],
  ])('puts %s in %s', (_name, createdAt, group) => {
    expect(sessionTimeGroup(createdAt, now)).toBe(group)
  })

  it('orders groups by recency, keeps the backend order inside a group and omits empty groups', () => {
    const rows = [
      { id: 'old-a', createdAt: at(1, 9) },
      { id: 'today-a', createdAt: at(13, 9) },
      { id: 'old-b', createdAt: at(2, 9) },
      { id: 'today-b', createdAt: at(13, 8) },
    ]
    expect(
      groupSessionsByTime(rows, now).map((entry) => [entry.group, entry.rows.map((row) => row.id)]),
    ).toEqual([
      ['today', ['today-a', 'today-b']],
      ['earlier', ['old-a', 'old-b']],
    ])
    expect(groupSessionsByTime([], now)).toEqual([])
  })
})

describe('new session shortcut', () => {
  const key = (init: Partial<KeyboardEvent>) =>
    ({ key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent

  it('accepts the page chord on both platforms and ⌘N where the host delivers it', () => {
    expect(isNewSessionShortcut(key({ key: 'O', metaKey: true, shiftKey: true }))).toBe(true)
    expect(isNewSessionShortcut(key({ key: 'o', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(isNewSessionShortcut(key({ key: 'n', metaKey: true }))).toBe(true)
  })

  it('ignores plain typing and other chords', () => {
    expect(isNewSessionShortcut(key({ key: 'o' }))).toBe(false)
    expect(isNewSessionShortcut(key({ key: 'o', shiftKey: true }))).toBe(false)
    expect(isNewSessionShortcut(key({ key: 'o', metaKey: true }))).toBe(false)
    expect(isNewSessionShortcut(key({ key: 'n', metaKey: true, shiftKey: true }))).toBe(false)
    expect(isNewSessionShortcut(key({ key: 'o', metaKey: true, shiftKey: true, altKey: true }))).toBe(false)
  })

  it('labels the chord for the platform', () => {
    expect(newSessionShortcutLabel('MacIntel')).toBe('⇧⌘O')
    expect(newSessionShortcutLabel('Win32')).toBe('Ctrl+Shift+O')
    expect(newSessionShortcutLabel('')).toBe('Ctrl+Shift+O')
  })
})
