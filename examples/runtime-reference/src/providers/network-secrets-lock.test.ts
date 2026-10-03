import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  nonceBytes,
  ticketAAD,
  ticketBinding,
  ticketBoundary,
  ticketBroker,
} from '../../../../packages/host/test/runtime/artifact-ticket-key-fixture.js'
import {
  boundary,
  cleanup,
  consumer,
  error,
  must,
  resolveInput,
  scratch,
  secrets,
} from '../../../../packages/host/test/runtime/network-secrets-fixture.js'

describe.each(['network', 'secrets', 'artifact-ticket-key'])('%s independent implementation', (name) => {
  it('shares no implementation imports and fewer than half of whitespace-free lines', () => {
    const reference = readFileSync(fileURLToPath(new URL(`./${name}.ts`, import.meta.url)), 'utf8')
    const production = readFileSync(
      fileURLToPath(
        new URL(
          `../../../../packages/host/src/runtime/${name === 'artifact-ticket-key' ? name : `providers/${name}`}.ts`,
          import.meta.url,
        ),
      ),
      'utf8',
    )
    expect(reference).not.toMatch(
      /(?:from|import\s*\()[^\n]*(?:packages\/host|providers\/network|providers\/secrets|runtime\/artifact-ticket-key)/u,
    )
    const lines = (text: string) =>
      new Set(
        text
          .split('\n')
          .map((line) => line.replace(/\s/gu, ''))
          .filter(Boolean),
      )
    const a = lines(reference)
    const b = lines(production)
    const common = [...a].filter((line) => b.has(line)).length
    expect(common / Math.min(a.size, b.size)).toBeLessThanOrEqual(0.5)
  })
})

it('returns equivalent handle metadata, maintenance results and refusal codes for identical secret inputs', async () => {
  const root = scratch()
  const auth = boundary()
  const now = Date.now()
  const providers = ['default', 'reference'].map((kind) =>
    secrets(kind as 'default' | 'reference', `${root}/${kind}`, auth, { now: () => now }),
  )
  try {
    const results = []
    for (const broker of providers) {
      const locator = must(await broker.resolve(resolveInput, auth.call()))
      const { handleId: _handleId, ...metadata } = locator
      results.push({
        metadata,
        forged: error(await broker.use(locator, consumer, { ...auth.call() }, () => {})),
        audience: error(await broker.use(locator, { ...consumer, audience: 'other' }, auth.call(), () => {})),
        unauthorizedRotate: error(
          await broker.rotate({ secretId: 'credential', newVersionRef: 'secret://fixture/new' }, auth.call()),
        ),
        rotated: must(
          await broker.rotate(
            { secretId: 'credential', newVersionRef: 'secret://fixture/new' },
            auth.call({}, true),
          ),
        ),
        old: error(await broker.use(locator, consumer, auth.call(), () => {})),
        revoked: must(await broker.revoke({ secretId: 'credential', reason: 'test' }, auth.call({}, true))),
        afterRevoke: error(await broker.resolve(resolveInput, auth.call())),
      })
    }
    expect(results[0]).toEqual(results[1])
  } finally {
    for (const broker of providers) await broker.close()
    cleanup(root)
  }
})

it('returns the same plaintext, versions and refusal codes for identical private ticket inputs', async () => {
  const root = scratch()
  const auth = ticketBoundary()
  const results = []
  try {
    for (const kind of ['default', 'reference'] as const) {
      const { broker, port } = ticketBroker(kind, `${root}/${kind}`, auth)
      try {
        const aad = ticketAAD()
        const input = { binding: ticketBinding, aad, nonce: nonceBytes() }
        const old = must(await port.sealNonce(input, auth.delegate()))
        const request = { binding: ticketBinding, aad, envelope: old }
        const bindings = await Promise.all(
          ['consumer', 'secretId', 'accountRef', 'serverRef', 'audience', 'purpose'].map((field) =>
            port.openNonce({ ...request, binding: { ...ticketBinding, [field]: 'other' } }, auth.delegate()),
          ),
        )
        const associated = await Promise.all(
          ['ticketId', 'tenantId', 'authorityId', 'nonceDigest'].map((field) =>
            port.openNonce(
              { ...request, aad: { ...aad, [field]: field === 'nonceDigest' ? '0'.repeat(64) : 'other' } },
              auth.delegate(),
            ),
          ),
        )
        const opened = Array.from(must(await port.openNonce(request, auth.delegate())))
        const forged = error(await port.openNonce(request, { ...auth.delegate() }))
        const noDelegation = error(await port.openNonce(request, auth.call()))
        const rotated = must(
          await broker.rotate(
            { secretId: 'ticket-key', newVersionRef: 'secret://fixture/ticket-v2' },
            auth.call({}, true),
          ),
        )
        const retained = Array.from(must(await port.openNonce(request, auth.delegate())))
        const current = must(await port.sealNonce({ ...input, aad: ticketAAD('new') }, auth.delegate()))
        const alteredVersion = error(
          await port.openNonce({ ...request, envelope: { ...old, keyVersion: 'v2' } }, auth.delegate()),
        )
        const digestMismatch = error(
          await port.sealNonce({ ...input, aad: { ...aad, nonceDigest: '0'.repeat(64) } }, auth.delegate()),
        )
        const revoked = must(
          await broker.revoke({ secretId: 'ticket-key', reason: 'emergency' }, auth.call({}, true)),
        )
        const revokedOpen = error(await port.openNonce(request, auth.delegate()))
        results.push({
          opened,
          retained,
          forged,
          noDelegation,
          rotated,
          revoked,
          revokedOpen,
          alteredVersion,
          digestMismatch,
          bindings: bindings.map(error),
          associated: associated.map(error),
          originalVersion: old.keyVersion,
          currentVersion: current.keyVersion,
          shape: [old.iv.length, old.ciphertext.length, old.tag.length],
        })
      } finally {
        await broker.close()
      }
    }
    expect(results[0]).toEqual(results[1])
  } finally {
    cleanup(root)
  }
})
