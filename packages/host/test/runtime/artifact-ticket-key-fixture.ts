import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallContext } from '@agnes/extension-api/runtime'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { createReferenceSecrets } from '../../../../examples/runtime-reference/src/providers/secrets.js'
import type {
  ArtifactTicketDeployment,
  ArtifactTicketSecretBinding,
  TicketNonceAAD,
} from '../../src/runtime/artifact-ticket-key.js'
import { createSecretsService } from '../../src/runtime/providers/secrets.js'
import { boundary, consumer, type Kind, scope } from './network-secrets-fixture.js'

export const ticketBinding: ArtifactTicketSecretBinding = {
  ...consumer,
  secretId: 'ticket-key',
  consumer: 'artifact-ticket',
  purpose: 'artifact-download-ticket-nonce-envelope',
}
export const nonceBytes = () => createHash('sha256').update('synthetic-ticket-nonce').digest()
export const materialBytes = (version: string) =>
  createHash('sha256').update(`synthetic-material-${version}`).digest()
export const ticketAAD = (ticketId = 'ticket'): TicketNonceAAD => ({
  ticketId,
  tenantId: 'tenant',
  authorityId: 'selected-blob',
  nonceDigest: createHash('sha256').update(nonceBytes()).digest('hex'),
})
export function ticketBoundary() {
  const base = boundary()
  const delegates = new WeakSet<object>()
  let permitted = true
  return {
    ...base,
    delegate(patch: Partial<CallContext> = {}) {
      const call = base.call(patch)
      delegates.add(call)
      return call
    },
    withdraw() {
      permitted = false
    },
    authorize: async (call: CallContext, installed: ArtifactTicketDeployment['installation']) =>
      permitted &&
      delegates.has(call) &&
      installed.ownerId === 'selected-artifacts' &&
      installed.authorityId === 'selected-blob' &&
      canonicalJsonDigest(installed.scope) === canonicalJsonDigest(scope),
  }
}
type TicketFixturePatch = Partial<Omit<ArtifactTicketDeployment, 'authorize'>> & {
  readonly authorize?: ArtifactTicketDeployment['authorize']
}
export function ticketBroker(
  kind: Kind,
  directory: string,
  auth: ReturnType<typeof ticketBoundary>,
  patch: TicketFixturePatch = {},
  now?: () => number,
  omitOldVersion = false,
) {
  const installation = {
    binding: ticketBinding,
    principalRef: 'actor',
    ownerId: 'selected-artifacts',
    bindingId: 'consumer-binding',
    scope,
    authorityId: 'selected-blob',
  }
  const { authorize, ...deploymentPatch } = patch
  const verifier = Object.hasOwn(patch, 'authorize') ? authorize : auth.authorize
  const options = {
    directory,
    tenantId: 'tenant',
    identity: auth.identity,
    maintenance: auth.maintenance,
    ...(now === undefined ? {} : { now }),
    entries: [
      {
        secretId: 'ticket-key',
        versions: [
          { version: 'v1', ref: 'secret://fixture/ticket-v1' },
          { version: 'v2', ref: 'secret://fixture/ticket-v2' },
        ].filter((item) => !omitOldVersion || item.version === 'v2'),
      },
      {
        secretId: 'credential',
        versions: [
          { version: 'v1', ref: 'secret://fixture/old' },
          { version: 'v2', ref: 'secret://fixture/new' },
        ],
      },
    ],
    grants: [{ principalRef: 'actor', scope, binding: consumer }],
    source: {
      resolve: (ref: string) =>
        ref.includes('ticket-v')
          ? materialBytes(ref.endsWith('v1') ? 'v1' : 'v2').toString('hex')
          : 'synthetic-generic-credential',
    },
    artifactTickets: {
      installation,
      diagnosticRetentionMs: 60000,
      ...deploymentPatch,
      ...(verifier ? { authorize: verifier } : {}),
    },
  }
  const broker = kind === 'default' ? createSecretsService(options) : createReferenceSecrets(options)
  const port = broker.artifactTicketKeyPort
  if (!port) throw new Error('Missing restricted companion')
  return { broker, port, directory: join(directory, 'artifact-ticket-keys') }
}

export function scanTicketBytes(directory: string, diagnostics: readonly unknown[]) {
  const buffers = [Buffer.from(JSON.stringify(diagnostics))]
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const location = join(path, entry.name)
      if (entry.isDirectory()) visit(location)
      else buffers.push(readFileSync(location))
    }
  }
  visit(directory)
  for (const material of [nonceBytes(), materialBytes('v1'), materialBytes('v2')])
    for (const buffer of buffers)
      assert.equal(buffer.includes(material), false, 'Plain material escaped broker')
}
