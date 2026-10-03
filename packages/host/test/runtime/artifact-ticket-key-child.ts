import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TicketNonceEnvelope } from '../../src/runtime/artifact-ticket-key.js'
import {
  nonceBytes,
  ticketAAD,
  ticketBinding,
  ticketBoundary,
  ticketBroker,
} from './artifact-ticket-key-fixture.js'
import { error, type Kind, must } from './network-secrets-fixture.js'

const [kind, directory, mode] = process.argv.slice(2) as [Kind, string, string]
const auth = ticketBoundary()
const { broker, port } = ticketBroker(kind, directory, auth, {}, undefined, mode !== 'seal')
const file = join(directory, 'sealed-fixture.json')
if (mode === 'seal') {
  const envelope = must(
    await port.sealNonce({ binding: ticketBinding, aad: ticketAAD(), nonce: nonceBytes() }, auth.delegate()),
  )
  writeFileSync(
    file,
    JSON.stringify({
      ...envelope,
      iv: Buffer.from(envelope.iv).toString('base64url'),
      ciphertext: Buffer.from(envelope.ciphertext).toString('base64url'),
      tag: Buffer.from(envelope.tag).toString('base64url'),
    }),
    { mode: 0o600 },
  )
  must(
    await broker.rotate(
      { secretId: 'ticket-key', newVersionRef: 'secret://fixture/ticket-v2' },
      auth.call({}, true),
    ),
  )
  process.stdout.write('sealed-and-rotated\n')
} else {
  const stored = JSON.parse(readFileSync(file, 'utf8')) as {
    keyVersion: string
    iv: string
    ciphertext: string
    tag: string
  }
  const envelope: TicketNonceEnvelope = {
    keyVersion: stored.keyVersion,
    iv: Buffer.from(stored.iv, 'base64url'),
    ciphertext: Buffer.from(stored.ciphertext, 'base64url'),
    tag: Buffer.from(stored.tag, 'base64url'),
  }
  const request = { binding: ticketBinding, aad: ticketAAD(), envelope }
  if (mode === 'open') {
    assert.deepEqual(Buffer.from(must(await port.openNonce(request, auth.delegate()))), nonceBytes())
    assert.equal(error(await port.openNonce(request, auth.call())), 'denied/ticket_delegation')
    const current = must(
      await port.sealNonce(
        { binding: ticketBinding, aad: ticketAAD('new'), nonce: nonceBytes() },
        auth.delegate(),
      ),
    )
    assert.equal(current.keyVersion, 'v2')
    must(await broker.revoke({ secretId: 'ticket-key', reason: 'emergency' }, auth.call({}, true)))
    assert.equal(error(await port.openNonce(request, auth.delegate())), 'denied/ticket_revoked')
    process.stdout.write('old-opened-new-issued-revoked\n')
  } else {
    assert.equal(error(await port.openNonce(request, auth.delegate())), 'denied/ticket_revoked')
    process.stdout.write('cold-revocation-refused\n')
  }
}
setInterval(() => {}, 1000)
