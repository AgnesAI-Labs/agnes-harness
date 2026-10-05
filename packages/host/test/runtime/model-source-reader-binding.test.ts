import { describe, expect, it } from 'vitest'
import { createModelSourceReader } from '../../src/runtime/model/model-source-reader.js'
import { fixtureContext, fixtureFrame, fixturePorts } from './model-source-fixture.js'

const live = () => fixtureContext(new AbortController().signal)

describe('model source reader binding to the original call and epoch', () => {
  it('refuses a load whose epoch changed while issuance was suspended', async () => {
    const { ports, ref } = fixturePorts()
    let resume: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    let epoch = 1
    const reader = createModelSourceReader({
      ...ports,
      issuance: {
        read: async (...args) => {
          await gate
          return ports.issuance.read(...args)
        },
      },
      authorize: { epoch: () => epoch },
    })
    const pending = reader.load(ref, fixtureFrame(ref), live())
    epoch = 2
    resume?.()
    const loaded = await pending
    expect(loaded.ok).toBe(false)
  })

  it('refuses a load whose epoch changed while session parameters were suspended', async () => {
    const { ports, ref } = fixturePorts()
    let resume: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    let epoch = 1
    const reader = createModelSourceReader({
      ...ports,
      session: {
        parameters: async (...args) => {
          await gate
          return ports.session.parameters(...args)
        },
      },
      authorize: { epoch: () => epoch },
    })
    const pending = reader.load(ref, fixtureFrame(ref), live())
    await Promise.resolve()
    epoch = 2
    resume?.()
    expect((await pending).ok).toBe(false)
  })

  it('refuses a load aborted while issuance was suspended', async () => {
    const { ports, ref } = fixturePorts()
    const controller = new AbortController()
    const reader = createModelSourceReader({
      ...ports,
      issuance: {
        read: async (...args) => {
          controller.abort()
          return ports.issuance.read(...args)
        },
      },
    })
    const loaded = await reader.load(ref, fixtureFrame(ref), fixtureContext(controller.signal))
    expect(loaded.ok).toBe(false)
  })

  it('does not treat a different call at the same epoch as current', async () => {
    const { ports, ref } = fixturePorts()
    const reader = createModelSourceReader(ports)
    const frame = fixtureFrame(ref)
    const original = live()
    const loaded = await reader.load(ref, frame, original)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    const foreign = live()
    expect(foreign.call).not.toBe(original.call)
    expect(reader.current(loaded.value, frame, foreign.call)).toBe(false)
    expect(reader.current(loaded.value, frame, original.call)).toBe(true)
  })

  it('refuses a prepared reference whose bytes do not match its canonical bytes', async () => {
    const { ports, ref } = fixturePorts()
    const reader = createModelSourceReader(ports)
    const wrong = { ...ref, bytes: ref.bytes + 1 }
    const loaded = await reader.load(wrong, fixtureFrame(wrong), live())
    expect(loaded.ok).toBe(false)
  })

  it('refuses a frame whose inner prepared reference differs from the loaded one', async () => {
    const { ports, ref } = fixturePorts()
    const reader = createModelSourceReader(ports)
    const loaded = await reader.load(ref, fixtureFrame({ ...ref, bytes: ref.bytes + 1 }), live())
    expect(loaded.ok).toBe(false)
  })
})
