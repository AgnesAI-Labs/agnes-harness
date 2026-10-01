import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RuntimeServiceCatalog } from '../../src/runtime/index.js'
import { normalizeBrokerCatalog, normalizeRuntimeCatalog } from '../../tools/gen-runtime-catalog.js'

const allowed = [
  'agh.exec/run',
  'agh.files/list',
  'agh.files/read',
  'agh.files/stat',
  'agh.files/write',
  'agh.network/request',
]

describe('runtime broker catalog generation', () => {
  it('preserves six eligible operations through the complete normalized catalog', () => {
    const source = JSON.parse(
      readFileSync(new URL('../../schema/runtime/public.json', import.meta.url), 'utf8'),
    )
    const catalog = normalizeRuntimeCatalog(source) as Record<
      string,
      { methods: Record<string, { sameAttemptBrokerAllowed: boolean; local?: boolean; kind?: string }> }
    >
    const eligible: string[] = []
    for (const [contract, entry] of Object.entries(catalog)) {
      for (const [method, operation] of Object.entries(entry.methods)) {
        expect(typeof operation.sameAttemptBrokerAllowed, `${contract}.${method}`).toBe('boolean')
        if (operation.sameAttemptBrokerAllowed) {
          expect(operation.local).not.toBe(true)
          expect(operation.kind).toBe('action')
          eligible.push(`${contract}/${method}`)
        }
      }
    }
    expect(eligible.sort()).toEqual(allowed)
    expect(RuntimeServiceCatalog).toEqual(catalog)
    expect(normalizeBrokerCatalog(catalog)).toEqual(RuntimeServiceCatalog)
    for (const [contract, entry] of Object.entries(catalog)) {
      for (const [method, operation] of Object.entries(entry.methods)) {
        if (method.startsWith('authority'))
          expect(operation.sameAttemptBrokerAllowed, `${contract}.${method}`).toBe(false)
      }
    }
  })

  it('defaults new methods to false without mutating the authority', () => {
    const method = { kind: 'action', input: 'Input', output: 'Output' }
    const catalog = { 'example.service': { major: 1, methods: { invoke: method } } }
    expect(normalizeBrokerCatalog(catalog)).toEqual({
      'example.service': {
        major: 1,
        methods: { invoke: { ...method, sameAttemptBrokerAllowed: false } },
      },
    })
    expect(Object.hasOwn(method, 'sameAttemptBrokerAllowed')).toBe(false)
  })

  it.each([null, 1, 'true', [], {}])('refuses a nonboolean eligibility value %j', (flag) => {
    expect(() =>
      normalizeBrokerCatalog({
        'example.service': {
          methods: {
            invoke: { kind: 'action', input: 'Input', output: 'Output', sameAttemptBrokerAllowed: flag },
          },
        },
      }),
    ).toThrow(/invalid broker eligibility/)
  })

  it.each(['query', 'compute', 'control', 'maintenance', 'observe', 'ingress'])(
    'refuses an eligible %s method',
    (kind) => {
      expect(() =>
        normalizeBrokerCatalog({
          'example.service': {
            methods: { invoke: { kind, input: 'Input', output: 'Output', sameAttemptBrokerAllowed: true } },
          },
        }),
      ).toThrow(/invalid broker eligibility/)
    },
  )

  it('refuses eligible Local methods and operations without Wire payload names', () => {
    for (const method of [
      { local: true, localInterface: 'Client', localMethod: 'read', sameAttemptBrokerAllowed: true },
      { kind: 'action', output: 'Output', sameAttemptBrokerAllowed: true },
      { kind: 'action', input: 'Input', output: '', sameAttemptBrokerAllowed: true },
    ])
      expect(() => normalizeBrokerCatalog({ 'example.service': { methods: { invoke: method } } })).toThrow(
        /invalid broker eligibility/,
      )
  })
})
