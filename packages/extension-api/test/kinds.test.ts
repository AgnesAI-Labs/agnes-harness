import { describe, expect, it } from 'vitest'
import { type ModelAdapter, modelAdapterKind } from '../src/index.js'

const adapter = (capabilities: Record<string, unknown> = {}): ModelAdapter => ({
  id: 'sample',
  wireApi: 'sample-wire',
  version: '1.0.0',
  capabilities: {
    imageInput: false,
    tools: true,
    streaming: true,
    ...capabilities,
  } as ModelAdapter['capabilities'],
  create() {
    throw new Error('not used by registration checks')
  },
})

describe('model adapter registration', () => {
  it('accepts the three required capabilities without payload keys', () => {
    expect(() => modelAdapterKind.validate(adapter())).not.toThrow()
    expect(modelAdapterKind.capabilities?.(adapter())).toEqual(['tools', 'streaming'])
  })

  it('rejects a payload or payloadOnly capability that is not a boolean', () => {
    for (const bad of ['yes', 1, null, {}]) {
      expect(() => modelAdapterKind.validate(adapter({ payload: bad }))).toThrow(
        'invalid model adapter registration',
      )
      expect(() => modelAdapterKind.validate(adapter({ payload: true, payloadOnly: bad }))).toThrow(
        'invalid model adapter registration',
      )
    }
  })

  it('rejects payloadOnly without payload', () => {
    expect(() => modelAdapterKind.validate(adapter({ payloadOnly: true }))).toThrow(
      'invalid model adapter registration',
    )
    expect(() => modelAdapterKind.validate(adapter({ payload: false, payloadOnly: true }))).toThrow(
      'invalid model adapter registration',
    )
  })

  it('accepts payload alone, payloadOnly with payload, and explicit false values', () => {
    expect(() => modelAdapterKind.validate(adapter({ payload: true }))).not.toThrow()
    expect(() => modelAdapterKind.validate(adapter({ payload: true, payloadOnly: true }))).not.toThrow()
    expect(() => modelAdapterKind.validate(adapter({ payload: false }))).not.toThrow()
    expect(() => modelAdapterKind.validate(adapter({ payload: false, payloadOnly: false }))).not.toThrow()
    expect(() => modelAdapterKind.validate(adapter({ payload: true, payloadOnly: false }))).not.toThrow()
  })

  it('lists payload and payloadOnly in the capability names only when declared true', () => {
    expect(modelAdapterKind.capabilities?.(adapter({ payload: true, payloadOnly: true }))).toEqual([
      'tools',
      'streaming',
      'payload',
      'payloadOnly',
    ])
    expect(modelAdapterKind.capabilities?.(adapter({ payload: true }))).toEqual([
      'tools',
      'streaming',
      'payload',
    ])
    expect(modelAdapterKind.capabilities?.(adapter({ payload: false, payloadOnly: false }))).toEqual([
      'tools',
      'streaming',
    ])
  })
})
