import { describe, expect, it } from 'vitest'
import { createModelSourceReader } from '../../src/runtime/model/model-source-reader.js'
import { fixtureContext, fixtureFrame, fixturePorts } from './model-source-fixture.js'

const live = () => fixtureContext(new AbortController().signal)

function suspendedSession(ports: ReturnType<typeof fixturePorts>['ports']) {
  let resume: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  return {
    resume: () => resume?.(),
    session: {
      parameters: async (...args: Parameters<typeof ports.session.parameters>) => {
        await gate
        return ports.session.parameters(...args)
      },
    },
  }
}

describe('model source reader binding to the original call and epoch', () => {
  it('takes the epoch when the load starts, so a change before the first await is refused', async () => {
    const { ports, ref } = fixturePorts()
    const held = suspendedSession(ports)
    let epoch = 1
    const reader = createModelSourceReader({
      ...ports,
      session: held.session,
      authorize: { epoch: () => epoch },
    })
    const pending = reader.load(ref, fixtureFrame(ref), live())
    epoch = 2
    held.resume()
    expect((await pending).ok).toBe(false)
  })

  it('refuses a load whose epoch changed while session parameters were suspended', async () => {
    const { ports, ref } = fixturePorts()
    const held = suspendedSession(ports)
    let epoch = 1
    const reader = createModelSourceReader({
      ...ports,
      session: held.session,
      authorize: { epoch: () => epoch },
    })
    const pending = reader.load(ref, fixtureFrame(ref), live())
    await Promise.resolve()
    epoch = 2
    held.resume()
    expect(await pending).toMatchObject({ ok: false, error: { detailCode: 'model_source_stale' } })
  })

  it('refuses a load aborted while session parameters were suspended', async () => {
    const { ports, ref } = fixturePorts()
    const held = suspendedSession(ports)
    const controller = new AbortController()
    const reader = createModelSourceReader({ ...ports, session: held.session })
    const pending = reader.load(ref, fixtureFrame(ref), fixtureContext(controller.signal))
    controller.abort()
    held.resume()
    expect(await pending).toMatchObject({ ok: false, error: { detailCode: 'model_source_stale' } })
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
})
