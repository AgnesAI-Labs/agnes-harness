import type { ProviderFactory, ServiceProvider } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { RuntimeMethodSchemaRefs, RuntimeServiceCatalog, validateRuntime } from '@agnes/protocol/runtime'
import { mediaContinuationCodec, mediaPrepareAction } from '../media/continuation.js'
import { refuse } from '../media/errors.js'
import { limitsConfigured } from '../media/identity.js'
import type { MediaDeployment } from '../media/ports.js'

export type { MediaDeployment } from '../media/ports.js'

/** One `prepare` action; no authority-transfer feature is declared because nothing authoritative is stored. */
export function mediaProviderDescriptor(
  d: Pick<MediaDeployment, 'binding' | 'packageDigest' | 'packageVersion' | 'configSchema' | 'requires'>,
): W.ProviderDescriptor {
  const prepare = RuntimeMethodSchemaRefs['agh.media'].prepare
  const checked = validateRuntime('ProviderDescriptor', {
    providerId: d.binding.providerId,
    contract: 'agh.media',
    major: RuntimeServiceCatalog['agh.media'].major,
    logicalName: d.binding.logicalName,
    packageVersion: d.packageVersion ?? '1.0.0',
    packageDigest: d.packageDigest,
    features: [],
    scope: 'runtime',
    configSchema: d.configSchema,
    requires: d.requires,
    capabilities: [],
    recovery: 'R2',
    isolation: ['trusted-in-process'],
    stateCodecs: [mediaContinuationCodec],
    activationMode: 'eager',
    operations: [
      {
        method: 'prepare',
        kind: 'action',
        inputSchema: prepare.input,
        outputSchema: prepare.output,
        requiredCapabilities: [],
        retrySafety: 'never',
      },
    ],
  })
  if (!checked.ok) throw new Error('invalid agh.media descriptor')
  return checked.value
}

export function createDefaultMediaFactory(d: MediaDeployment): ProviderFactory<ServiceProvider> {
  const descriptor = mediaProviderDescriptor(d)
  return {
    descriptor,
    async create(_config, _dependencies, context) {
      if (context.bindingId !== d.binding.bindingId) throw new TypeError('Media binding mismatch')
      if (!limitsConfigured(d.limits)) throw new TypeError('Media limits are not configured')
      const lifetime = new AbortController()
      let closed = false
      let draining = false
      return {
        async ready(ctx) {
          return closed || draining || d.authorize(ctx) !== true
            ? refuse('denied', 'provider_closed')
            : { ok: true, value: undefined }
        },
        async health(ctx) {
          const ready = !closed && !draining && d.authorize(ctx) === true
          return { ok: true, value: { status: ready ? 'ready' : 'failed', diagnosticIds: [] } }
        },
        async drain() {
          draining = true
          return {
            ok: true,
            value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
          }
        },
        async close() {
          closed = true
          lifetime.abort()
        },
        actions: {
          prepare: mediaPrepareAction(d, lifetime.signal, { closed: () => closed, draining: () => draining }),
        },
      }
    },
  }
}
