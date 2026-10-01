/**
 * Restricted EffectPorts peer for tests.
 * Code under test receives `ports`. A call is forwarded only when that port and
 * operation were registered. Every other call is refused. Received calls are
 * kept for assertions.
 * The public upload request is an operation, an input reference, and a byte
 * source. It has no chunk-offset or seal payload, and this fixture does not
 * define one.
 */
import type { EffectPorts, Outcome, RuntimeError } from '@agnes/extension-api/runtime'

export const RESTRICTED_EFFECTS_FIXTURE = 'restricted-effects' as const

export type RestrictedEffectPort = 'invoke' | 'stream' | 'upload'

export interface RestrictedEffectCall {
  readonly port: RestrictedEffectPort
  readonly operation: string
}

export type RestrictedEffectGrant =
  | {
      readonly port: 'invoke'
      readonly operation: string
      readonly handle: EffectPorts['invoke']
    }
  | {
      readonly port: 'stream'
      readonly operation: string
      readonly handle: EffectPorts['stream']
    }
  | {
      readonly port: 'upload'
      readonly operation: string
      readonly handle: EffectPorts['upload']
    }

export interface RestrictedEffectsFixture {
  readonly kind: 'fixture'
  readonly mark: typeof RESTRICTED_EFFECTS_FIXTURE
  readonly ports: EffectPorts
  allow(grant: RestrictedEffectGrant): void
  calls(): readonly RestrictedEffectCall[]
}

const DIAGNOSTIC_ID = 'restricted-effects'

function refusal(port: RestrictedEffectPort, operation: string): Outcome<never> {
  const error: RuntimeError = {
    code: 'incompatible',
    detailCode: 'operation_not_supported',
    message: `${port} ${operation} is not registered`,
    retryAdvice: { kind: 'never' },
    diagnosticId: DIAGNOSTIC_ID,
  }
  return { ok: false, error }
}

function operationName(request: { readonly operation: string }): string {
  return typeof request.operation === 'string' ? request.operation : ''
}

function grantKey(port: RestrictedEffectPort, operation: string): string {
  return `${port}\0${operation}`
}

export function createRestrictedEffectsFixture(): RestrictedEffectsFixture {
  const calls: RestrictedEffectCall[] = []
  const granted = new Map<string, RestrictedEffectGrant>()
  function take(port: RestrictedEffectPort, operation: string): RestrictedEffectGrant | undefined {
    calls.push({ port, operation })
    return granted.get(grantKey(port, operation))
  }
  const ports: EffectPorts = {
    async invoke(request, context) {
      const operation = operationName(request)
      const grant = take('invoke', operation)
      if (grant === undefined || grant.port !== 'invoke') return refusal('invoke', operation)
      return grant.handle(request, context)
    },
    async stream(request, context) {
      const operation = operationName(request)
      const grant = take('stream', operation)
      if (grant === undefined || grant.port !== 'stream') return refusal('stream', operation)
      return grant.handle(request, context)
    },
    async upload(request, source, context) {
      const operation = operationName(request)
      const grant = take('upload', operation)
      if (grant === undefined || grant.port !== 'upload') return refusal('upload', operation)
      return grant.handle(request, source, context)
    },
  }
  return {
    kind: 'fixture',
    mark: RESTRICTED_EFFECTS_FIXTURE,
    ports,
    allow(grant) {
      if (grant.operation === '') throw new Error('effect operation is empty')
      const key = grantKey(grant.port, grant.operation)
      if (granted.has(key)) throw new Error('effect already registered')
      granted.set(key, grant)
    },
    calls() {
      return calls.slice()
    },
  }
}
