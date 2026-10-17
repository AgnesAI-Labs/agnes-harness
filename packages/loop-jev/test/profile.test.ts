import type { LoopToolMeta } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import {
  builtinToolNames,
  classifyReadBatch,
  classifyResult,
  codeDisclosure,
  completeArgs,
  decisionTools,
  normalizePath,
  outcomeUnknown,
  resolveTool,
  resolveUnprofiled,
  turnToolNames,
} from '../src/profile.js'
import { BUILTIN_META, BUILTIN_SCHEMAS, turnView } from './helpers/view.js'

const tool = (name: string) => ({ name, description: name, parameters: BUILTIN_SCHEMAS[name] }) as never
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })
const base = { phase: 'INSPECT' as const, cwd: '/w', confidence: 0.83, escalated: false }

describe('tool profiles', () => {
  it('resolves the seven built-in tools with the profile table and nothing else', () => {
    expect(resolveTool(tool('ls'))).toMatchObject({
      phases: ['INSPECT', 'VERIFY'],
      writeClass: 'read',
      readOnly: true,
      defaults: { path: '.' },
      targetParam: 'path',
    })
    expect(resolveTool(tool('read'))).toMatchObject({ readOnly: true, defaults: null, targetParam: 'path' })
    expect(resolveTool(tool('shell'))).toMatchObject({
      phases: ['INSPECT', 'ACT', 'VERIFY'],
      writeClass: 'workspace',
      readOnly: false,
    })
    expect(resolveTool(tool('write'))?.phases).toEqual(['ACT'])
    expect(resolveTool({ name: 'todo', description: 't', parameters: {} } as never)).toBeNull()
  })
  it('uses the Jev criteria, not the model-facing description', () => {
    expect(resolveTool(tool('ls'))?.criteria).toBe(
      'List one workspace directory, including file and directory references. Use path for scoped discovery; not recursive.',
    )
  })
  it('computes toolNames: built-ins in the catalog plus discovery tools, sorted, never compact or run_code', () => {
    const view = turnView({
      tools: ['write', 'read', 'tool_search', 'compact', 'run_code', 'todo', 'ls', 'grep', 'find'],
    })
    const names = builtinToolNames(view)
    expect(names).toEqual(['find', 'grep', 'ls', 'read', 'tool_search', 'write'])
    expect(decisionTools(view, names).map((t) => t.name)).toEqual(['ls', 'read', 'grep', 'find', 'write'])
  })
  it('offers DEFAULT_ARGUMENTS only when they are complete for the schema', () => {
    expect(completeArgs(BUILTIN_SCHEMAS.ls, { path: '.' })).toBe(true)
    expect(completeArgs(BUILTIN_SCHEMAS.read, {})).toBe(false)
    expect(completeArgs(BUILTIN_SCHEMAS.ls, { path: '.', recursive: true })).toBe(false)
    const strictLs = { ...BUILTIN_SCHEMAS.ls, required: ['limit'] }
    expect(resolveTool({ name: 'ls', description: '', parameters: strictLs } as never)?.defaults).toBeNull()
  })
  it('normalizes paths into the workspace', () => {
    expect(normalizePath('/w/src/a.ts', '/w')).toBe('src/a.ts')
    expect(normalizePath('src/../a.ts', '/w')).toBeNull()
    expect(normalizePath('/etc/passwd', '/w')).toBeNull()
    expect(normalizePath('./b.md', '/w')).toBe('b.md')
    expect(normalizePath('artifact://abc?size=1', '/w')).toBeNull()
    expect(normalizePath('session-file://notes/a.md', '/w')).toBeNull()
    expect(normalizePath('session-image://x', '/w')).toBeNull()
    expect(normalizePath('/w', '/w')).toBe('.')
    expect(normalizePath('/w/', '/w/')).toBe('.')
    expect(normalizePath('/work/a.ts', '/w')).toBeNull()
    expect(normalizePath('', '/w')).toBeNull()
    expect(normalizePath(7, '/w')).toBeNull()
    expect(normalizePath('a//b/./c', '/w')).toBe('a/b/c')
    expect(normalizePath('C:\\w\\src\\a.ts', 'C:\\w')).toBe('src/a.ts')
  })
})

describe('classifyResult', () => {
  it('success of read records read_files and a file note', () => {
    const o = classifyResult({ ...base, name: 'read', args: { path: '/w/src/a.ts' }, result: ok('abc') })
    expect(o.entry).toMatchObject({
      status: 'succeeded',
      disposition: 'SUCCEEDED',
      read_files: ['src/a.ts'],
      target: 'src/a.ts',
      summary: 'read(src/a.ts) conf=0.83',
      dispatched: true,
    })
    expect(o.notes).toEqual([{ kind: 'file', target: 'src/a.ts', text: '[file: src/a.ts]\nabc' }])
  })
  it.each([
    ['ls', { path: 'nope' }],
    ['read', { path: 'x' }],
    ['write', { path: 'x', content: '' }],
    ['edit', { path: 'x', edits: [] }],
  ])('%s error is EXECUTION_FAILED and recoverable', (name, args) => {
    const o = classifyResult({ ...base, name, args, result: err('no such file') })
    expect(o.entry).toMatchObject({
      status: 'failed',
      disposition: 'NOT_APPLIED',
      error: { code: 'EXECUTION_FAILED', recoverability: 'recoverable', stage: 'dispatch' },
    })
  })
  it('write success records changed_files and no note', () => {
    const o = classifyResult({
      ...base,
      phase: 'ACT',
      name: 'write',
      args: { path: 'a.txt', content: 'x' },
      result: ok('wrote a.txt'),
    })
    expect(o.entry.changed_files).toEqual(['a.txt'])
    expect(o.notes).toEqual([])
  })
  it('shell non-zero exit is EFFECT_UNKNOWN, unsafe, with the exit code', () => {
    const o = classifyResult({
      ...base,
      name: 'shell',
      args: { command: 'pytest' },
      result: err('1 failed\n[exit 2]'),
    })
    expect(o.entry).toMatchObject({
      disposition: 'UNKNOWN',
      exit: 2,
      error: { code: 'EFFECT_UNKNOWN', recoverability: 'unsafe' },
      command_excerpt: 'pytest',
    })
  })
  it('shell job output with a capture suffix still yields the exit code', () => {
    expect(
      classifyResult({
        ...base,
        name: 'shell',
        args: { command: 'x' },
        result: err('out\n[exit 1] [capture limit reached]'),
      }).entry.exit,
    ).toBe(1)
  })
  it.each(['command could not be started: no bash', 'command could not be started or continued: Error: x'])(
    'shell %s is NOT_APPLIED and recoverable',
    (text) => {
      expect(
        classifyResult({ ...base, name: 'shell', args: { command: 'x' }, result: err(text) }).entry,
      ).toMatchObject({
        disposition: 'NOT_APPLIED',
        error: { code: 'EXECUTION_FAILED', recoverability: 'recoverable' },
      })
    },
  )
  it('shell success may have changed files and keeps a shell note', () => {
    const o = classifyResult({ ...base, name: 'shell', args: { command: 'ls' }, result: ok('a\n[exit 0]') })
    expect(o.entry).toMatchObject({ status: 'succeeded', exit: 0, files_may_have_changed: true })
    expect(o.notes[0]?.kind).toBe('shell')
  })
  it('announced-but-not-run is TOOL_NOT_STARTED and recoverable', () => {
    expect(
      classifyResult({
        ...base,
        name: 'read',
        args: { path: 'a' },
        result: err('read was announced but did not run'),
      }).entry.error,
    ).toMatchObject({ code: 'TOOL_NOT_STARTED', recoverability: 'recoverable' })
  })
  it('an unprofiled mutable tool error is EFFECT_UNKNOWN and unsafe', () => {
    expect(
      classifyResult({ ...base, phase: 'ACT', name: 'deploy', args: {}, result: err('boom') }).entry,
    ).toMatchObject({
      disposition: 'UNKNOWN',
      error: { code: 'EFFECT_UNKNOWN', recoverability: 'unsafe' },
    })
  })
  it('outcomeUnknown is TOOL_OUTCOME_UNKNOWN and recoverable', () => {
    expect(
      outcomeUnknown({
        ...base,
        calls: [{ name: 'shell', args: { command: 'x' } }],
        code: 'TOOL_OUTCOME_UNKNOWN',
      }).entry,
    ).toMatchObject({
      disposition: 'UNKNOWN',
      error: { code: 'TOOL_OUTCOME_UNKNOWN', recoverability: 'recoverable' },
    })
  })
  it('a read batch is one entry; one success makes it succeeded', () => {
    const calls = ['a', 'b', 'c'].map((path) => ({ name: 'read', args: { path } }))
    const some = classifyReadBatch({ ...base, calls, results: [ok('A'), err('missing'), ok('C')] })
    expect(some.entry).toMatchObject({
      status: 'succeeded',
      target: ['a', 'b', 'c'],
      read_files: ['a', 'c'],
      summary: 'read(a, b, c) conf=0.83',
    })
    expect(
      classifyReadBatch({ ...base, calls, results: [err('x'), err('y'), err('z')] }).entry,
    ).toMatchObject({
      disposition: 'NOT_APPLIED',
      error: { code: 'EXECUTION_FAILED' },
    })
  })
  it('shell failures keep a shell note with the clipped command', () => {
    const o = classifyResult({
      ...base,
      name: 'shell',
      args: { command: 'make' },
      result: err('boom\n[exit 1]'),
    })
    expect(o.notes).toEqual([{ kind: 'shell', target: 'make', text: 'boom\n[exit 1]' }])
    expect(o.entry.files_may_have_changed).toBeUndefined()
  })
  it('drops a path outside the workspace from the entry', () => {
    const o = classifyResult({ ...base, name: 'read', args: { path: '/etc/hosts' }, result: ok('x') })
    expect(o.entry.target).toBeNull()
    expect(o.entry.read_files).toBeUndefined()
    expect(o.entry.summary).toBe('read() conf=0.83')
  })
  it('a batch fingerprint does not depend on call order', () => {
    const a = { name: 'read', args: { path: 'a' } }
    const b = { name: 'read', args: { path: 'b' } }
    const first = classifyReadBatch({ ...base, calls: [a, b], results: [ok('A'), ok('B')] })
    const second = classifyReadBatch({ ...base, calls: [b, a], results: [ok('B'), ok('A')] })
    expect(first.entry.intentFp).toBe(second.entry.intentFp)
  })
  it.each(['artifact://abc?size=1', 'session-file://notes/a.md', 'session-image://x'])(
    'a read of %s leaves no target, read_files or note',
    (path) => {
      const o = classifyResult({ ...base, name: 'read', args: { path }, result: ok('content') })
      expect(o.entry).toMatchObject({ status: 'succeeded', target: null })
      expect(o.entry.read_files).toBeUndefined()
      expect(o.notes).toEqual([])
    },
  )
  it('records an exit code only for shell', () => {
    const read = classifyResult({
      ...base,
      name: 'read',
      args: { path: 'run.log' },
      result: ok('done\n[exit 2]'),
    })
    expect(read.entry.exit).toBeUndefined()
    const calls = [{ name: 'read', args: { path: 'run.log' } }]
    expect(classifyReadBatch({ ...base, calls, results: [ok('[exit 3]')] }).entry.exit).toBeUndefined()
  })
  it.each(['grep', 'find', 'tool_search', 'tool_describe'])(
    '%s error is EXECUTION_FAILED and recoverable',
    (name) => {
      const o = classifyResult({ ...base, name, args: { pattern: 'x' }, result: err('bad pattern') })
      expect(o.entry).toMatchObject({
        status: 'failed',
        disposition: 'NOT_APPLIED',
        error: { code: 'EXECUTION_FAILED', recoverability: 'recoverable' },
      })
    },
  )
  it('outcomeUnknown with TOOL_NOT_STARTED is NOT_APPLIED and recoverable', () => {
    const o = outcomeUnknown({
      ...base,
      calls: [{ name: 'write', args: { path: 'a.txt', content: 'x' } }],
      code: 'TOOL_NOT_STARTED',
    })
    expect(o.entry).toMatchObject({
      status: 'failed',
      disposition: 'NOT_APPLIED',
      target: 'a.txt',
      error: { code: 'TOOL_NOT_STARTED', recoverability: 'recoverable', stage: 'dispatch' },
    })
    expect(o.notes).toEqual([])
  })
  it('keeps only bounded excerpts and marks escalated steps', () => {
    const big = 'x'.repeat(200_000)
    const o = classifyResult({
      ...base,
      escalated: true,
      name: 'read',
      args: { path: 'big.txt' },
      result: ok(big),
    })
    expect(o.entry.output_excerpt).toHaveLength(500)
    expect(o.notes[0]?.text.length).toBeLessThanOrEqual(600)
    expect(o.entry.summary.endsWith(' [escalated]')).toBe(true)
  })
})

const schema = (name: string, description = name) => ({
  name,
  description,
  parameters: BUILTIN_SCHEMAS[name] ?? { type: 'object' },
})

const builtinMeta = (name: string): LoopToolMeta => {
  const meta = BUILTIN_META[name]
  if (meta === undefined) throw new Error(`no meta for ${name}`)
  return meta
}

describe('with platform metadata', () => {
  it('takes the names a request without tools would send, without compact and run_code', () => {
    const view = turnView({
      tools: ['read', 'ls', 'compact', 'run_code', 'docs_search'],
      platform: { disclosed: ['read', 'compact', 'run_code', 'docs_search', 'ls', 'read'] },
    })
    expect(turnToolNames(view)).toEqual(['docs_search', 'ls', 'read'])
  })
  it('falls back to the built-in names when the view has no disclosed names', () => {
    const view = turnView({ tools: ['read', 'ls', 'docs_search', 'tool_search'] })
    expect(turnToolNames(view)).toEqual(builtinToolNames(view))
    expect(turnToolNames(view)).toEqual(['ls', 'read', 'tool_search'])
  })
  it('resolves a read-only tool without a profile to INSPECT with only model parameters', () => {
    const tool = resolveUnprofiled(schema('docs_search', 'Search the docs.'), {
      isReadOnly: true,
      isDestructive: false,
      isOpenWorld: true,
      offered: true,
    })
    expect(tool).toMatchObject({
      phases: ['INSPECT'],
      writeClass: 'read',
      readOnly: true,
      profiled: false,
      criteria: 'Search the docs.',
      targetParam: null,
      defaults: null,
      bindingDefaults: null,
      referenceKind: null,
      multiTargetMax: 1,
    })
  })
  it('treats a mutable open-world tool, or one without metadata, as an external write', () => {
    expect(
      resolveUnprofiled(schema('deploy'), {
        isReadOnly: false,
        isDestructive: true,
        isOpenWorld: true,
        offered: true,
      }),
    ).toMatchObject({ phases: ['ACT'], writeClass: 'external', readOnly: false })
    expect(resolveUnprofiled(schema('deploy'), undefined)).toMatchObject({
      writeClass: 'external',
      readOnly: false,
    })
    expect(
      resolveUnprofiled(schema('todo'), {
        isReadOnly: false,
        isDestructive: false,
        isOpenWorld: false,
        offered: true,
      }).writeClass,
    ).toBe('workspace')
  })
  it('lets the metadata decide whether a built-in tool is read-only and keeps the shell class', () => {
    expect(resolveTool(schema('read'), { ...builtinMeta('read'), isReadOnly: false })).toMatchObject({
      readOnly: false,
      writeClass: 'workspace',
    })
    expect(resolveTool(schema('shell'), { ...builtinMeta('shell'), isOpenWorld: true })).toMatchObject({
      writeClass: 'workspace',
    })
  })
  it('leaves the discovery tools and tools the model is not offered out of the decision surface', () => {
    const view = turnView({
      tools: ['ls', 'read', 'tool_search', 'docs_search', 'hidden'],
      platform: { meta: { hidden: { offered: false } } },
    })
    const names = decisionTools(view, ['docs_search', 'hidden', 'ls', 'read', 'tool_search']).map(
      (t) => t.name,
    )
    expect(names).toEqual(['ls', 'read', 'docs_search'])
  })
  it('puts the built-in tools first in built-in order, then the others by name', () => {
    const view = turnView({ tools: ['find', 'grep', 'ls', 'read', 'zeta', 'docs_search'], platform: true })
    const names = decisionTools(view, ['find', 'grep', 'ls', 'read', 'zeta', 'docs_search']).map(
      (t) => t.name,
    )
    expect(names).toEqual(['ls', 'read', 'grep', 'find', 'docs_search', 'zeta'])
  })
  it('leaves tools without a profile out of the decision surface when the view has no tool metadata', () => {
    const view = turnView({ tools: ['ls', 'read', 'docs_search'] })
    const names = decisionTools(view, ['docs_search', 'ls', 'read']).map((t) => t.name)
    expect(names).toEqual(['ls', 'read'])
  })
  it('uses the trimmed description of a tool without a profile as its criteria', () => {
    expect(resolveUnprofiled(schema('docs_search', '  Search the docs.\n'), undefined).criteria).toBe(
      'Search the docs.',
    )
  })
  it('classifies a failed read-only call of a tool without a profile as not applied and recoverable', () => {
    const obs = classifyResult({
      phase: 'INSPECT',
      name: 'docs_search',
      args: {},
      result: { content: [{ type: 'text', text: 'boom' }], isError: true },
      cwd: '/w',
      confidence: 0.9,
      escalated: false,
      readOnly: true,
    })
    expect(obs.entry).toMatchObject({
      disposition: 'NOT_APPLIED',
      error: { code: 'EXECUTION_FAILED', recoverability: 'recoverable' },
    })
  })
  it('keeps a failed call of a mutable tool without a profile as an unknown effect', () => {
    const obs = classifyResult({
      phase: 'ACT',
      name: 'deploy',
      args: {},
      result: { content: [{ type: 'text', text: 'boom' }], isError: true },
      cwd: '/w',
      confidence: 0.9,
      escalated: false,
      readOnly: false,
    })
    expect(obs.entry).toMatchObject({
      disposition: 'UNKNOWN',
      error: { code: 'EFFECT_UNKNOWN', recoverability: 'unsafe' },
    })
  })
})

describe('tool disclosure', () => {
  const builtins = ['ls', 'read', 'grep', 'find', 'write', 'edit', 'shell', 'tool_search', 'tool_describe']
  const withCode = [...builtins, 'run_code']
  it.each<{ name: string; tools: string[]; disclosed: string[]; refused: boolean }>([
    { name: 'hybrid', tools: withCode, disclosed: withCode, refused: true },
    { name: 'code', tools: withCode, disclosed: ['run_code'], refused: true },
    { name: 'code without a code runtime', tools: builtins, disclosed: [], refused: true },
    { name: 'standard with run_code in the catalog', tools: withCode, disclosed: builtins, refused: false },
    {
      name: 'standard after a deferred tool was loaded',
      tools: [...withCode, 'docs_search'],
      disclosed: [...builtins, 'docs_search'],
      refused: false,
    },
    { name: 'a catalog without built-in tools', tools: ['docs_search'], disclosed: [], refused: false },
  ])('$name', ({ tools, disclosed, refused }) => {
    expect(codeDisclosure(turnView({ tools, platform: { disclosed } }))).toBe(refused)
  })
  it('refuses nothing when the view does not list the disclosed tools', () => {
    expect(codeDisclosure(turnView({ tools: ['ls', 'run_code'] }))).toBe(false)
  })
})
