import type { Client } from '@agnes/sdk/browser'
import { expect, it, vi } from 'vitest'
import { JevStageBindings } from '../src/jev-stage-bindings.js'

function stub(languageBindings?: unknown) {
  const calls: Array<{ method: string; params: unknown }> = []
  const client = {
    async call(method: string, params: unknown) {
      calls.push({ method, params })
      if (method === '_agnes/v1/session.modelSlots')
        return {
          sessionId: (params as { sessionId: string }).sessionId,
          runtime: { id: 'jevloop', version: '1' },
          languageSlots: { parameters: 'primary', arbitration: 'primary', answer: 'primary' },
          ...(languageBindings === undefined ? {} : { languageBindings }),
          slots: [],
        }
      return { effectiveFromSeq: 3 }
    },
  }
  return { client: client as unknown as Pick<Client, 'call'>, calls }
}

it('keeps draft bindings client-side and writes only bound stages once the session exists', async () => {
  const { client, calls } = stub()
  const bindings = new JevStageBindings(client, () => {})
  expect(bindings.value(undefined)).toEqual({ parameters: null, arbitration: null, answer: null })
  await bindings.apply(undefined, {
    parameters: { route: 'gw', model: 'cheap' },
    arbitration: null,
    answer: null,
  })
  expect(calls).toEqual([])
  await bindings.flush('s1')
  expect(calls).toEqual([
    {
      method: '_agnes/v1/session.setJevStages',
      params: { sessionId: 's1', stages: { parameters: { route: 'gw', model: 'cheap' } } },
    },
  ])
  // The flushed draft becomes the live value, and the next draft starts empty.
  expect(bindings.value('s1')).toEqual({
    parameters: { route: 'gw', model: 'cheap' },
    arbitration: null,
    answer: null,
  })
  expect(bindings.value(undefined)).toEqual({ parameters: null, arbitration: null, answer: null })
})

it('skips the write for an empty draft', async () => {
  const { client, calls } = stub()
  await new JevStageBindings(client, () => {}).flush('s1')
  expect(calls).toEqual([])
})

it('reads a live session lazily and writes only the stages that changed', async () => {
  const { client, calls } = stub({
    parameters: null,
    arbitration: { route: 'gw', model: 'strong', thinking: 'high' },
    answer: null,
  })
  const changed = vi.fn()
  const bindings = new JevStageBindings(client, changed)
  expect(bindings.value('s2')).toBeUndefined()
  await vi.waitFor(() => expect(changed).toHaveBeenCalled())
  const live = bindings.value('s2')
  expect(live?.arbitration).toEqual({ route: 'gw', model: 'strong', thinking: 'high' })
  if (!live) throw new Error('live bindings missing')
  await bindings.apply('s2', { ...live, answer: { route: 'gw', model: 'cheap' } })
  expect(calls.at(-1)).toEqual({
    method: '_agnes/v1/session.setJevStages',
    params: { sessionId: 's2', stages: { answer: { route: 'gw', model: 'cheap' } } },
  })
  const writes = calls.length
  // Applying the same bindings again writes nothing.
  await bindings.apply('s2', { ...live, answer: { route: 'gw', model: 'cheap' } })
  expect(calls.length).toBe(writes)
})

it('reads a session without stage bindings (older daemon) as all-unbound', async () => {
  const { client } = stub()
  const changed = vi.fn()
  const bindings = new JevStageBindings(client, changed)
  bindings.value('s3')
  await vi.waitFor(() => expect(changed).toHaveBeenCalled())
  expect(bindings.value('s3')).toEqual({ parameters: null, arbitration: null, answer: null })
})
