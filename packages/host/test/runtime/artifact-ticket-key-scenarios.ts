import assert from 'node:assert/strict'
import { createDecipheriv } from 'node:crypto'
import { jcs } from '@agnes/protocol'
import type { ScenarioName } from '../../../extension-api/testkit/runtime/evidence.js'
import { createSecretsService } from '../../src/runtime/providers/secrets.js'
import {
  materialBytes,
  nonceBytes,
  scanTicketBytes,
  ticketAAD,
  ticketBinding,
  ticketBoundary,
  ticketBroker,
} from './artifact-ticket-key-fixture.js'
import {
  cleanup,
  consumer,
  error,
  type Kind,
  must,
  resolveInput,
  scan,
  scope,
  scratch,
} from './network-secrets-fixture.js'

export async function ticketScenario(kind: Kind, scenario: Exclude<ScenarioName, 'recover'>) {
  const root = scratch()
  const auth = ticketBoundary()
  let time = Date.now()
  const instance = ticketBroker(kind, root, auth, {}, () => time)
  const { broker, port } = instance
  const nonce = nonceBytes()
  const aad = ticketAAD()
  const input = { binding: ticketBinding, nonce, aad }
  const diagnostics: unknown[] = []
  try {
    assert.deepEqual(Object.keys(port).sort(), ['openNonce', 'sealNonce'])
    if (scenario === 'select') {
      assert.equal(
        broker.features.some((item) => item.includes('ticket')),
        false,
      )
      const ordinary = createSecretsService({
        directory: `${root}/ordinary`,
        tenantId: 'tenant',
        entries: [],
        grants: [],
        source: {
          resolve: () => {
            throw new Error('Forbidden source')
          },
        },
        identity: auth.identity,
        maintenance: auth.maintenance,
      })
      assert.equal(ordinary.artifactTicketKeyPort, undefined)
      await ordinary.close()
    } else if (scenario === 'normal') {
      assert.equal(
        error(
          await broker.resolve(
            { secretId: 'ticket-key', audience: ticketBinding.audience, purpose: ticketBinding.purpose },
            auth.delegate(),
          ),
        ),
        'denied/secret_ticket_only',
      )
      const locator = must(await broker.resolve(resolveInput, auth.call()))
      const old = must(await port.sealNonce(input, auth.delegate()))
      assert.deepEqual(Object.keys(old).sort(), ['ciphertext', 'iv', 'keyVersion', 'tag'])
      assert.equal(old.keyVersion, 'v1')
      assert.equal(old.iv.length, 12)
      assert.equal(old.tag.length, 16)
      const cipher = createDecipheriv('aes-256-gcm', materialBytes('v1'), old.iv, { authTagLength: 16 })
      cipher.setAAD(Buffer.from(jcs(aad)))
      cipher.setAuthTag(old.tag)
      assert.deepEqual(Buffer.concat([cipher.update(old.ciphertext), cipher.final()]), nonce)
      assert.deepEqual(
        Buffer.from(
          must(await port.openNonce({ binding: ticketBinding, aad, envelope: old }, auth.delegate())),
        ),
        nonce,
      )
      must(
        await broker.rotate(
          { secretId: 'ticket-key', newVersionRef: 'secret://fixture/ticket-v2' },
          auth.call({}, true),
        ),
      )
      must(
        await broker.rotate(
          { secretId: 'credential', newVersionRef: 'secret://fixture/new' },
          auth.call({}, true),
        ),
      )
      assert.equal(
        error(
          await broker.use(locator, consumer, auth.call(), () => {
            throw new Error('Old handle leaked')
          }),
        ),
        'denied/secret_handle',
      )
      const fresh = must(await port.sealNonce({ ...input, aad: ticketAAD('fresh') }, auth.delegate()))
      assert.equal(fresh.keyVersion, 'v2')
      assert.deepEqual(
        Buffer.from(
          must(await port.openNonce({ binding: ticketBinding, aad, envelope: old }, auth.delegate())),
        ),
        nonce,
      )
      assert.equal(error(await port.sealNonce(input, auth.delegate())), 'conflict/ticket_exists')
      time += 300001
      diagnostics.push(
        await port.openNonce(
          { binding: ticketBinding, aad, envelope: old },
          auth.delegate({ deadline: '2099-01-01T00:00:00.000Z' }),
        ),
      )
      assert.equal(
        error(diagnostics.at(-1) as Awaited<ReturnType<typeof port.openNonce>>),
        'denied/ticket_expired',
      )
      time += 60000
      assert.equal(
        error(
          await port.openNonce(
            { binding: ticketBinding, aad, envelope: old },
            auth.delegate({ deadline: '2099-01-01T00:00:00.000Z' }),
          ),
        ),
        'denied/ticket_version',
      )
      time -= 360001
      const next = must(await port.sealNonce({ ...input, aad: ticketAAD('revoke') }, auth.delegate()))
      must(await broker.revoke({ secretId: 'ticket-key', reason: 'emergency' }, auth.call({}, true)))
      assert.equal(
        error(
          await port.openNonce(
            { binding: ticketBinding, aad: ticketAAD('revoke'), envelope: next },
            auth.delegate(),
          ),
        ),
        'denied/ticket_revoked',
      )
      assert.equal(
        error(await port.sealNonce({ ...input, aad: ticketAAD('after-revoke') }, auth.delegate())),
        'denied/ticket_revoked',
      )
    } else if (scenario === 'deny') {
      const original = must(await port.sealNonce(input, auth.delegate()))
      for (const field of [
        'consumer',
        'secretId',
        'accountRef',
        'serverRef',
        'audience',
        'purpose',
      ] as const) {
        const changed = { ...ticketBinding, [field]: 'other' } as typeof ticketBinding
        const outcome = await port.openNonce({ binding: changed, aad, envelope: original }, auth.delegate())
        diagnostics.push(outcome)
        assert.equal(error(outcome), 'denied/ticket_binding')
        assert.equal(
          error(await port.sealNonce({ ...input, binding: changed }, auth.delegate())),
          'denied/ticket_binding',
        )
      }
      for (const change of [
        { principalRef: 'other' },
        { bindingId: 'other' },
        { scope: { ...scope, workspaceId: 'other' } },
      ]) {
        assert.equal(
          error(
            await port.openNonce({ binding: ticketBinding, aad, envelope: original }, auth.delegate(change)),
          ),
          'denied/ticket_binding',
        )
      }
      for (const field of ['ticketId', 'tenantId', 'authorityId', 'nonceDigest'] as const) {
        const changed = { ...aad, [field]: field === 'nonceDigest' ? '0'.repeat(64) : 'other' }
        const outcome = await port.openNonce(
          { binding: ticketBinding, aad: changed, envelope: original },
          auth.delegate(),
        )
        diagnostics.push(outcome)
        assert.equal(
          error(outcome),
          field === 'tenantId' || field === 'authorityId'
            ? 'denied/ticket_binding'
            : field === 'ticketId'
              ? 'denied/ticket_version'
              : 'denied/ticket_envelope',
        )
      }
      for (const field of ['iv', 'ciphertext', 'tag'] as const) {
        const replaced = Uint8Array.from(original[field])
        replaced[0] = (replaced[0] ?? 0) ^ 1
        const outcome = await port.openNonce(
          { binding: ticketBinding, aad, envelope: { ...original, [field]: replaced } },
          auth.delegate(),
        )
        diagnostics.push(outcome)
        assert.equal(error(outcome), 'denied/ticket_envelope')
      }
      assert.equal(
        error(
          await port.openNonce(
            { binding: ticketBinding, aad, envelope: { ...original, keyVersion: 'v2' } },
            auth.delegate(),
          ),
        ),
        'denied/ticket_version',
      )
      assert.equal(
        error(await port.sealNonce({ ...input, nonce: nonce.subarray(1) }, auth.delegate())),
        'invalid_input/ticket_schema',
      )
      assert.equal(
        error(
          await port.sealNonce({ ...input, aad: { ...aad, nonceDigest: '0'.repeat(64) } }, auth.delegate()),
        ),
        'denied/ticket_digest',
      )
      assert.equal(
        error(await port.openNonce({ binding: ticketBinding, aad, envelope: original }, auth.call())),
        'denied/ticket_delegation',
      )
      assert.equal(
        error(
          await port.openNonce({ binding: ticketBinding, aad, envelope: original }, { ...auth.delegate() }),
        ),
        'denied/ticket_delegation',
      )
      auth.withdraw()
      assert.equal(
        error(await port.openNonce({ binding: ticketBinding, aad, envelope: original }, auth.delegate())),
        'denied/ticket_delegation',
      )
    } else if (scenario === 'cancel') {
      const original = must(await port.sealNonce(input, auth.delegate()))
      const abort = new AbortController()
      abort.abort()
      const call = auth.delegate({ signal: abort.signal })
      assert.equal(error(await port.sealNonce(input, call)), 'cancelled/ticket_cancelled')
      assert.equal(
        error(await port.openNonce({ binding: ticketBinding, aad, envelope: original }, call)),
        'cancelled/ticket_cancelled',
      )
    } else {
      const original = must(await port.sealNonce(input, auth.delegate()))
      await broker.close()
      assert.equal(error(await port.sealNonce(input, auth.delegate())), 'denied/ticket_closed')
      assert.equal(
        error(await port.openNonce({ binding: ticketBinding, aad, envelope: original }, auth.delegate())),
        'denied/ticket_closed',
      )
    }
    scanTicketBytes(root, diagnostics)
    for (const bytes of [nonce, materialBytes('v1'), materialBytes('v2')]) {
      scan(root, [bytes.toString('hex'), bytes.toString('base64'), bytes.toString('base64url')], diagnostics)
    }
  } finally {
    await broker.close()
    cleanup(root)
  }
}
