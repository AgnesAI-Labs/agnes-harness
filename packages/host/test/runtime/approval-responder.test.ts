import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { type CallContext, defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import { type DataRef, validateRuntime } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { createApprovalResponderBridge } from '../../src/runtime/identity/approval-responder.js'
import { createIdentityAuthority } from '../../src/runtime/identity/authority.js'
import { createIdentityNonceOwner } from '../../src/runtime/identity/nonce.js'
import { verifyIdentityJwt } from '../../src/runtime/identity/verify.js'

const close: Array<() => void> = []
afterEach(() => {
  for (const action of close.splice(0).reverse()) action()
})
async function fixture() {
  const db = new DatabaseSync(':memory:')
  close.push(() => db.close())
  db.exec('CREATE TABLE qa_claims (id TEXT PRIMARY KEY, binding TEXT NOT NULL, body TEXT NOT NULL)')
  const schema = defineGeneratedAuthorSchema<{ principalRef: string }>({
    ownerPackageId: 'fixture.approval',
    name: 'Claims',
    typeId: 'fixture.approval/claims@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Claims',
      $defs: {
        Claims: {
          type: 'object',
          additionalProperties: false,
          required: ['principalRef'],
          properties: { principalRef: { type: 'string' } },
        },
      },
    },
  })
  let now = Date.parse('2026-10-02T00:00:00Z'),
    sourceLive = true,
    humanLive = true
  const authority = createIdentityAuthority(
    db,
    {
      async create(binding) {
        const result = schema.encode({ principalRef: binding.principalRef })
        if (!result.ok) throw new Error('claims invalid')
        db.prepare('INSERT INTO qa_claims VALUES (?, ?, ?)').run(
          binding.authorizationRef,
          jcs(binding),
          jcs(result.value),
        )
        return result.value
      },
      validate(ref, binding) {
        const row = db.prepare('SELECT * FROM qa_claims WHERE id=?').get(binding.authorizationRef)
        return row?.binding === jcs(binding) && row.body === jcs(ref)
      },
    },
    () => now,
    (_instance, target) => target.bindingId === 'state',
    () => sourceLive,
  )
  close.push(() => authority.close())
  const fixtureSigningKey = Buffer.from('isolated test signing material')
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ iss: 'fixture', sub: 'person', exp: now / 1000 + 60 })).toString(
    'base64url',
  )
  const input = `${header}.${body}`
  const token = `${input}.${createHmac('sha256', fixtureSigningKey).update(input).digest('base64url')}`
  const verified = verifyIdentityJwt(token, {
    now: () => now,
    generation: 'source-generation',
    nonces: createIdentityNonceOwner(db),
    jwt: { issuer: 'fixture', secret: fixtureSigningKey.toString() },
  })
  if (!verified.ok) throw new Error('real jwt refused')
  const lifetime = new AbortController()
  const scope = { kind: 'runtime' as const, installationId: 'installation', runtimeId: 'runtime' }
  const instance = await authority.accept({
    verified: verified.value,
    principalRef: 'person',
    tenantRef: 'tenant',
    bindingId: 'state',
    scope,
    signal: lifetime.signal,
    source: { kind: 'deployment', generation: 'source-generation', keyId: null },
  })
  if (!instance) throw new Error('actual identity missing')
  const context = authority.issue(instance.authorizationRef, {
    bindingId: 'state',
    scope,
    invocationId: 'respond',
    traceRef: 'trace',
    deadline: new Date(now + 60000).toISOString(),
    signal: lifetime.signal,
  })
  if (!context) throw new Error('actual issued context missing')
  // Separate test human ingress owner: JWT success alone cannot establish this private proof.
  const proofs = new WeakMap<object, { context: CallContext; reference: DataRef }>()
  const reference: DataRef = instance.identity.claims
  const authentication = Object.freeze({})
  proofs.set(authentication, { context, reference })
  const bridge = createApprovalResponderBridge({
    authority,
    authentication: {
      current(proof, call, current) {
        const owned = proof && typeof proof === 'object' ? proofs.get(proof) : undefined
        return humanLive && owned?.context === call && current.authorizationRef === instance.authorizationRef
          ? { actorRef: current.identity.principalRef, authenticationRef: owned.reference }
          : null
      },
    },
  })
  return {
    bridge,
    authority,
    authentication,
    context,
    lifetime,
    instance,
    reference,
    revoke: () => authority.revoke(instance.authorizationRef),
    retire: () => {
      sourceLive = false
    },
    expire: () => {
      now += 60001
    },
    revokeHuman: () => {
      humanLive = false
    },
    replaceHumanReference: () => {
      proofs.set(authentication, {
        context,
        reference:
          reference.kind === 'inline'
            ? { ...reference, digest: 'f'.repeat(64) }
            : { ...reference, blob: { ...reference.blob, digest: 'f'.repeat(64) } },
      })
    },
  }
}
describe('actual issued identity and private human approval responder', () => {
  it('refuses replacement of the original human authentication reference after issue', async () => {
    const h = await fixture()
    const capability = h.bridge.issue(h.context, h.authentication)
    await Promise.resolve()
    h.replaceHumanReference()
    expect(() => h.bridge.currentResponder(h.context, capability)).toThrow('not current')
  })

  it('uses the human owner original reference, never the authorization instance ID', async () => {
    const h = await fixture()
    const capability = h.bridge.issue(h.context, h.authentication)
    expect(capability).not.toBeNull()
    const actual = h.bridge.currentResponder(h.context, capability)
    expect(actual).toEqual({
      actorRef: 'person',
      evidence: { kind: 'human', authenticationRef: h.reference },
    })
    expect(validateRuntime('DataRef', actual.evidence.authenticationRef).ok).toBe(true)
    expect(jcs(actual.evidence.authenticationRef)).not.toBe(jcs(h.instance.authorizationRef))
    expect(Object.isFrozen(actual.evidence)).toBe(true)
  })
  it('refuses JSON, cloned proof, cloned context and cloned capability', async () => {
    const h = await fixture()
    const capability = h.bridge.issue(h.context, h.authentication)
    expect(
      h.bridge.issue(h.context, { kind: 'human', authenticationRef: 'actual-human-authentication' }),
    ).toBeNull()
    expect(h.bridge.issue(h.context, { ...h.authentication })).toBeNull()
    expect(h.bridge.issue({ ...h.context }, h.authentication)).toBeNull()
    expect(() => h.bridge.currentResponder(h.context, { ...capability })).toThrow('not current')
    expect(() => h.bridge.currentResponder({ ...h.context }, capability)).toThrow('not current')
  })
  it.each(['revoke', 'retire', 'expire', 'revokeHuman', 'abort'] as const)(
    'refuses %s after an actual await',
    async (change) => {
      const h = await fixture()
      const capability = h.bridge.issue(h.context, h.authentication)
      await Promise.resolve()
      if (change === 'abort') h.lifetime.abort()
      else h[change]()
      expect(() => h.bridge.currentResponder(h.context, capability)).toThrow('not current')
    },
  )
  it('authenticated JWT without a current human ingress capability grants no responder', async () => {
    const h = await fixture()
    expect(h.authority.current(h.context)).not.toBeNull()
    h.revokeHuman()
    expect(h.bridge.issue(h.context, h.authentication)).toBeNull()
    expect(() =>
      createApprovalResponderBridge({ authority: h.authority, authentication: undefined as never }),
    ).toThrow('owner absent')
  })
})
