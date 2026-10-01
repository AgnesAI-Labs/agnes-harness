import {
  type AuthorEffectReference,
  defineInterceptor,
  defineTool,
  runtimeAuthorSchemas,
} from '@agnes/extension-api/runtime/authoring'
import { RuntimeServiceCatalog } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'

const allowed = [
  ['agh.files', 'read'],
  ['agh.files', 'write'],
  ['agh.files', 'list'],
  ['agh.files', 'stat'],
  ['agh.network', 'request'],
  ['agh.exec', 'run'],
] as const
const allowedKeys = new Set<string>(allowed.map(([contract, method]) => `${contract}/${method}`))
const rejected = Object.entries(RuntimeServiceCatalog).flatMap(([contract, entry]) =>
  Object.keys(entry.methods)
    .filter((method) => !allowedKeys.has(`${contract}/${method}`))
    .map((method) => [contract, method] as const),
)
const operation = (contract: string, method: string): AuthorEffectReference => ({
  contract,
  logicalName: 'default',
  method,
})
let executions = 0
const tool = (effects: readonly AuthorEffectReference[]) =>
  defineTool({
    id: 'broker-test',
    description: 'A declared broker operation',
    execution: 'opaque',
    input: runtimeAuthorSchemas.StandardToolOutput,
    effects,
    permissions: [],
    execute() {
      executions++
      return { content: [] }
    },
  })
const interceptor = (effects: readonly AuthorEffectReference[]) =>
  defineInterceptor({
    id: 'broker-hook-test',
    event: 'tool_call',
    execution: 'opaque',
    readFields: [],
    writeFields: [],
    permissions: [],
    effects,
    handle() {
      executions++
      return { allow: true as const }
    },
  })

describe('opaque broker declaration eligibility', () => {
  it.each(allowed)('accepts %s.%s without executing a handler', (contract, method) => {
    const effect = operation(contract, method)
    for (const declare of [tool, interceptor]) {
      const result = declare([effect])
      if (result.execution !== 'opaque') throw new Error('opaque declaration was not preserved')
      expect(result.effects).toEqual([effect])
      expect(Object.isFrozen(result.effects)).toBe(true)
      expect(Object.isFrozen(result.effects[0])).toBe(true)
    }
    expect(executions).toBe(0)
  })

  it.each(rejected)('refuses the remaining catalog member %s.%s', (contract, method) => {
    for (const declare of [tool, interceptor])
      expect(() => declare([operation(contract, method)])).toThrow(/broker attempt/)
    expect(executions).toBe(0)
  })

  it('refuses missing operations, duplicate references, and caller supplied eligibility', () => {
    for (const declare of [tool, interceptor]) {
      for (const effect of [operation('example.community', 'invoke'), operation('agh.files', 'missing')])
        expect(() => declare([effect])).toThrow(/broker attempt/)
      const read = operation('agh.files', 'read')
      expect(() => declare([read, read])).toThrow(/duplicate effect/)
      const supplied = { ...read, sameAttemptBrokerAllowed: true }
      expect(() => declare([supplied])).toThrow(/unknown/)
    }
    expect(executions).toBe(0)
  })

  it('rejects a mixed declaration instead of publishing a partial operation set', () => {
    for (const declare of [tool, interceptor])
      expect(() => declare([operation('agh.files', 'read'), operation('agh.exec', 'reconcile')])).toThrow(
        /broker attempt/,
      )
    expect(executions).toBe(0)
  })
})
