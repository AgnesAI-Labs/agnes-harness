import { describe, expect, it } from 'vitest'
import {
  AGNES_NS,
  EVENT_TYPES,
  EXT_EVENT_PATTERN,
  isEventType,
  MAX_FRAME_BYTES,
  MAX_RUNTIME_TARGET_ARTIFACT_BASE64_LENGTH,
  META_KEY,
  UI_HISTORY_DEFAULT_LIMIT,
  UI_HISTORY_MAX_LIMIT,
  UI_OPENING_DEFAULT_MAX_NODES,
  UI_OPENING_MAX_NODES,
  UI_PROJECTION_DEFAULT_MAX_BYTES,
  UI_PROJECTION_MAX_BYTES,
  UI_PROJECTION_MIN_MAX_BYTES,
  UI_PROJECTION_RESYNC_REQUIRED,
} from '../src/index.js'

describe('constants', () => {
  it('freezes 31 event types', () => {
    expect(EVENT_TYPES).toHaveLength(31)
    expect(new Set(EVENT_TYPES).size).toBe(31)
    // The program counter is a register cell, not a row.
    expect(EVENT_TYPES).not.toContain('op.state')
    for (const t of [
      'session/start',
      'turn/end',
      'harness/refine',
      'tool/result',
      'request/sent',
      'subagent/cost',
    ])
      expect(EVENT_TYPES).toContain(t)
  })
  it('accepts extension namespace shapes and rejects others', () => {
    expect(isEventType('x/core/invariant')).toBe(true)
    expect(isEventType('x/agnes/subagent/worktree-skipped')).toBe(true)
    expect(isEventType('x/xinwei/sales-analysis/foo')).toBe(true)
    expect(isEventType('x/xinwei/foo')).toBe(false) // the three-segment form is reserved for core / agnes
    expect(isEventType('x/Core/bad')).toBe(false)
    expect(isEventType('user/message')).toBe(true)
    expect(isEventType('user/msg')).toBe(false)
    expect(EXT_EVENT_PATTERN.test('x/core/invariant')).toBe(true)
  })
  it('exposes namespace constants', () => {
    expect(META_KEY).toBe('ai.agnes.harness')
    expect(AGNES_NS).toBe('_agnes/v1')
  })
  it('reserves the fixed runtime.stale envelope inside the frame ceiling', () => {
    expect(MAX_RUNTIME_TARGET_ARTIFACT_BASE64_LENGTH).toBe(16_776_788)
    expect(MAX_RUNTIME_TARGET_ARTIFACT_BASE64_LENGTH % 4).toBe(0)
    expect(MAX_RUNTIME_TARGET_ARTIFACT_BASE64_LENGTH).toBeLessThan(MAX_FRAME_BYTES)
  })
  it('freezes bounded UI opening/history defaults and hard ceilings', () => {
    expect(UI_OPENING_DEFAULT_MAX_NODES).toBe(200)
    expect(UI_OPENING_MAX_NODES).toBe(500)
    expect(UI_HISTORY_DEFAULT_LIMIT).toBe(100)
    expect(UI_HISTORY_MAX_LIMIT).toBe(200)
    expect(UI_PROJECTION_DEFAULT_MAX_BYTES).toBe(256 * 1024)
    expect(UI_PROJECTION_MIN_MAX_BYTES).toBe(16 * 1024)
    expect(UI_PROJECTION_MAX_BYTES).toBe(1024 * 1024)
    expect(UI_PROJECTION_RESYNC_REQUIRED).toBe('UI_PROJECTION_RESYNC_REQUIRED')
  })
})
