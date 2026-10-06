import type { DefaultLoopSource } from '@agnes/core'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { runtimeAdmissionRefusal as refusal } from './entry-admission.js'
import type { SecretsService } from './providers/secrets.js'

/** Original model deployment owner, using the same consumer and C22 service as its egress. */
export interface HostRuntimeLoopCredentials {
  secrets: Pick<SecretsService, 'resolve'>
  select(
    route: W.ModelRouteSnapshot,
    frame: W.RunFrame,
    stage: 'first-model' | 'second-model',
  ): Promise<
    Outcome<{
      consumer: W.SecretConsumerBinding
      context: CallContext
      /**
       * Retain the exact issued object for model preparation and the selected egress installation.
       * Retention is not a genuineness check and records no digest set.
       */
      accept(handle: W.SecretHandle): Promise<Outcome<void>>
    }>
  >
}

/**
 * Model prepare asks this process's C22 whether a handle is still one it issued.
 * `secrets` must be the same object egress receives as `options.secrets`.
 * `context` is the prepare call's CallContext. A true result is not permission to send.
 */
export function hostModelCredentialVerifier(secrets: Pick<SecretsService, 'verifyIssued'>): {
  verifyIssued(
    handle: W.SecretHandle,
    binding: W.SecretConsumerBinding,
    context: CallContext,
  ): Promise<boolean>
} {
  return {
    async verifyIssued(handle, binding, context) {
      return (await secrets.verifyIssued(handle, binding, context)).ok
    },
  }
}

/** Host-only issuance seam; never infer an owner from a wire handle supplied by the input source. */
export function hostLoopCredentialSource(
  source: DefaultLoopSource,
  owner: HostRuntimeLoopCredentials | undefined,
): DefaultLoopSource {
  return {
    checkCurrent: (context) => source.checkCurrent(context),
    async readInputs(frame, stage, ports) {
      const inputs = await source.readInputs(frame, stage, ports)
      if (!inputs.ok) return inputs
      const routes = inputs.value.routing.allowedRoutes
      if (routes.length !== 1 || !routes[0]) return inputs
      const route = routes[0]
      if (route.credentialBinding === null) return inputs
      if (!owner || typeof owner.secrets?.resolve !== 'function')
        return refusal('incompatible', 'loop_model_credentials_unavailable')
      const selected = await owner.select(route, frame, stage)
      if (!selected.ok) return selected
      const { consumer, context, accept } = selected.value
      if (
        consumer.consumer !== 'model' ||
        canonicalJsonDigest(consumer) !== canonicalJsonDigest(route.credentialBinding) ||
        consumer.audience !== route.credentialAudience
      )
        return refusal('denied', 'loop_credential_binding')
      const issued = await owner.secrets.resolve(
        { secretId: consumer.secretId, audience: consumer.audience, purpose: consumer.purpose },
        context,
      )
      if (!issued.ok) return issued
      if (issued.value.secretId !== consumer.secretId || issued.value.audience !== consumer.audience)
        return refusal('denied', 'loop_credential_binding')
      if (Date.parse(issued.value.expiresAt) <= Date.now())
        return refusal('denied', 'loop_credential_expired')
      const retained = await accept(issued.value)
      if (!retained.ok) return retained
      return { ok: true, value: { ...inputs.value, credentialRef: issued.value } }
    },
  }
}
