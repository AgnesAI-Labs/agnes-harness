import { readFileSync } from 'node:fs'
import { Value } from '@sinclair/typebox/value'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import * as MhsV1 from '../gen/ts/mhs-v1.js'

const schema = JSON.parse(readFileSync(new URL('../schema/mhs-v1.json', import.meta.url), 'utf8'))
const cases: { def: string; valid: boolean; note: string; value: unknown }[] = JSON.parse(
  readFileSync(new URL('./schema-cases.json', import.meta.url), 'utf8'),
)
const ajv = new Ajv2020({ strict: true })
ajv.addSchema(schema)
const generated = MhsV1 as unknown as Record<string, Parameters<typeof Value.Check>[0]>

// The spec's examples must validate, and messages the spec forbids must not. The generated TypeBox
// checks are what the hub runs, so they must agree with a standard 2020-12 validator on every case.
describe('mhs-v1 schema', () => {
  it.each(cases.map((c) => [`${c.def}: ${c.note}`, c] as const))('%s', (_, c) => {
    expect(ajv.validate(`${schema.$id}#/$defs/${c.def}`, c.value)).toBe(c.valid)
    const check = generated[c.def]
    expect(check, `${c.def} is not generated`).toBeDefined()
    expect(Value.Check(check as Parameters<typeof Value.Check>[0], c.value)).toBe(c.valid)
  })
})
