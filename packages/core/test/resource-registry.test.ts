import type { ResourceEntry } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { ResourceRegistry } from '../src/registry/resources.js'

const meta = { source: 'agnes/resources', trust: 'trusted' as const }
const resource = (): ResourceEntry => ({
  id: 'r',
  kind: 'skill',
  name: 'Skill',
  description: 'Description',
  schema: { nested: { value: 1 } },
})

it('holds detached immutable data and attribution without freezing author objects', () => {
  const registry = new ResourceRegistry(),
    entry = resource(),
    source = { ...meta }
  registry.register(entry, source)
  entry.name = 'changed'
  ;(entry.schema as { nested: { value: number } }).nested.value = 2
  source.source = 'agnes/forged'
  const snapshot = registry.snapshot(),
    record = snapshot[0]
  expect(record).toMatchObject({ entry: { name: 'Skill', schema: { nested: { value: 1 } } }, meta })
  if (!record) throw new Error('missing resource')
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Reflect.set(record?.entry ?? {}, 'name', 'forged')).toBe(false)
  expect(Reflect.set((record.entry.schema as { nested: object }).nested, 'value', 3)).toBe(false)
  expect(Reflect.set(record?.meta ?? {}, 'source', 'agnes/forged')).toBe(false)
  expect(Object.isFrozen(entry)).toBe(false)
})

it('preserves each registration and snapshots while disposal removes only its own identity', () => {
  const registry = new ResourceRegistry()
  const first = registry.register(resource(), meta),
    second = registry.register(resource(), meta)
  registry.register(resource(), { source: 'agnes/other', trust: 'builtin' })
  const snapshot = registry.snapshot()
  first()
  first()
  expect(registry.registrations(meta.source)).toEqual(['resource:r'])
  expect(registry.registrations('agnes/other')).toEqual(['resource:r'])
  second()
  expect(registry.snapshot()).toHaveLength(1)
  expect(snapshot).toHaveLength(3)
  expect(registry.registrations(meta.source)).toEqual([])
})

it.each([
  { ...resource(), kind: 'secret' },
  { ...resource(), extra: true },
  { ...resource(), id: 'x'.repeat(129) },
  { ...resource(), schema: { callback() {} } },
  { ...resource(), schema: { value: Number.NaN } },
])('rejects malformed registration without retaining a partial record: %j', (entry) => {
  const registry = new ResourceRegistry()
  expect(() => registry.register(entry as ResourceEntry, meta)).toThrow('invalid resource registration')
  expect(registry.snapshot()).toEqual([])
})

it('does not invoke accessors or accept circular data', () => {
  const registry = new ResourceRegistry()
  let reads = 0
  const entry = {
    ...resource(),
    get name() {
      reads++
      return 'secret'
    },
  }
  expect(() => registry.register(entry, meta)).toThrow('invalid resource registration')
  expect(reads).toBe(0)
  const circular: Record<string, unknown> = {}
  circular.self = circular
  expect(() => registry.register({ ...resource(), schema: circular as never }, meta)).toThrow(
    'invalid resource registration',
  )
  expect(registry.snapshot()).toEqual([])
})

it('rejects invalid attribution and trust without leaking caller data in errors', () => {
  const registry = new ResourceRegistry()
  expect(() => registry.register(resource(), { ...meta, source: 'core' })).toThrow()
  expect(() => registry.register(resource(), { ...meta, trust: 'untrusted' as never })).toThrow(
    'invalid resource registration',
  )
  expect(registry.snapshot()).toEqual([])
})

it('preserves valid large JSON resource schemas rather than imposing the event byte cap', () => {
  const registry = new ResourceRegistry(),
    schema = { description: 'x'.repeat(70000) }
  registry.register({ ...resource(), schema }, meta)
  expect(registry.snapshot()[0]?.entry.schema).toEqual(schema)
})
