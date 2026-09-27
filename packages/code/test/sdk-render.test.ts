import { spawnSync } from 'node:child_process'
import type { ToolDef } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { annotate, PY_RESERVED, pythonBinding, renderPython } from '../src/index.js'
import { snapshot, tool } from './fixtures/sdk.js'

const schema = (value: unknown) => value as ToolDef['parameters']
// guards-allow-platform: Windows Python installations expose python.exe; python3 can be a Store alias.
const python = process.env.AGNES_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
// A cold Python process can take over 10s to start while the Windows CI runner executes other files.
const pythonTimeout = process.platform === 'win32' ? 40_000 : undefined
const pythonIt = (name: string, run: () => void) => it(name, run, pythonTimeout)
function parse(text: string) {
  const result = spawnSync(
    python,
    [
      '-I',
      '-X',
      'utf8',
      '-c',
      `import ast,json,sys
source=sys.stdin.read()
compile(source, '<sdk>', 'exec')
tree=ast.parse(source)
print(json.dumps({'methods':[n.name for n in ast.walk(tree) if isinstance(n,ast.AsyncFunctionDef)],'strings':[n.value for n in ast.walk(tree) if isinstance(n,ast.Constant) and isinstance(n.value,str)]}))`,
    ],
    {
      input: text,
      encoding: 'utf8',
      timeout: process.platform === 'win32' ? 30_000 : 10_000,
      windowsHide: true,
    },
  )
  expect(result.error).toBeUndefined()
  expect(result.status, `${python}: ${result.stderr}; set AGNES_TEST_PYTHON to a Python executable`).toBe(0)
  return JSON.parse(result.stdout) as { methods: string[]; strings: string[] }
}
pythonIt('uses actual registry metadata, excludes self/deferred, and reports every skipped reason', () => {
  const skipped: string[] = []
  const text = renderPython(
    snapshot([tool('read'), tool('later', undefined, true), tool('run_code'), tool('class')]),
    { onSkip: (name, reason) => skipped.push(`${name}:${reason}`) },
  )
  expect(parse(text).methods).toEqual(['read'])
  expect(text).toContain('async def read() -> Any: ...')
  expect(skipped).toEqual(['class:reserved-word', 'later:deferred', 'run_code:self'])
  expect(text.split('\n')[0]).toContain('every call goes back through the harness')
})
pythonIt('produces valid empty SDKs without advertising a nonexistent tool', () => {
  const text = renderPython(snapshot([]))
  expect(parse(text).methods).toEqual([])
  expect(text).not.toContain('tools.read')
  expect(text).toContain('    pass')
})
pythonIt('renders required and optional keyword parameters without inventing nullability', () => {
  const text = renderPython(
    snapshot([
      tool('read', {
        type: 'object',
        properties: { path: { type: 'string' }, limit: { type: 'integer' } },
        required: ['path'],
      }),
    ]),
  )
  expect(text).toContain('read(*, limit: int = ..., path: str)')
  expect(text).not.toContain('int | None')
  expect(parse(text).methods).toEqual(['read'])
})
pythonIt('preserves nested object fields and unsafe keyword keys with TypedDict and Unpack', () => {
  const text = renderPython(
    snapshot([
      tool('send', {
        type: 'object',
        properties: {
          class: { type: 'string' },
          nested: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
        },
        required: ['class'],
      }),
    ]),
  )
  expect(text).toContain('**kwargs: Unpack[_AgnesShape1]')
  expect(text).toContain('"class": Required[str]')
  expect(text).toContain('"count": Required[int]')
  expect(text).toContain('"nested": NotRequired[_AgnesShape2]')
  expect(parse(text).methods).toEqual(['send'])
})
pythonIt('keeps malicious literal contents as data and emits parseable Python', () => {
  const attack = "中文 x']\nraise RuntimeError('injected')\n#\\\u0000"
  const text = renderPython(
    snapshot([tool('send', { type: 'object', properties: { choice: { enum: [attack, true, null] } } })]),
  )
  const parsed = parse(text)
  expect(parsed.methods).toEqual(['send'])
  expect(parsed.strings).toContain(attack)
})
it('maps union, enum, object, array and unsupported annotations without parsing quoted values', () => {
  expect(annotate(schema({ anyOf: [{ const: 'a' }, { const: "b'c" }] }))).toBe('Literal["a", "b\'c"]')
  expect(annotate(schema({ anyOf: [{ type: 'string' }, { type: 'null' }] }))).toBe('str | None')
  expect(annotate(schema({ type: 'array', items: { type: 'boolean' } }))).toBe('list[bool]')
  expect(annotate(schema({ type: 'object', properties: {} }))).toBe('dict[str, Any]')
  expect(annotate(schema({ enum: [] }))).toBe('Any')
  expect(annotate(schema({ $ref: '#recursive' }))).toBe('Any')
})
pythonIt('normalizes planned separator names without relaxing the actual registry guard', () => {
  expect(pythonBinding('read-')).toEqual({ binding: 'read_', renamed: true })
  expect(pythonBinding('a.b')).toEqual({ binding: 'a_b', renamed: true })
  expect(pythonBinding('9lives')).toBeNull()
  expect(() => snapshot([tool('a-b')])).toThrow('E_TOOLDEF_META')
  // Synthetic future-name compatibility view; current real registry deliberately rejects a-b.
  const synthetic = { ...snapshot([]), defs: [tool('a-b'), tool('a_b'), tool('9lives')] }
  const skipped: string[] = []
  expect(parse(renderPython(synthetic, { onSkip: (n, r) => skipped.push(`${n}:${r}`) })).methods).toEqual([
    'a_b',
  ])
  expect(skipped).toEqual(['9lives:unrenderable-name', 'a_b:name-collision'])
})
it('keeps Python 3.12 reserved names immutable and output deterministic', () => {
  for (const name of ['False', 'await', 'type', 'match', 'case', '_', 'tools'])
    expect(PY_RESERVED.has(name)).toBe(true)
  expect(Reflect.get(PY_RESERVED, 'add')).toBeUndefined()
  const a = snapshot([tool('z'), tool('a')]),
    b = snapshot([tool('a'), tool('z')])
  expect(renderPython(a)).toBe(renderPython(b))
})
