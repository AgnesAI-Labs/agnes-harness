import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntimeTarget } from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import type { Host } from '../src/runtime/lifecycle/host.js'
import { createHostFacade } from '../src/runtime/lifecycle/host-facade.js'
import { createKernelFacade, HOST_MEMBER_SCOPES } from '../src/runtime/lifecycle/host-routing.js'
import { sessionHostRoutes } from '../src/runtime/lifecycle/session-host-routes.js'
import { createTestHost } from '../testkit/index.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-seam-facade-'))
  dirs.push(dir)
  return dir
}
const emptyTarget = () =>
  buildRuntimeTarget({
    rows: [],
    resources: { mcp: [], skills: {} },
    resourceRevision: '0'.repeat(64),
    compositeRevision: '0'.repeat(64),
  })
// The previous tree is retired AFTER applyRuntimeTarget resolves (runtime-state.ts `#retire`), so a
// test that asserts immediately would win the race and prove nothing.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('dynamic seams after a post-boot applyRuntimeTarget', () => {
  it('refuses an unclassified method instead of borrowing the deployment head', () => {
    const target = { futureSessionMethod: () => 'wrong-generation' }
    // @ts-expect-error Simulate a JS embedder bypassing the required session-route classification.
    const facade = createHostFacade(target as unknown as Host, {})
    expect(() => Reflect.get(facade, 'futureSessionMethod')).toThrow(/UNCLASSIFIED/)
  })

  it('refuses a session method without an explicit owner route', () => {
    const target = { readSessionRows: async () => [] }
    // @ts-expect-error The same omission must also be rejected by the TypeScript boundary.
    const facade = createHostFacade(target as unknown as Host, {})
    expect(() => facade.readSessionRows('pinned-session', { limit: 1 })).toThrow(/SESSION_ROUTE/)
  })

  it('keeps bound runtime ports and shared storage reads independent of the deployment head', async () => {
    const host = (id: string) =>
      ({
        memory: () => id,
        readSessionRows: async () => [id],
        readSessionView: async () => id,
        resolveActor: async () => id,
      }) as unknown as Host
    const one = host('one'),
      two = host('two')
    let current = one
    const bindings = new Map([
      ['first-session', one],
      ['second-session', two],
    ])
    const facade = createHostFacade(
      one,
      sessionHostRoutes(
        (key) => bindings.get(key)!,
        () => current,
        () => one,
      ),
      () => current,
    )
    const read = facade.readSessionRows
    current = two
    expect(facade.memory('/synthetic', 'first-session')).toBe('one')
    expect(await read('first-session', { limit: 1 })).toEqual(['one'])
    expect(await facade.readSessionView('first-session')).toBe('one')
    expect(facade.memory('/synthetic', 'second-session')).toBe('two')
    expect(await facade.resolveActor({}, 'session')).toBe('two')
    expect(await Promise.resolve(facade)).toBe(facade)
    expect(facade.sessionBinding).toBeUndefined()
    bindings.clear()
    expect(await facade.readSessionRows('damaged-pin', { limit: 1 })).toEqual(['one'])
    // @ts-expect-error Extending Host requires a new ownership decision, including optional methods.
    const future: Record<keyof (Host & { futureSessionMethod?(): void }), string> = HOST_MEMBER_SCOPES
    void future
  })

  it('keeps captured Kernel ports classified and refuses cold runtime admission', async () => {
    const kernel = (id: string) =>
      ({
        get: () => undefined,
        session: async () => ({ key: id }),
        registrations: (source: string) => [source, id],
        futureSessionMethod: () => id,
      }) as unknown as Host['kernel']
    const one = kernel('one'),
      two = kernel('two')
    let current = one
    const facade = createKernelFacade(
      one,
      () => current,
      (key, coldRead) => {
        if (key === 'live-session') return one
        if (key === 'next-session') return two
        if (coldRead) return one
        throw new Error('E_GENERATION_NOT_LIVE')
      },
      new Map(),
    )
    const registrations = facade.registrations
    const open = facade.session
    current = two
    expect(registrations('plugin')).toEqual(['plugin', 'two'])
    await expect(open('next-session', {} as never)).resolves.toEqual({ key: 'two' })
    expect(facade.get('cold-session')).toBeUndefined()
    expect(() => open('cold-session', {} as never)).toThrow('E_GENERATION_NOT_LIVE')
    expect(() => Reflect.get(facade, 'futureSessionMethod')).toThrow(/UNCLASSIFIED/)
    // Instrumentation delegates through the previously captured public entry point. Bound the
    // failure so a recursive facade cannot exhaust the worker before reporting the regression.
    const originalSession = one.session
    let entered = false
    one.session = async (...args) => {
      if (entered) throw new Error('Kernel instrumentation reentered itself')
      entered = true
      return open(...args)
    }
    await expect(one.session('live-session', {} as never)).resolves.toEqual({ key: 'one' })
    one.session = originalSession
    const afterPublication = facade.session
    entered = false
    facade.session = async (...args) => {
      if (entered) throw new Error('Kernel instrumentation reentered the old binding')
      entered = true
      return afterPublication(...args)
    }
    await expect(one.session('live-session', {} as never)).resolves.toEqual({ key: 'one' })
  })

  it('keeps the principals seam alive after one apply', async () => {
    const { host } = await createTestHost({ dataDir: scratch() })
    try {
      await expect(host.resolveActor({ kind: 'local' }, 'session')).resolves.toBeTruthy()
      await expect(host.applyRuntimeTarget(emptyTarget())).resolves.toMatchObject({ ok: true })
      await settle()
      await expect(host.resolveActor({ kind: 'local' }, 'session')).resolves.toBeTruthy()
    } finally {
      await host.close().catch(() => undefined)
    }
  })

  it('keeps the principals seam alive after two back-to-back applies', async () => {
    const { host } = await createTestHost({ dataDir: scratch() })
    try {
      await host.applyRuntimeTarget(emptyTarget())
      await host.applyRuntimeTarget(emptyTarget())
      await settle()
      await expect(host.resolveActor({ kind: 'local' }, 'session')).resolves.toBeTruthy()
    } finally {
      await host.close().catch(() => undefined)
    }
  })
})
