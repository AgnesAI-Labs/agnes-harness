import type { HostRuntimeLoopCredentials } from '@agnes/host'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { CONSUMER, modelFixture } from '../../../host/test/runtime/model-egress-fixture.js'

/** Real C22 and Host egress/HTTP; restricted original identity and C04 substitutes are explicit. */
export async function loopCredentialsFixture(
  mode: string,
  observe: (event: Record<string, unknown>) => void,
) {
  const consumer = { ...CONSUMER, audience: 'restricted' }
  const issuedConsumer = {
    ...consumer,
    ...(mode === 'credential-secret' ? { secretId: 'other-secret' } : {}),
    ...(mode === 'credential-audience' ? { audience: 'other-audience' } : {}),
  }
  const f = await modelFixture(
    'default',
    'openai-completions',
    '/v1/chat/completions',
    issuedConsumer,
    mode === 'credential-expired' ? { handleMs: 0 } : {},
  )
  let retained: W.SecretHandle | undefined
  let issued: W.SecretHandle | undefined
  const owner: HostRuntimeLoopCredentials = {
    secrets: {
      async resolve(request, context) {
        const parsed = request as W.SecretsResolveRequest
        observe({
          method: 'secrets.resolve',
          correctBinding:
            parsed.secretId === consumer.secretId &&
            parsed.audience === consumer.audience &&
            parsed.purpose === consumer.purpose,
        })
        // Negative rows still issue real C22 handles; the substituted broker resolves another grant.
        const result = await f.broker.resolve(
          {
            secretId: issuedConsumer.secretId,
            audience: issuedConsumer.audience,
            purpose: issuedConsumer.purpose,
          },
          context,
        )
        if (result.ok) issued = result.value
        return result
      },
    },
    async select() {
      if (mode === 'credential-owner-denied') f.auth.revoke()
      return {
        ok: true,
        value: {
          consumer,
          context: f.call,
          async accept(handle) {
            retained = handle
            f.options.installation.handle = handle
            observe({
              method: 'credential.accept',
              exactHandle: handle === issued && f.options.installation.handle === issued,
            })
            return { ok: true, value: undefined }
          },
        },
      }
    },
  }
  return {
    consumer,
    wireHandle: structuredClone(f.options.installation.handle),
    owner,
    async execute(credentialRef: W.SecretHandle | null) {
      observe({
        method: 'model.infer',
        sameHandle: !!retained && canonicalJsonDigest(credentialRef) === canonicalJsonDigest(retained),
      })
      const response = await f.port().fetch(f.request())
      await response.text()
      observe({
        method: 'model.egress',
        observations: f.observations,
        exactHandle: f.options.installation.handle === retained,
      })
    },
    async close() {
      // Scan all serialized observations and C22 durable files for the synthetic key.
      f.logs.push(JSON.stringify(f.observations))
      await f.close()
      observe({ method: 'credential.close', keyAbsent: true })
    },
  }
}
