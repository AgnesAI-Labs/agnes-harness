// Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified.
import { describe, expect, it } from 'vitest'
import {
  CANDIDATE_CAP,
  CHANGED_LABEL,
  candidatesFor,
  MENTIONED_LABEL,
  READ_LABEL,
  targetCandidates,
} from '../src/candidates.js'
import { normalizeView, VIEW_CAP } from '../src/observations.js'
import { resolveTool } from '../src/profile.js'
import type { ResolvedTool, Workspace } from '../src/types.js'
import { emptyWorkspace, fileActivity, newTurn, recordStep } from '../src/workspace.js'
import { BUILTIN_SCHEMAS, turnView } from './helpers/view.js'

const tool = (name: string) =>
  resolveTool({ name, description: name, parameters: BUILTIN_SCHEMAS[name] } as never) as ResolvedTool
const observed = (refs: Array<['file' | 'directory', string]>, goal = 'g'): Workspace => {
  const ws = emptyWorkspace()
  ws.goal = goal
  ws.views = [
    normalizeView({
      operation: 'ls',
      callId: 'c',
      scope: '.',
      evidence: '',
      references: refs.map(([kind, value]) => ({ kind, value })),
      truncated: false,
    }),
  ]
  return ws
}
const step = (over: object) => ({
  entry: {
    phase: 'INSPECT' as const,
    operation: 'read',
    target: 'a.md',
    status: 'succeeded' as const,
    disposition: 'SUCCEEDED' as const,
    summary: 's',
    intentFp: 'i',
    observationFp: 'o',
    dispatched: true,
    ...over,
  },
  notes: [],
})

describe('targetCandidates', () => {
  it('offers observed files to read with offset 1 and limit 200, and nothing to write', () => {
    const ws = observed([['file', 'src/main.py']])
    expect(targetCandidates(tool('read'), BUILTIN_SCHEMAS.read, ws)).toEqual([
      {
        key: 'src/main.py',
        kind: 'file',
        label: 'src/main.py',
        args: { offset: 1, limit: 200, path: 'src/main.py' },
      },
    ])
    expect(targetCandidates(tool('write'), BUILTIN_SCHEMAS.write, ws)).toEqual([])
  })
  it('offers observed directories to ls as a path only', () => {
    expect(
      targetCandidates(
        tool('ls'),
        BUILTIN_SCHEMAS.ls,
        observed([
          ['directory', 'src'],
          ['file', 'a.md'],
        ]),
      ),
    ).toEqual([{ key: 'src', kind: 'directory', label: 'src', args: { path: 'src' } }])
  })
  it('labels a changed file and a file read this turn', () => {
    const ws = observed([
      ['file', 'a.md'],
      ['file', 'b.md'],
    ])
    recordStep(ws, step({ operation: 'read', target: 'a.md', read_files: ['a.md'] }))
    recordStep(ws, step({ operation: 'read', target: 'b.md', read_files: ['b.md'] }))
    recordStep(ws, step({ operation: 'edit', target: 'b.md', changed_files: ['b.md'], phase: 'ACT' }))
    const labels = Object.fromEntries(
      targetCandidates(tool('read'), BUILTIN_SCHEMAS.read, ws).map((c) => [c.key, c.label]),
    )
    expect(labels).toEqual({ 'a.md': `a.md${READ_LABEL}`, 'b.md': `b.md${CHANGED_LABEL}` })
  })
  it('does not rank or parse the goal', () => {
    const a = targetCandidates(
      tool('read'),
      BUILTIN_SCHEMAS.read,
      observed(
        [
          ['file', 'src/apple.py'],
          ['file', 'src/orange.py'],
        ],
        'Read apple, ignore orange',
      ),
    )
    const b = targetCandidates(
      tool('read'),
      BUILTIN_SCHEMAS.read,
      observed(
        [
          ['file', 'src/apple.py'],
          ['file', 'src/orange.py'],
        ],
        'Read orange, ignore apple',
      ),
    )
    expect(a).toEqual(b)
  })
  it('keeps a reference the schema refuses as evidence, not as a candidate', () => {
    // completeArgs checks required keys, closed objects and scalar types; this read takes no offset or limit.
    const closed = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    }
    const ws = observed([['file', 'notes.md']])
    expect(targetCandidates(tool('read'), closed, ws)).toEqual([])
    expect(ws.views[0]?.references).toEqual([{ kind: 'file', value: 'notes.md' }])
  })
  it('stops at 20 references, newest view first in listing order, and never offers a synthetic key', () => {
    const view = (scope: string, names: string[]) =>
      normalizeView({
        operation: 'find',
        callId: scope,
        scope,
        evidence: '',
        references: names.map((value) => ({ kind: 'file' as const, value })),
        truncated: false,
      })
    const names = (prefix: string) => Array.from({ length: 11 }, (_, i) => `${prefix}${i}.md`)
    const older = names('o')
    const newer = names('n')
    const ws = emptyWorkspace()
    ws.views = [
      view('old', [older[0] ?? '', 'LLM_PARAMETERS', ...older.slice(1)]),
      view('new', [...newer.slice(0, 2), 'DEFAULT_ARGUMENTS', ...newer.slice(2)]),
    ]
    const keys = targetCandidates(tool('read'), BUILTIN_SCHEMAS.read, ws).map((c) => c.key)
    // The first 20 references are the 12 newer ones and 8 older ones; the two synthetic names
    // among them take a place each and are skipped.
    expect(keys).toEqual([...newer, ...older.slice(0, 7)])
  })
  it('keeps the freshness label of a long path whole', () => {
    const changed = `${'c'.repeat(299)}.md`
    const read = `${'r'.repeat(299)}.md`
    const ws = observed([
      ['file', changed],
      ['file', read],
    ])
    recordStep(ws, step({ operation: 'read', target: changed, read_files: [changed, read] }))
    recordStep(ws, step({ operation: 'edit', target: changed, changed_files: [changed], phase: 'ACT' }))
    const labels = targetCandidates(tool('read'), BUILTIN_SCHEMAS.read, ws).map((c) => c.label)
    expect(labels).toEqual([
      `${changed.slice(0, 300 - CHANGED_LABEL.length)}${CHANGED_LABEL}`,
      `${read.slice(0, 300 - READ_LABEL.length)}${READ_LABEL}`,
    ])
    const plain = `${'p'.repeat(310)}.md`
    expect(targetCandidates(tool('read'), BUILTIN_SCHEMAS.read, observed([['file', plain]]))[0]?.label).toBe(
      plain.slice(0, 300),
    )
  })
  it('never labels a directory with freshness', () => {
    const ws = observed([
      ['directory', 'src'],
      ['directory', 'lib'],
    ])
    recordStep(ws, step({ operation: 'read', target: 'lib', read_files: ['lib'] }))
    recordStep(ws, step({ operation: 'edit', target: 'src', changed_files: ['src'], phase: 'ACT' }))
    expect(targetCandidates(tool('ls'), BUILTIN_SCHEMAS.ls, ws).map((c) => c.label)).toEqual(['src', 'lib'])
  })
  it('returns arguments that do not alias the profile defaults', () => {
    const read = tool('read')
    const [first] = targetCandidates(read, BUILTIN_SCHEMAS.read, observed([['file', 'safe.py']]))
    expect(first).toBeDefined()
    if (first !== undefined) first.args.limit = 999
    expect(read.bindingDefaults).toEqual({ offset: 1, limit: 200 })
  })
})

describe('mentioned candidates', () => {
  const turn = (goal: string, refs: Array<['file' | 'directory', string]> = []) => {
    const ws = observed(refs)
    newTurn(ws, goal)
    return ws
  }
  const read = (ws: Workspace) => targetCandidates(tool('read'), BUILTIN_SCHEMAS.read, ws)
  it('offers a file the message names, marked mentioned, with the read defaults', () => {
    expect(read(turn('Please read config/app.toml'))).toEqual([
      {
        key: 'config/app.toml',
        kind: 'file',
        label: `config/app.toml${MENTIONED_LABEL}`,
        args: { offset: 1, limit: 200, path: 'config/app.toml' },
      },
    ])
  })
  it('offers a named directory to ls and a named file only to read', () => {
    const ws = turn('List src/ and read a.md')
    expect(targetCandidates(tool('ls'), BUILTIN_SCHEMAS.ls, ws).map((c) => [c.key, c.label])).toEqual([
      ['src', `src${MENTIONED_LABEL}`],
    ])
    expect(read(ws).map((c) => c.key)).toEqual(['a.md'])
    expect(targetCandidates(tool('write'), BUILTIN_SCHEMAS.write, ws)).toEqual([])
  })
  it('lets an observation win: a named path a result showed is an ordinary candidate', () => {
    const ws = turn('Read a.md and b.md', [['file', 'a.md']])
    expect(read(ws).map((c) => [c.key, c.label])).toEqual([
      ['b.md', `b.md${MENTIONED_LABEL}`],
      ['a.md', 'a.md'],
    ])
  })
  it('puts a seen path the message names again before the other seen paths, as an ordinary candidate', () => {
    const ws = turn('Look at c.md again', [
      ['file', 'a.md'],
      ['file', 'b.md'],
      ['file', 'c.md'],
    ])
    expect(read(ws).map((c) => [c.key, c.label])).toEqual([
      ['c.md', 'c.md'],
      ['a.md', 'a.md'],
      ['b.md', 'b.md'],
    ])
  })
  it('puts named paths first and keeps the total at the candidate cap', () => {
    const seen: Array<['file', string]> = Array.from({ length: 20 }, (_, i) => ['file', `o${i}.md`])
    const ws = turn('x1.md x2.md x3.md', seen)
    const keys = read(ws).map((c) => c.key)
    expect(keys).toHaveLength(CANDIDATE_CAP)
    expect(keys.slice(0, 3)).toEqual(['x1.md', 'x2.md', 'x3.md'])
    expect(keys.slice(3)).toEqual(seen.slice(0, 17).map(([, v]) => v))
  })
  it('is replaced by the next turn: nothing named earlier stays a candidate', () => {
    const ws = turn('read old.md')
    newTurn(ws, 'now only new.md')
    expect(read(ws).map((c) => c.key)).toEqual(['new.md'])
    newTurn(ws, 'nothing named here')
    expect(read(ws)).toEqual([])
  })
  it('comes from the user message alone: tool output, notes and answers name nothing', () => {
    const ws = turn('what is in the repo')
    recordStep(ws, {
      ...step({ operation: 'read', target: 'a.md', read_files: ['a.md'] }),
      notes: [{ kind: 'file', target: 'a.md', text: 'see secret/plan.md and docs/' }],
    })
    ws.answer = 'look at hidden/answer.md'
    expect(ws.mentioned).toEqual([])
    // Only the file the call itself read is known; nothing the notes or the answer say.
    expect(read(ws).map((c) => [c.key, c.label])).toEqual([['a.md', `a.md${READ_LABEL}`]])
  })
  it('does not count as read: freshness ignores it', () => {
    const ws = turn('read a.md twice')
    expect(fileActivity(ws)).toMatchObject({ read_current: [], changed_unread: [], read_counts: {} })
    expect(read(ws)[0]?.label).toBe(`a.md${MENTIONED_LABEL}`)
    // Once read, the path is evidence like any other, and the read label wins.
    ws.views = observed([['file', 'a.md']]).views
    recordStep(ws, step({ operation: 'read', target: 'a.md', read_files: ['a.md'] }))
    expect(read(ws)).toMatchObject([{ key: 'a.md', label: `a.md${READ_LABEL}` }])
  })
})

describe('candidates and the seen-path index', () => {
  const shown = (path: string, scope: string) =>
    ({
      ...step({ operation: 'ls', target: scope }),
      view: normalizeView({
        operation: 'ls',
        callId: scope,
        scope,
        evidence: '',
        references: [{ kind: 'file', value: path }],
        truncated: false,
      }),
    }) as never
  it('still offers a file after its view was pushed out of the window', () => {
    const ws = emptyWorkspace()
    recordStep(ws, shown('lost.md', 'first'))
    for (let i = 0; i < VIEW_CAP; i++) recordStep(ws, shown(`later${i}.md`, `scope${i}`))
    expect(ws.views.flatMap((v) => v.references.map((r) => r.value))).not.toContain('lost.md')
    expect(targetCandidates(tool('read'), BUILTIN_SCHEMAS.read, ws).map((c) => c.key)).toEqual([
      'later3.md',
      'later2.md',
      'later1.md',
      'later0.md',
      'lost.md',
    ])
  })
  it('keeps a file that was seen again once, at its newest place, and cuts at the candidate cap', () => {
    const ws = emptyWorkspace()
    for (let i = 0; i < 30; i++) recordStep(ws, shown(`f${i}.md`, `s${i}`))
    recordStep(ws, shown('f3.md', 'again'))
    const keys = targetCandidates(tool('read'), BUILTIN_SCHEMAS.read, ws).map((c) => c.key)
    expect(keys).toHaveLength(CANDIDATE_CAP)
    expect(keys.slice(0, 3)).toEqual(['f3.md', 'f29.md', 'f28.md'])
    expect(keys.filter((key) => key === 'f3.md')).toHaveLength(1)
  })
})

describe('candidatesFor', () => {
  it('keys the candidates of every tool by name, with the schema the view gives', () => {
    const ws = observed([
      ['directory', 'src'],
      ['file', 'a.md'],
    ])
    const tools = ['ls', 'read', 'write'].map(tool)
    expect(candidatesFor(tools, turnView({ tools: ['ls', 'read', 'write'] }), ws)).toEqual({
      ls: [{ key: 'src', kind: 'directory', label: 'src', args: { path: 'src' } }],
      read: [{ key: 'a.md', kind: 'file', label: 'a.md', args: { offset: 1, limit: 200, path: 'a.md' } }],
      write: [],
    })
    const closed = { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false }
    const view = { tools: [{ name: 'read', description: 'read', parameters: closed }] }
    expect(candidatesFor([tool('read'), tool('ls')], view as never, ws)).toEqual({ read: [], ls: [] })
  })
  it('takes the first tool and the first schema of a name', () => {
    const ws = observed([['file', 'a.md']])
    const unbound = { ...tool('read'), referenceKind: null }
    const both = turnView({ tools: ['read'] })
    expect(candidatesFor([unbound, tool('read')], both, ws)).toEqual({ read: [] })
    const closed = { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false }
    const view = {
      tools: [
        { name: 'read', description: 'read', parameters: closed },
        { name: 'read', description: 'read', parameters: BUILTIN_SCHEMAS.read },
      ],
    }
    expect(candidatesFor([tool('read')], view as never, ws)).toEqual({ read: [] })
    view.tools.reverse()
    expect(candidatesFor([tool('read')], view as never, ws).read).toHaveLength(1)
  })
  it('keeps a tool named like an object prototype key as its own key', () => {
    const odd = { ...tool('ls'), name: '__proto__' }
    const view = { tools: [{ name: '__proto__', description: '', parameters: BUILTIN_SCHEMAS.ls }] }
    const result = candidatesFor([odd], view as never, observed([['directory', 'src']]))
    expect(Object.hasOwn(result, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toEqual([
      { key: 'src', kind: 'directory', label: 'src', args: { path: 'src' } },
    ])
  })
})
