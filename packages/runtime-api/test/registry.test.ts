import { describe, expect, it } from 'vitest'
import {
  assertRuntimeOwner,
  NATIVE_RUNTIME,
  type RuntimeDescriptor,
  type RuntimeFactory,
  RuntimeRegistry,
  type RuntimeSession,
  readRuntimeIdentity,
} from '../src/index.js'

const descriptor = (id = 'native', available = true): RuntimeDescriptor => ({
  id,
  version: '1',
  apiVersion: 1,
  label: id,
  available,
  capabilities: { prompt: true, cancel: true, resume: true, compact: false, fork: false },
})

const factory = (id = 'native'): RuntimeFactory<string> => ({
  descriptor: descriptor(id),
  async open(key) {
    return { key, lastSeq: 0, closingOrClosed: false, async close() {} }
  },
})

describe('runtime ownership', () => {
  it('recognizes historical Native ownership and refuses cross-runtime or cross-version recovery', () => {
    expect(readRuntimeIdentity(undefined)).toEqual(NATIVE_RUNTIME)
    expect(assertRuntimeOwner(undefined, NATIVE_RUNTIME)).toEqual(NATIVE_RUNTIME)
    expect(assertRuntimeOwner({ id: 'jevloop', version: '1' }, { id: 'jevloop', version: '1' })).toEqual({
      id: 'jevloop',
      version: '1',
    })
    expect(() => assertRuntimeOwner(undefined, { id: 'jevloop', version: '1' })).toThrow(
      'session belongs to runtime native@1',
    )
    expect(() => assertRuntimeOwner({ id: 'native', version: '2' }, NATIVE_RUNTIME)).toThrow(
      'session belongs to runtime native@2',
    )
    for (const invalid of [
      null,
      {},
      [],
      { id: 'native', version: 1 },
      { id: '', version: '1' },
      { id: 'native', version: '1', generation: 2 },
    ]) {
      expect(() => readRuntimeIdentity(invalid)).toThrow()
    }
  })
})

describe('runtime registry', () => {
  it('opens independent implementations and refuses missing, unavailable, and duplicate registrations', async () => {
    const registry = new RuntimeRegistry<string>()
    registry.register(factory())
    registry.register(factory('jevloop'))
    registry.register({
      ...factory('disabled'),
      descriptor: { ...descriptor('disabled', false), unavailableReason: 'missing provider' },
    })
    expect(registry.list().map((item) => item.id)).toEqual(['native', 'jevloop', 'disabled'])
    expect(() => registry.register(factory())).toThrow('already registered')
    expect(() => registry.acquire({ id: 'native', version: '2' })).toThrow('unavailable')
    expect(() => registry.acquire({ id: 'disabled', version: '1' })).toThrow('missing provider')
    for (const id of ['native', 'jevloop']) {
      const lease = registry.acquire({ id, version: '1' })
      const session = await lease.open(`${id}-session`)
      expect(session.key).toBe(`${id}-session`)
      await session.close()
      lease.release()
    }
  })

  it('pins admitted openings across retirement and does not retire a replacement generation', async () => {
    const registry = new RuntimeRegistry<string>()
    const first = registry.register(factory())
    const lease = registry.acquire(NATIVE_RUNTIME)
    let drained = false
    void first.whenDrained().then(() => {
      drained = true
    })
    first.retire()
    expect(() => registry.acquire(NATIVE_RUNTIME)).toThrow('unavailable')
    const second = registry.register(factory())
    expect(second.generation).toBeGreaterThan(first.generation)
    first.retire()
    const replacement = registry.acquire(NATIVE_RUNTIME)
    expect(replacement.generation).toBe(second.generation)
    expect(lease.generation).toBe(first.generation)
    const session = await lease.open('old-generation')
    expect(drained).toBe(false)
    await session.close()
    lease.release()
    lease.release()
    await first.whenDrained()
    expect(drained).toBe(true)
    expect(registry.list()).toHaveLength(1)
    replacement.release()
    second.retire()
    await second.whenDrained()
  })

  it('holds retirement through pending creation and requires the owner to release failed openings', async () => {
    const registry = new RuntimeRegistry<string>()
    let reject!: (error: Error) => void
    const pending = new Promise<RuntimeSession>((_resolve, fail) => {
      reject = fail
    })
    const registration = registry.register({ descriptor: descriptor(), open: () => pending })
    const lease = registry.acquire(NATIVE_RUNTIME)
    const opening = lease.open('pending')
    registration.retire()
    expect(() => lease.release()).toThrow('pending runtime opening')
    const failure = expect(opening).rejects.toThrow('opening failed')
    reject(new Error('opening failed'))
    await failure
    await expect(lease.open('retry')).rejects.toThrow('already opened')
    lease.release()
    await registration.whenDrained()
    await expect(lease.open('released')).rejects.toThrow('released')
  })

  it('snapshots catalog metadata so caller mutation cannot change admitted capabilities', () => {
    const registry = new RuntimeRegistry<string>()
    const original = {
      ...descriptor(),
      capabilities: { prompt: true, cancel: true, resume: true, compact: false, fork: false },
    }
    registry.register({ ...factory(), descriptor: original })
    original.capabilities.fork = true
    expect(registry.list()[0]?.capabilities.fork).toBe(false)
    expect(Object.isFrozen(registry.list()[0])).toBe(true)
    const lease = registry.acquire(NATIVE_RUNTIME)
    lease.release()
    expect(lease.descriptor.capabilities.fork).toBe(false)
  })
})
