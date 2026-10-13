import { describe, expect, it } from 'vitest'
import {
  isNewSessionShortcut,
  newSessionShortcutLabel,
  sortSessionsByRecency,
} from '../src/session-groups.js'

const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString()

describe('sidebar session order', () => {
  it('puts the newest session first and leaves undated rows last in the backend order', () => {
    const rows = [
      { id: 'undated-a' },
      { id: 'old', createdAt: at(1, 9) },
      { id: 'unreadable', createdAt: 'not a date' },
      { id: 'new', createdAt: at(13, 9) },
      { id: 'same-a', createdAt: at(5, 9) },
      { id: 'same-b', createdAt: at(5, 9) },
    ]
    expect(sortSessionsByRecency(rows).map((row) => row.id)).toEqual([
      'new',
      'same-a',
      'same-b',
      'old',
      'undated-a',
      'unreadable',
    ])
    expect(rows[0]?.id).toBe('undated-a')
    expect(sortSessionsByRecency([])).toEqual([])
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
