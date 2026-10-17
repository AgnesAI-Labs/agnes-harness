import { describe, expect, it } from 'vitest'
import type { HistoryEntry, Observation } from '../src/types.js'
import {
  addNote,
  buildState,
  emptyWorkspace,
  fileActivity,
  goalText,
  latestRecoverable,
  newTurn,
  recordStep,
} from '../src/workspace.js'

const entry = (over: Partial<HistoryEntry> = {}): Observation => ({
  entry: {
    phase: 'INSPECT',
    operation: 'read',
    target: 'a',
    status: 'succeeded',
    disposition: 'SUCCEEDED',
    summary: 'read(a) conf=0.90',
    intentFp: 'i',
    observationFp: 'o',
    dispatched: true,
    ...over,
  },
  notes: [],
})
const surface = { phases: {}, targets: {} }

describe('workspace', () => {
  it('starts a turn: keeps the previous answer tail, clears notes, keeps 10 prior entries', () => {
    const ws = emptyWorkspace()
    ws.answer = 'x'.repeat(5000)
    for (let i = 0; i < 14; i++) recordStep(ws, entry({ summary: `s${i}` }))
    addNote(ws, { kind: 'steer', text: 'old' })
    newTurn(ws, 'new goal')
    expect(ws.previousAnswer).toHaveLength(4000)
    expect(ws.notes).toEqual([])
    expect(ws.history.map((e) => e.summary)).toEqual([
      's4',
      's5',
      's6',
      's7',
      's8',
      's9',
      's10',
      's11',
      's12',
      's13',
    ])
    expect(ws.turnStart).toBe(10)
  })
  it('keeps excerpts only on the newest entry', () => {
    const ws = emptyWorkspace()
    recordStep(ws, entry({ output_excerpt: 'first' }))
    recordStep(ws, entry({ output_excerpt: 'second' }))
    expect(ws.history[0]?.output_excerpt).toBeUndefined()
    expect(ws.history[1]?.output_excerpt).toBe('second')
  })
  it('derives file activity from successful current-turn entries (ref test_compiler.py:352)', () => {
    const ws = emptyWorkspace()
    newTurn(ws, 'g')
    recordStep(ws, entry({ read_files: ['a.py'] }))
    recordStep(ws, entry({ operation: 'write', changed_files: ['a.py'] }))
    expect(fileActivity(ws)).toMatchObject({
      read_current: [],
      changed_unread: ['a.py'],
      read_counts: { 'a.py': 1 },
    })
    recordStep(ws, entry({ read_files: ['a.py'] }))
    expect(fileActivity(ws)).toMatchObject({ read_current: ['a.py'], changed_unread: [] })
    recordStep(ws, entry({ operation: 'shell', files_may_have_changed: true }))
    expect(fileActivity(ws)).toMatchObject({ read_current: [], files_may_have_changed: true })
    recordStep(ws, entry({ disposition: 'NOT_APPLIED', read_files: ['b.py'] }))
    expect(fileActivity(ws).read_counts['b.py']).toBeUndefined()
  })
  it('builds the state with the fixed key set and bounded views', () => {
    const ws = emptyWorkspace()
    newTurn(ws, '列出目录')
    for (const kind of ['file', 'shell', 'file', 'shell', 'steer', 'file'] as const)
      addNote(ws, { kind, text: kind })
    recordStep(ws, entry({ output_excerpt: 'tail' }))
    const state = buildState(ws, 0, surface)
    expect(Object.keys(state)).toEqual([
      'context_contract',
      'goal',
      'previous_answer',
      'known_files',
      'observation_views',
      'current_turn_notes',
      'file_activity',
      'recent_steps',
      'last_result',
      'decision_surface',
    ])
    expect((state.current_turn_notes as unknown[]).length).toBe(3)
    expect(state.recent_steps).toEqual([
      {
        phase: 'INSPECT',
        operation: 'read',
        target: 'a',
        status: 'succeeded',
        disposition: 'SUCCEEDED',
        summary: 'read(a) conf=0.90',
      },
    ])
    expect(state.last_result).toMatchObject({ output_excerpt: 'tail' })
    expect(JSON.stringify(state)).not.toContain('intentFp')
  })
  it('shrinks cumulatively by level', () => {
    const ws = emptyWorkspace()
    ws.answer = 'p'.repeat(3000)
    newTurn(ws, `${'头'.repeat(3000)}${'尾'.repeat(3000)}`)
    for (let i = 0; i < 12; i++) recordStep(ws, entry())
    addNote(ws, { kind: 'steer', text: 'n' })
    expect((buildState(ws, 3, surface).previous_answer as string).length).toBe(1000)
    expect((buildState(ws, 4, surface).recent_steps as unknown[]).length).toBe(5)
    expect(buildState(ws, 5, surface).current_turn_notes).toEqual([])
    expect(buildState(ws, 6, surface).goal).toHaveLength(6000)
    expect(buildState(ws, 7, surface).goal).toBe(`${'头'.repeat(2000)}\n…\n${'尾'.repeat(2000)}`)
  })
  it('forces arbitration only for a recoverable latest entry of the current turn (ref test_kernel.py:1116)', () => {
    const ws = emptyWorkspace()
    recordStep(
      ws,
      entry({
        status: 'failed',
        disposition: 'NOT_APPLIED',
        error: {
          code: 'EXECUTION_FAILED',
          kind: 'execution',
          stage: 'dispatch',
          recoverability: 'recoverable',
          message: '',
        },
      }),
    )
    expect(latestRecoverable(ws)?.error?.code).toBe('EXECUTION_FAILED')
    newTurn(ws, 'next')
    expect(latestRecoverable(ws)).toBeNull()
  })
  it('joins text blocks into the goal', () => {
    expect(
      goalText([{ type: 'text', text: 'a' }, { type: 'image' } as never, { type: 'text', text: 'b' }]),
    ).toBe('a\nb')
  })
})
