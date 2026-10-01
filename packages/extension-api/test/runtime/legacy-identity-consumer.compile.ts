import type {
  LegacyIdentityCredentialEnvelope,
  LegacyIdentityTransportEvidence,
} from '@agnes/extension-api/runtime'
import { runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import { RuntimeIdentityLegacySchemas, RuntimeSchemaRefs } from '@agnes/protocol/runtime'

const credential: LegacyIdentityCredentialEnvelope = { kind: 'local' }
const evidence: LegacyIdentityTransportEvidence = {
  bindingId: 'binding',
  ingressId: 'ingress',
  connectionId: 'connection',
  clientId: '',
  initializeDigest: 'a'.repeat(64),
  receivedAt: '2026-10-01T00:00:00.000Z',
  transport: 'local',
  localGate: 'local-peer',
  channelBinding: 'b'.repeat(64),
  proof: { kind: 'in-process', issuerBindingId: 'binding' },
}
runtimeAuthorSchemas.LegacyIdentityCredentialEnvelope.encode(credential)
runtimeAuthorSchemas.LegacyIdentityTransportEvidence.encode(evidence)
const parsed = runtimeAuthorSchemas.LegacyIdentityCredentialEnvelope.parse(credential)
if (parsed.ok && parsed.value.kind === 'surface') {
  const sourceId: string = parsed.value.sourceId
  const token: string = parsed.value.subject.token
  void [sourceId, token]
}
const feature: 'identity-legacy-ingress.v1' = RuntimeIdentityLegacySchemas.requiredFeature
const credentialId: 'agh.identity/legacy-credential@1' =
  RuntimeSchemaRefs.LegacyIdentityCredentialEnvelope.typeId
// @ts-expect-error Local credentials carry no caller-supplied trust or privilege.
const forged: LegacyIdentityCredentialEnvelope = { kind: 'local', actor: 'self' }
// @ts-expect-error Legacy evidence describes connection transport, not HTTP.
const wrongTransport: LegacyIdentityTransportEvidence = { ...evidence, transport: 'http' }
const wrongProof: LegacyIdentityTransportEvidence = {
  ...evidence,
  // @ts-expect-error Signed proof requires the key, expiration and signature.
  proof: { kind: 'signed', issuerBindingId: 'binding' },
}
void [feature, credentialId, forged, wrongTransport, wrongProof]
