// Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified.
import { describe, expect, it } from 'vitest'
import { CHANGED_LABEL, candidatesFor, READ_LABEL, targetCandidates } from '../src/candidates.js'
import { normalizeView } from '../src/observations.js'
import { resolveTool } from '../src/profile.js'
import type { ResolvedTool, Workspace } from '../src/types.js'
import { emptyWorkspace, recordStep } from '../src/workspace.js'
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
  it('stops at 20 candidates, newest reference first, and never offers a synthetic key', () => {
    const refs = Array.from({ length: 25 }, (_, i) => ['file', `f${i}.md`] as ['file', string])
    const ws = observed([['file', 'LLM_PARAMETERS'], ...refs.slice(0, 19)])
    const keys = targetCandidates(tool('read'), BUILTIN_SCHEMAS.read, ws).map((c) => c.key)
    expect(keys).not.toContain('LLM_PARAMETERS')
    expect(keys.length).toBeLessThanOrEqual(20)
  })
  it('returns arguments that do not alias the profile defaults', () => {
    const read = tool('read')
    const [first] = targetCandidates(read, BUILTIN_SCHEMAS.read, observed([['file', 'safe.py']]))
    expect(first).toBeDefined()
    if (first !== undefined) first.args.limit = 999
    expect(read.bindingDefaults).toEqual({ offset: 1, limit: 200 })
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
