import { FakeRuntime } from '@agnes/code/runtime/testkit'
import type { Host } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import { doctorCodeRuntime } from '../src/commands/doctor-code-runtime.js'

type RuntimeHost = Pick<Host, 'profile' | 'runtimes'>

function hostWith(runtimes: Host['profile']['runtimes'], factories: Host['runtimes'] = {}): RuntimeHost {
  return {
    profile: { runtimes } as Host['profile'],
    runtimes: factories,
  }
}

describe('code-runtime doctor section', () => {
  it('reports a profile without a configured backend as failed', async () => {
    const section = await doctorCodeRuntime(hostWith([]))

    expect(section).toMatchObject({ name: 'code-runtime', status: 'fail' })
    expect(section.detail.join(' ')).toContain('no code runtime')
  })

  it('constructs the configured Host runtime, probes it through code, and shuts it down', async () => {
    const runtime = new FakeRuntime()
    const shutdown = vi.spyOn(runtime, 'shutdown')
    const factory = vi.fn(async () => runtime)

    const section = await doctorCodeRuntime(hostWith(['python'], { python: factory }))

    expect(section.status).toBe('ok')
    expect(section.detail).toContain('python/probe: ok runtime probe ready, version scripted-test-double')
    expect(factory).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('fails with fixed text when a runtime factory or cleanup fails', async () => {
    const factoryFailure = await doctorCodeRuntime(
      hostWith(['python'], {
        python: async () => {
          throw new Error('PRIVATE-RUNTIME-FACTORY-MARKER')
        },
      }),
    )
    expect(factoryFailure).toEqual({
      name: 'code-runtime',
      status: 'fail',
      detail: ['python/factory: fail runtime factory failed'],
    })
    expect(JSON.stringify(factoryFailure)).not.toContain('PRIVATE-RUNTIME-FACTORY-MARKER')

    const runtime = new FakeRuntime()
    runtime.shutdown = async () => {
      throw new Error('PRIVATE-RUNTIME-CLEANUP-MARKER')
    }
    const cleanupFailure = await doctorCodeRuntime(hostWith(['python'], { python: async () => runtime }))
    expect(cleanupFailure.status).toBe('fail')
    expect(cleanupFailure.detail.at(-1)).toBe('python/cleanup: fail runtime cleanup failed')
    expect(JSON.stringify(cleanupFailure)).not.toContain('PRIVATE-RUNTIME-CLEANUP-MARKER')
  })
})
