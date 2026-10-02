import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { type CallContext, defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type { DataRef, ScopeRef } from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ApprovalOwnerSources,
  createApprovalOwnerInstallation,
} from '../../src/runtime/identity/approval-owner-install.js'
import { createIdentityAuthority } from '../../src/runtime/identity/authority.js'
import { createIdentityNonceOwner } from '../../src/runtime/identity/nonce.js'
import { verifyIdentityJwt } from '../../src/runtime/identity/verify.js'

const close: Array<() => void> = []
afterEach(() => {
  for (const action of close.splice(0).reverse()) action()
})
async function fixture(options: { acceptedBinding?: string; acceptedScope?: ScopeRef } = {}) {
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
    humanLive = true,
    targetLive = true
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
    (_instance, target) => targetLive && target.bindingId === 'state' && jcs(target.scope) === jcs(scope),
    () => sourceLive,
  )
  close.push(() => authority.close())
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ iss: 'fixture', sub: 'person', exp: now / 1000 + 60 })).toString(
    'base64url',
  )
  const input = `${header}.${body}`
  const fixtureSigningKey = Buffer.from('isolated signing fixture')
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
    bindingId: options.acceptedBinding ?? 'state',
    scope: options.acceptedScope ?? scope,
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
  let selectedLive = true,
    policyLive = true
  const owner = {
    authority: { authorityId: 'interaction-authority', tenantId: 'tenant', authorityEpoch: 1 },
    scope,
    ownerBinding: {
      bindingId: 'state',
      contract: 'agh.interaction',
      logicalName: 'default',
      providerId: 'fixture-interaction',
    },
  }
  const sources: ApprovalOwnerSources = {
    identity: authority,
    authentication: {
      ready() {},
      sourceCurrent: () => humanLive,
      current(proof, call, current) {
        const owned = proof && typeof proof === 'object' ? proofs.get(proof) : undefined
        return humanLive && owned?.context === call && current.authorizationRef === instance.authorizationRef
          ? { actorRef: current.identity.principalRef, authenticationRef: owned.reference }
          : null
      },
    },
    selection: {
      owner,
      ready() {},
      current: () => selectedLive,
      assertJoint(_context, target, session) {
        if (target.authorityId !== 'state-authority' || session !== 'session')
          throw new Error('actual joint scope refused')
      },
    },
    policy: {
      ready() {},
      current: () => policyLive,
      ask() {
        return undefined
      },
      verifyAuthorizationPreparation() {
        return undefined
      },
      verifyApprovalAsk() {
        return undefined
      },
    },
  }
  const installation = createApprovalOwnerInstallation(sources)

  return {
    installation,
    revokeTarget: () => {
      targetLive = false
    },
    sources,
    retireSelected: () => {
      selectedLive = false
    },
    retirePolicy: () => {
      policyLive = false
    },
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

const target = { authorityId: 'state-authority', tenantId: 'tenant', authorityEpoch: 1 }
describe('Host approval installation with actual identity sources', () => {
  it('requires every source and refuses use before ready and after close', async () => {
    const h = await fixture()
    expect(() => h.installation.issueResponder(h.context, h.authentication)).toThrow()
    await h.installation.ready()
    const capability = h.installation.issueResponder(h.context, h.authentication)
    expect(capability).not.toBeNull()
    expect(h.installation.joint.currentResponder(h.context, capability)).toEqual({
      actorRef: 'person',
      evidence: { kind: 'human', authenticationRef: h.reference },
    })
    h.installation.close()
    expect(() => h.installation.joint.currentResponder(h.context, capability)).toThrow()
    await expect(h.installation.ready()).rejects.toThrow()
    const absent = createApprovalOwnerInstallation({} as never)
    await expect(absent.ready()).rejects.toThrow('missing')
  })
  it.each(['identity', 'authentication', 'selection', 'policy'] as const)(
    'rejects readiness without actual %s owner',
    async (name) => {
      const h = await fixture()
      const missing = { ...h.sources, [name]: undefined } as unknown as ApprovalOwnerSources
      await expect(createApprovalOwnerInstallation(missing).ready()).rejects.toThrow('missing')
    },
  )
  it('keeps the originally installed source objects and owner immutable', async () => {
    const h = await fixture()
    await h.installation.ready()
    expect(Object.isFrozen(h.installation.joint.owner)).toBe(true)
    h.sources.identity = { current: h.sources.identity.current }
    expect(() => h.installation.issueResponder(h.context, h.authentication)).toThrow('changed')
  })
  it('shares one ready operation and does not expose an early capability', async () => {
    const h = await fixture()
    let release!: () => void
    h.sources.policy.ready = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const ready = h.installation.ready()
    expect(h.installation.ready()).toBe(ready)
    await Promise.resolve()
    await Promise.resolve()
    expect(() => h.installation.issueResponder(h.context, h.authentication)).toThrow()
    release()
    await ready
    expect(h.installation.issueResponder(h.context, h.authentication)).not.toBeNull()
  })
  it('rechecks Policy ask source after synchronous callback changes its current relation', async () => {
    const h = await fixture()
    await h.installation.ready()
    h.sources.policy.ask = () => {
      h.retirePolicy()
      return undefined
    }
    expect(() => h.installation.joint.ask(h.context, {} as never, {} as never)).toThrow()
  })
  it('rejects copied contexts and client JSON capabilities', async () => {
    const h = await fixture()
    await h.installation.ready()
    const capability = h.installation.issueResponder(h.context, h.authentication)
    expect(() => h.installation.issueResponder({ ...h.context }, h.authentication)).toThrow()
    expect(() => h.installation.joint.currentResponder(h.context, {})).toThrow()
    expect(() => h.installation.joint.currentResponder(h.context, { ...capability })).toThrow()
    expect(h.installation.issueResponder(h.context, {})).toBeNull()
  })
  it.each([
    'revoke',
    'retire',
    'expire',
    'revokeHuman',
    'replaceHumanReference',
    'retireSelected',
    'retirePolicy',
  ] as const)('refuses an issued capability after actual %s', async (change) => {
    const h = await fixture()
    await h.installation.ready()
    const capability = h.installation.issueResponder(h.context, h.authentication)
    h[change]()
    expect(() => h.installation.joint.currentResponder(h.context, capability)).toThrow()
  })
  it('refuses a generation change and close across a real readiness await', async () => {
    for (const action of ['retire', 'close'] as const) {
      const h = await fixture()
      let release!: () => void
      h.sources.selection.ready = () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
      const started = h.installation.ready()
      if (action === 'retire') h.retireSelected()
      else h.installation.close()
      release()
      await expect(started).rejects.toThrow()
      expect(() => h.installation.issueResponder(h.context, h.authentication)).toThrow()
    }
  })
  it('checks actual joint physical scope and current selection after its source callback', async () => {
    const h = await fixture()
    await h.installation.ready()
    h.installation.joint.assertJoint(h.context, target, 'session')
    expect(() => h.installation.joint.assertJoint(h.context, target, 'foreign')).toThrow()
    h.sources.selection.assertJoint = () => {
      h.retireSelected()
    }
    expect(() => h.installation.joint.assertJoint(h.context, target, 'session')).toThrow()
  })
  it('refuses asynchronous joint qualification and policy proof instead of allowing COMMIT', async () => {
    const h = await fixture()
    await h.installation.ready()
    h.sources.selection.assertJoint = (() => Promise.resolve()) as never
    expect(() => h.installation.joint.assertJoint(h.context, target, 'session')).toThrow('synchronously')
    h.sources.policy.verifyAuthorizationPreparation = (() => Promise.resolve(undefined)) as never
    expect(() =>
      h.installation.joint.verifyAuthorizationPreparation?.({} as never, {} as never, {} as never),
    ).toThrow('synchronously')
    h.sources.policy.verifyApprovalAsk = () => {
      h.retirePolicy()
      return undefined
    }
    expect(() => h.installation.joint.verifyApprovalAsk?.({} as never, {} as never, {} as never)).toThrow()
  })
})
describe('independent source last-check regression', () => {
  it('independent: refuses source replacement in the final readiness current callback', async () => {
    const h = await fixture()
    let checks = 0
    h.sources.policy.ready = () => {
      h.sources.policy.current = () => {
        if (++checks === 2) h.sources.identity = { current: h.sources.identity.current }
        return true
      }
    }
    await expect(h.installation.ready()).rejects.toThrow('replaced')
  })
  it('independent: refuses source replacement in the final responder current callback', async () => {
    const h = await fixture()
    await h.installation.ready()
    const capability = h.installation.issueResponder(h.context, h.authentication)
    let checks = 0
    h.sources.policy.current = () => {
      if (++checks === 6) h.sources.identity = { current: h.sources.identity.current }
      return true
    }
    expect(() => h.installation.joint.currentResponder(h.context, capability)).toThrow('replaced')
  })
})

it('independent: refuses close in the final responder lifecycle callback', async () => {
  const h = await fixture()
  await h.installation.ready()
  const capability = h.installation.issueResponder(h.context, h.authentication)
  let checks = 0
  h.sources.policy.current = () => {
    if (++checks === 6) h.installation.close()
    return true
  }
  expect(() => h.installation.joint.currentResponder(h.context, capability)).toThrow()
})

describe('source callback lifecycle closure', () => {
  it.each(['readiness', 'responder'] as const)(
    'refuses synchronous close inside the last %s source callback',
    async (phase) => {
      const h = await fixture()
      if (phase === 'readiness') {
        h.sources.policy.current = () => {
          h.installation.close()
          return true
        }
        await expect(h.installation.ready()).rejects.toThrow()
      } else {
        await h.installation.ready()
        const capability = h.installation.issueResponder(h.context, h.authentication)
        h.sources.policy.current = () => {
          h.installation.close()
          return true
        }
        expect(() => h.installation.joint.currentResponder(h.context, capability)).toThrow()
      }
    },
  )
})

it('independent: refuses actual identity revocation in the final responder lifecycle callback', async () => {
  const h = await fixture()
  await h.installation.ready()
  const capability = h.installation.issueResponder(h.context, h.authentication)
  let checks = 0
  h.sources.policy.current = () => {
    if (++checks === 6) h.revoke()
    return true
  }
  expect(() => h.installation.joint.currentResponder(h.context, capability)).toThrow()
})

it('refuses actual human proof revocation in the final responder lifecycle callback', async () => {
  const h = await fixture()
  await h.installation.ready()
  const capability = h.installation.issueResponder(h.context, h.authentication)
  let checks = 0
  h.sources.policy.current = () => {
    if (++checks === 6) h.revokeHuman()
    return true
  }
  expect(() => h.installation.joint.currentResponder(h.context, capability)).toThrow()
})

describe('actual issued identity target authorization', () => {
  const acceptedScope = {
    kind: 'runtime' as const,
    installationId: 'installation',
    runtimeId: 'ingress-runtime',
  }
  it('permits the authorized Interaction target while preserving the distinct accepted ingress binding and scope', async () => {
    const h = await fixture({ acceptedBinding: 'ingress', acceptedScope })
    expect(h.authority.current(h.context)?.bindingId).toBe('ingress')
    expect(h.authority.current(h.context)?.scope).toEqual(acceptedScope)
    expect(h.context.bindingId).toBe('state')
    expect(h.context.scope).not.toEqual(acceptedScope)
    await h.installation.ready()
    const capability = h.installation.issueResponder(h.context, h.authentication)
    expect(capability).not.toBeNull()
    expect(h.installation.joint.currentResponder(h.context, capability).actorRef).toBe('person')
    h.installation.joint.assertJoint(h.context, target, 'session')
  })
  it('does not issue unauthorized target contexts and refuses an issued target after its real authorizer withdraws permission', async () => {
    const h = await fixture({ acceptedBinding: 'ingress', acceptedScope })
    const input = {
      bindingId: 'forbidden',
      scope: h.context.scope,
      invocationId: 'foreign',
      traceRef: 'trace',
      deadline: h.context.deadline,
      signal: h.lifetime.signal,
    }
    expect(h.authority.issue(h.instance.authorizationRef, input)).toBeNull()
    expect(
      h.authority.issue(h.instance.authorizationRef, { ...input, bindingId: 'state', scope: acceptedScope }),
    ).toBeNull()
    await h.installation.ready()
    const capability = h.installation.issueResponder(h.context, h.authentication)
    expect(() =>
      h.installation.issueResponder({ ...h.context, bindingId: 'forbidden' }, h.authentication),
    ).toThrow()
    h.revokeTarget()
    expect(h.authority.current(h.context)).toBeNull()
    expect(() => h.installation.joint.currentResponder(h.context, capability)).toThrow()
    expect(h.authority.issue(h.instance.authorizationRef, { ...input, bindingId: 'state' })).toBeNull()
  })
  it('refuses a cross-target capability after actual SQLite authentication revocation', async () => {
    const h = await fixture({ acceptedBinding: 'ingress', acceptedScope })
    await h.installation.ready()
    const capability = h.installation.issueResponder(h.context, h.authentication)
    h.revoke()
    expect(h.authority.current(h.context)).toBeNull()
    expect(() => h.installation.joint.currentResponder(h.context, capability)).toThrow()
  })
})
