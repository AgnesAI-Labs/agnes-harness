import { describe, expectTypeOf, it } from 'vitest'
import type { ServiceAuthorPort, ServiceInstance, ServicePorts } from '../src/index.js'
import { defineKind } from '../src/index.js'

describe('defineKind with bind', () => {
  it('keeps the register disposer and bindOwn instance on the token', () => {
    const kind = defineKind<ServiceInstance & { ping(): number }, ServicePorts>({
      kind: 'sample-service',
      bind: { cardinality: 'single', instanceScope: 'session', ports: ['ledger', 'input'] },
    })
    expectTypeOf(kind.cardinality).toEqualTypeOf<'single' | 'multi'>()
    expectTypeOf(kind.instanceScope).toEqualTypeOf<'request' | 'session' | 'workspace' | 'process'>()
    const port = null as unknown as ServiceAuthorPort
    const dispose = port.register(kind, { id: 'one', version: '1.0.0', open: () => ({ ping: () => 1 }) })
    expectTypeOf(dispose).toEqualTypeOf<() => Promise<void>>()
    expectTypeOf(port.bindOwn(kind)).toEqualTypeOf<Promise<ServiceInstance & { ping(): number }>>()
  })
})
