import { describe, expect, it } from 'vitest'
import { normalizeView, VIEW_CAP } from '../src/observations.js'
import type { HistoryEntry, Observation, ObservationView } from '../src/types.js'
import {
  addNote,
  buildState,
  CONTEXT_CONTRACT,
  emptyWorkspace,
  fileActivity,
  goalText,
  isMentionedOnly,
  knownPaths,
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
  it('derives file activity from successful current-turn entries', () => {
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
  it('forces arbitration only for a recoverable latest entry of the current turn', () => {
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
  it('treats a successful read without read_files as a read of its target', () => {
    const ws = emptyWorkspace()
    newTurn(ws, 'g')
    recordStep(ws, entry({ target: 'x' }))
    expect(fileActivity(ws)).toMatchObject({ read_current: ['x'], read_counts: { x: 1 } })
  })
  it('keeps the last 10 notes and clips each to 600 characters', () => {
    const ws = emptyWorkspace()
    for (let i = 0; i < 11; i++) addNote(ws, { kind: 'steer', text: `n${i}` })
    expect(ws.notes.map((n) => n.text)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10'])
    addNote(ws, { kind: 'file', text: 'x'.repeat(900) })
    expect(ws.notes[ws.notes.length - 1]?.text).toHaveLength(600)
  })
  it('hands out a state that shares nothing with the workspace or the contract', () => {
    const ws = emptyWorkspace()
    newTurn(ws, 'g')
    recordStep(ws, entry({ read_files: ['a.py'], changed_files: ['b.py'], target: ['a.py', 'c.py'] }))
    const state = buildState(ws, 0, surface)
    ;(state.context_contract as Record<string, unknown>).authority = 'changed'
    const step = (state.recent_steps as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    ;(step.read_files as string[]).push('z')
    ;(step.target as string[]).push('z')
    ;((state.last_result as Record<string, unknown>).changed_files as string[]).push('z')
    expect(buildState(ws, 0, surface).context_contract).toEqual(CONTEXT_CONTRACT)
    expect(CONTEXT_CONTRACT.authority).not.toBe('changed')
    expect(ws.history[0]).toMatchObject({
      read_files: ['a.py'],
      changed_files: ['b.py'],
      target: ['a.py', 'c.py'],
    })
    expect(Object.isFrozen(CONTEXT_CONTRACT)).toBe(true)
  })
  it('copies the entry on record so later edits of the input do not reach the workspace', () => {
    const ws = emptyWorkspace()
    const obs = entry({ read_files: ['a.py'] })
    recordStep(ws, obs)
    obs.entry.read_files?.push('z')
    expect(ws.history[0]?.read_files).toEqual(['a.py'])
  })
  it('joins text blocks into the goal', () => {
    expect(
      goalText([{ type: 'text', text: 'a' }, { type: 'image' } as never, { type: 'text', text: 'b' }]),
    ).toBe('a\nb')
  })
})

const viewOf = (operation: string, scope: string, paths: string[], evidence = 'e') =>
  normalizeView({
    operation,
    callId: `c-${operation}-${scope}`,
    scope,
    evidence,
    references: paths.map((value) => ({ kind: 'file' as const, value })),
    truncated: false,
  })
const withView = (obs: ReturnType<typeof entry>, view: ReturnType<typeof viewOf>) => ({ ...obs, view })

describe('views in the workspace', () => {
  it('keeps observation views across a new turn and clears the notes', () => {
    const ws = emptyWorkspace()
    recordStep(ws, withView(entry({ operation: 'ls' }), viewOf('ls', '.', ['a.md'])))
    addNote(ws, { kind: 'file', target: 'a.md', text: 'x' })
    newTurn(ws, 'next goal')
    expect(ws.views).toHaveLength(1)
    expect(ws.notes).toEqual([])
  })
  it('shows views and known files to Jev, newest file first', () => {
    const ws = emptyWorkspace()
    recordStep(ws, withView(entry({ operation: 'ls' }), viewOf('ls', '.', ['a.md', 'b.md'])))
    recordStep(ws, withView(entry({ operation: 'find' }), viewOf('find', 'src', ['src/c.ts'])))
    const state = buildState(ws, 0, surface)
    expect(state.known_files).toEqual(['src/c.ts', 'a.md', 'b.md'])
    expect((state.observation_views as unknown[]).length).toBe(2)
  })
  it('halves view evidence at shrink level 1 and drops the oldest view at level 2', () => {
    const ws = emptyWorkspace()
    recordStep(ws, withView(entry(), viewOf('ls', '.', [], 'x'.repeat(1000))))
    recordStep(ws, withView(entry(), viewOf('find', 'src', [], 'y'.repeat(1000))))
    const one = buildState(ws, 1, surface).observation_views as ObservationView[]
    expect(one.map((v) => v.evidence.length)).toEqual([500, 500])
    expect(one.map((v) => v.truncated)).toEqual([true, true])
    const two = buildState(ws, 2, surface).observation_views as ObservationView[]
    expect(two.map((v) => [v.kind, v.evidence.length, v.truncated])).toEqual([['find', 500, true]])
    const three = buildState(ws, 3, surface).observation_views as ObservationView[]
    expect(three.map((v) => v.evidence.length)).toEqual([500])
    expect(ws.views.map((v) => [v.evidence.length, v.truncated])).toEqual([
      [1000, false],
      [1000, false],
    ])
  })
  it('rounds the kept half up, keeps one character whole and never splits a surrogate pair', () => {
    const ws = emptyWorkspace()
    recordStep(ws, withView(entry(), viewOf('ls', 'odd', [], 'x'.repeat(1001))))
    recordStep(ws, withView(entry(), viewOf('ls', 'one', [], 'z')))
    recordStep(ws, withView(entry(), viewOf('ls', 'pairs', [], '😀😀😀')))
    const views = buildState(ws, 1, surface).observation_views as ObservationView[]
    expect(views.map((v) => [v.evidence, v.truncated])).toEqual([
      ['x'.repeat(501), true],
      ['z', false],
      ['😀', true],
    ])
  })
  it('keeps the files of the dropped oldest view among the known files at level 2', () => {
    const ws = emptyWorkspace()
    recordStep(ws, withView(entry({ operation: 'ls' }), viewOf('ls', '.', ['a.md'])))
    recordStep(ws, withView(entry({ operation: 'find' }), viewOf('find', 'src', ['src/c.ts'])))
    const state = buildState(ws, 2, surface)
    expect((state.observation_views as ObservationView[]).map((v) => v.kind)).toEqual(['find'])
    expect(state.known_files).toEqual(['src/c.ts', 'a.md'])
  })
  it('replaces the view of a file read again with another range', () => {
    const ws = emptyWorkspace()
    recordStep(
      ws,
      withView(
        entry({ operation: 'read', target: 'a.ts', read_files: ['a.ts'] }),
        viewOf('read', 'a.ts', ['a.ts'], 'lines 1-200'),
      ),
    )
    recordStep(
      ws,
      withView(
        entry({ operation: 'read', target: 'a.ts', read_files: ['a.ts'] }),
        viewOf('read', 'a.ts', ['a.ts'], 'lines 201-400'),
      ),
    )
    expect(ws.views.map((v) => v.evidence)).toEqual(['lines 201-400'])
    expect(fileActivity(ws).read_counts).toEqual({ 'a.ts': 2 })
  })
})

describe('the seen-path index in the workspace', () => {
  it('takes the references of a view, the files a step read or changed and a write of unknown outcome', () => {
    const ws = emptyWorkspace()
    recordStep(ws, withView(entry({ operation: 'ls' }), viewOf('ls', '.', ['a.md', 'b.md'])))
    expect(ws.index.files).toEqual(['a.md', 'b.md'])
    recordStep(ws, entry({ operation: 'read', target: 'c.md', read_files: ['c.md', 'a.md'] }))
    recordStep(ws, entry({ operation: 'edit', target: 'd.md', changed_files: ['d.md'], phase: 'ACT' }))
    recordStep(
      ws,
      entry({ operation: 'write', target: 'new.md', disposition: 'UNKNOWN', status: 'failed', phase: 'ACT' }),
    )
    // A read that was never dispatched or that only observes leaves nothing behind.
    recordStep(ws, entry({ operation: 'shell', target: null, disposition: 'UNKNOWN', dispatched: true }))
    expect(ws.index.files).toEqual(['new.md', 'd.md', 'c.md', 'a.md', 'b.md'])
  })
  it('keeps the files of views that left the window, and the index across turns', () => {
    const ws = emptyWorkspace()
    recordStep(ws, withView(entry({ operation: 'ls' }), viewOf('ls', '.', ['lost.md'])))
    for (let i = 0; i < VIEW_CAP; i++)
      recordStep(ws, withView(entry({ operation: 'find' }), viewOf('find', `s${i}`, [`f${i}.md`])))
    expect(ws.views.flatMap((v) => v.references.map((r) => r.value))).not.toContain('lost.md')
    expect(knownPaths(ws, 'file')).toEqual(['f3.md', 'f2.md', 'f1.md', 'f0.md', 'lost.md'])
    expect(buildState(ws, 0, surface).known_files).toEqual(['f3.md', 'f2.md', 'f1.md', 'f0.md', 'lost.md'])
    newTurn(ws, 'another goal')
    expect(knownPaths(ws, 'file')).toContain('lost.md')
  })
  it('shows the whole index at levels 0 and 1, the newest 20 files from level 2 and 8 from level 5', () => {
    const ws = emptyWorkspace()
    for (let i = 0; i < 40; i++)
      recordStep(ws, entry({ operation: 'read', target: `f${i}.md`, read_files: [`f${i}.md`] }))
    const known = (level: number) => buildState(ws, level, surface).known_files as string[]
    expect(known(0)).toHaveLength(40)
    expect(known(1)).toHaveLength(40)
    expect(known(2)).toEqual(known(0).slice(0, 20))
    expect(known(4)).toHaveLength(20)
    expect(known(5)).toEqual(known(0).slice(0, 8))
    expect(known(7)).toHaveLength(8)
  })
  it('names a path seen only through the index as seen, not as merely mentioned', () => {
    const ws = emptyWorkspace()
    recordStep(ws, entry({ operation: 'read', target: 'seen.md', read_files: ['seen.md'] }))
    newTurn(ws, 'read seen.md and new.md')
    expect(isMentionedOnly(ws, 'file', 'seen.md')).toBe(false)
    expect(isMentionedOnly(ws, 'file', 'new.md')).toBe(true)
  })
})

describe('freshness', () => {
  it('makes earlier reads stale after a shell call whose effect is unknown', () => {
    const ws = emptyWorkspace()
    recordStep(ws, entry({ operation: 'read', target: 'a', read_files: ['a'] }))
    recordStep(
      ws,
      entry({ operation: 'shell', target: null, status: 'failed', disposition: 'UNKNOWN', dispatched: true }),
    )
    expect(fileActivity(ws)).toMatchObject({ read_current: [], files_may_have_changed: true })
  })
  it('keeps reads current after a shell call that was never dispatched', () => {
    const ws = emptyWorkspace()
    recordStep(ws, entry({ operation: 'read', target: 'a', read_files: ['a'] }))
    recordStep(
      ws,
      entry({
        operation: 'shell',
        target: null,
        status: 'failed',
        disposition: 'UNKNOWN',
        dispatched: false,
      }),
    )
    expect(fileActivity(ws)).toMatchObject({ read_current: ['a'], files_may_have_changed: false })
  })
  it.each(['ls', 'read', 'grep', 'find'])('keeps reads current after a %s whose outcome is unknown', (op) => {
    const ws = emptyWorkspace()
    recordStep(ws, entry({ operation: 'read', target: 'a', read_files: ['a'] }))
    recordStep(
      ws,
      entry({ operation: op, target: 'b', status: 'failed', disposition: 'UNKNOWN', dispatched: true }),
    )
    expect(fileActivity(ws)).toMatchObject({ read_current: ['a'], files_may_have_changed: false })
  })
  it('marks every file of an edit whose outcome is unknown as changed', () => {
    const ws = emptyWorkspace()
    recordStep(ws, entry({ operation: 'read', target: ['a', 'b', 'c'], read_files: ['a', 'b', 'c'] }))
    recordStep(
      ws,
      entry({
        operation: 'edit',
        target: ['a', 'b'],
        status: 'failed',
        disposition: 'UNKNOWN',
        dispatched: true,
      }),
    )
    expect(fileActivity(ws)).toMatchObject({
      read_current: [],
      changed_unread: ['a', 'b'],
      files_may_have_changed: true,
    })
  })
  it('counts reads of files named like object prototype keys', () => {
    const ws = emptyWorkspace()
    const names = ['constructor', 'toString', '__proto__', 'hasOwnProperty']
    recordStep(ws, entry({ operation: 'read', target: names, read_files: names }))
    recordStep(ws, entry({ operation: 'read', target: 'constructor', read_files: ['constructor'] }))
    const counts = fileActivity(ws).read_counts
    expect(Object.keys(counts)).toEqual(names)
    expect(Object.entries(counts)).toEqual([
      ['constructor', 2],
      ['toString', 1],
      ['__proto__', 1],
      ['hasOwnProperty', 1],
    ])
    expect(JSON.parse(JSON.stringify(buildState(ws, 0, surface).file_activity)).read_counts).toEqual(
      JSON.parse('{"constructor":2,"toString":1,"__proto__":1,"hasOwnProperty":1}'),
    )
  })
  it('marks the file of a write whose outcome is unknown as changed', () => {
    const ws = emptyWorkspace()
    recordStep(ws, entry({ operation: 'read', target: 'a', read_files: ['a'] }))
    recordStep(
      ws,
      entry({ operation: 'write', target: 'a', status: 'failed', disposition: 'UNKNOWN', dispatched: true }),
    )
    expect(fileActivity(ws)).toMatchObject({ read_current: [], changed_unread: ['a'] })
  })
})
