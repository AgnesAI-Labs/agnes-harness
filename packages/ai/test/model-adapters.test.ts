import { modelAdapterKind } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { JevAdapter, modelAdaptersPlugin, OpenAiAudioAdapter, PI_ADAPTER_APIS } from '../src/index.js'
import { fakeModel } from '../testkit/index.js'

type Registration = {
  id: string
  wireApi: string
  version: string
  capabilities: Record<string, unknown>
  create(config: { routes: unknown[] }): unknown
}

function registered(): Registration[] {
  const out: Registration[] = []
  modelAdaptersPlugin.apply({
    providers: {
      register: (kind: unknown, adapter: unknown) => {
        expect(kind).toBe(modelAdapterKind)
        out.push(adapter as Registration)
      },
    },
  } as never)
  return out
}

describe('the built-in model adapter registrations', () => {
  it('registers every pi protocol, openai, typesafe-systemone and openai-audio', () => {
    expect(registered().map((r) => r.id)).toEqual([
      ...PI_ADAPTER_APIS,
      'openai',
      'typesafe-systemone',
      'openai-audio',
    ])
  })

  it('selects each adapter by the id that routes name in api', () => {
    for (const r of registered()) expect(r.wireApi).toBe(r.id)
  })

  it('leaves the pi registrations as chat adapters with no payload keys', () => {
    const pi = registered().filter((r) => r.id !== 'typesafe-systemone' && r.id !== 'openai-audio')
    expect(pi.length).toBe(PI_ADAPTER_APIS.length + 1)
    for (const r of pi) {
      expect(r.capabilities).toEqual({ imageInput: true, tools: true, streaming: true })
      expect(r.capabilities).not.toHaveProperty('payload')
      expect(r.capabilities).not.toHaveProperty('payloadOnly')
      expect(r.version).toBe('0.0.0')
    }
  })

  it('registers typesafe-systemone as a payload-only adapter with its own version', () => {
    const jev = registered().find((r) => r.id === 'typesafe-systemone')
    expect(jev).toMatchObject({
      id: 'typesafe-systemone',
      wireApi: 'typesafe-systemone',
      version: '1.0.0',
      capabilities: { imageInput: false, tools: false, streaming: false, payload: true, payloadOnly: true },
    })
  })

  it('passes the registration check and lists payload and payloadOnly as capabilities', () => {
    const jev = registered().find((r) => r.id === 'typesafe-systemone') as never
    expect(() => modelAdapterKind.validate?.(jev)).not.toThrow()
    expect(modelAdapterKind.capabilities?.(jev)).toEqual(['payload', 'payloadOnly'])
  })

  it('creates an instance that accepts a payload', () => {
    const jev = registered().find((r) => r.id === 'typesafe-systemone') as Registration
    const baseUrl = 'https://jev.example.invalid/v1'
    const instance = jev.create({
      routes: [
        {
          route: 'jev',
          api: 'typesafe-systemone',
          baseUrl,
          models: [
            fakeModel({ id: 'typesafe/jev-1.13-20260917', route: 'jev', api: 'typesafe-systemone', baseUrl }),
          ],
        },
      ],
    })
    expect(instance).toBeInstanceOf(JevAdapter)
    expect((instance as JevAdapter).acceptsPayload).toBe(true)
    expect((instance as JevAdapter).id).toBe('typesafe-systemone')
    void (instance as JevAdapter).dispose()
  })

  it('does not build an instance for an already aborted registration', () => {
    const jev = registered().find((r) => r.id === 'typesafe-systemone') as Registration
    const controller = new AbortController()
    controller.abort()
    expect(() =>
      (jev.create as (c: unknown, s: AbortSignal) => unknown)({ routes: [] }, controller.signal),
    ).toThrow()
  })

  it('registers openai-audio as a payload-only adapter with its own version', () => {
    const audio = registered().find((r) => r.id === 'openai-audio') as Registration
    expect(audio).toMatchObject({ id: 'openai-audio', wireApi: 'openai-audio', version: '1.0.0' })
    expect(audio.capabilities).toEqual({
      imageInput: false,
      tools: false,
      streaming: false,
      payload: true,
      payloadOnly: true,
    })
    expect(() => modelAdapterKind.validate?.(audio as never)).not.toThrow()
    expect(modelAdapterKind.capabilities?.(audio as never)).toEqual(['payload', 'payloadOnly'])
  })

  it('creates an openai-audio instance that accepts a payload, and not for an aborted registration', () => {
    const audio = registered().find((r) => r.id === 'openai-audio') as Registration
    const baseUrl = 'https://audio.example.invalid/v1'
    const instance = audio.create({
      routes: [
        {
          route: 'audio',
          api: 'openai-audio',
          baseUrl,
          models: [
            fakeModel({ id: 'FunAudioLLM/SenseVoiceSmall', route: 'audio', api: 'openai-audio', baseUrl }),
          ],
        },
      ],
    })
    expect(instance).toBeInstanceOf(OpenAiAudioAdapter)
    expect((instance as OpenAiAudioAdapter).acceptsPayload).toBe(true)
    expect((instance as OpenAiAudioAdapter).id).toBe('openai-audio')
    void (instance as OpenAiAudioAdapter).dispose()
    const controller = new AbortController()
    controller.abort()
    expect(() =>
      (audio.create as (c: unknown, s: AbortSignal) => unknown)({ routes: [] }, controller.signal),
    ).toThrow()
  })
})
