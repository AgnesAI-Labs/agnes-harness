import { RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import {
  knownSchema,
  matchesKnownSchema,
  SESSION_CONTROL_REQUEST_SCHEMA,
  SESSION_CONTROL_RESULT_SCHEMA,
  SESSION_CONTROL_STATE_SCHEMA,
  stateSchemaDefinition,
} from '../../src/runtime/state/records.js'

it('stores SessionControl only under the three official method fullrefs', () => {
  const refs = RuntimeMethodSchemaRefs['agh.supervisor']
  const entries = [
    [SESSION_CONTROL_REQUEST_SCHEMA, refs.submitSessionControl.input, 'SessionControlRequest'],
    [SESSION_CONTROL_RESULT_SCHEMA, refs.submitSessionControl.output, 'SessionControlResult'],
    [SESSION_CONTROL_STATE_SCHEMA, refs.readSessionControl.output, 'SessionControlState'],
  ] as const
  for (const [registered, official, definition] of entries) {
    expect(registered).toEqual(official)
    expect(knownSchema(registered.typeId)).toEqual(official)
    expect(matchesKnownSchema(official)).toBe(true)
    expect(stateSchemaDefinition(official)).toBe(definition)
    const forged = { ...official, digest: '0'.repeat(64) }
    expect(matchesKnownSchema(forged)).toBe(false)
    expect(stateSchemaDefinition(forged)).toBeUndefined()
  }
})

it('uses the official payload codec to reject a malformed stored control request', () => {
  const definition = stateSchemaDefinition(SESSION_CONTROL_REQUEST_SCHEMA)
  expect(definition).toBe('SessionControlRequest')
  if (!definition) throw Error('control request codec missing')
  const request = {
    sessionId: 'session-1',
    requestId: 'request-1',
    expectedRevision: 0,
    command: { kind: 'set-preset', presetId: 'preset-1', presetDigest: 'a'.repeat(64), apply: 'next-run' },
  }
  expect(validateRuntime(definition, request).ok).toBe(true)
  expect(validateRuntime(definition, { ...request, unexpected: true }).ok).toBe(false)
})
