import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { jcs } from '../../src/jcs.js'
import { RuntimeSchemaRefs } from '../../src/runtime/index.js'
import { loadRuntimeSchemaGraph } from '../../tools/gen-runtime-graph.js'
import { generateRuntimeReferences, runtimeSchemaDocument } from '../../tools/gen-runtime-refs.js'

it('registers the existing prepared body without changing any previously registered reference', () => {
  const { document, publicDocument } = loadRuntimeSchemaGraph(resolve('packages/protocol/schema/runtime'))
  const source = runtimeSchemaDocument(document, 'PreparedModelRequest')
  const ref = RuntimeSchemaRefs.PreparedModelRequest
  expect(ref.typeId).toBe('agh.model/prepared-request@1')
  expect(ref.revision).toBe(3)
  expect(ref.digest).toBe(createHash('sha256').update(jcs(source)).digest('hex'))
  const before = structuredClone(publicDocument)
  const registrations = before['x-schema-ids']
  if (!registrations || typeof registrations !== 'object' || Array.isArray(registrations))
    throw Error('Invalid original registration metadata')
  Reflect.deleteProperty(registrations, 'PreparedModelRequest')
  const oldRefs = generateRuntimeReferences(document, before)
  const newRefs = generateRuntimeReferences(document, publicDocument)
  expect(newRefs.RuntimeMethodSchemaRefs).toEqual(oldRefs.RuntimeMethodSchemaRefs)
  for (const [name, original] of Object.entries(oldRefs.RuntimeSchemaRefs))
    expect(newRefs.RuntimeSchemaRefs[name]).toEqual(original)
  expect(Object.keys(newRefs.RuntimeSchemaRefs)).toHaveLength(
    Object.keys(oldRefs.RuntimeSchemaRefs).length + 1,
  )
})
