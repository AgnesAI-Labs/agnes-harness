import { createHmac, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import type { SessionControlRequest } from '@agnes/protocol/runtime'
import { createIdentityAuthority } from '../../../src/runtime/identity/authority.js'
import { createIdentityNonceOwner } from '../../../src/runtime/identity/nonce.js'
import { verifyIdentityJwt } from '../../../src/runtime/identity/verify.js'
import { createRuntimeStateStore } from '../../../src/runtime/providers/state.js'
import { createRuntimeAdmissionSource } from '../../../src/runtime/state/admission.js'
import { canonicalJson } from '../../../src/runtime/state/canonical-json.js'
import { digestOf } from '../../../src/runtime/state/records.js'
import {
  createSessionControlClaimsOwner,
  createSessionControlConfiguration,
} from '../../../src/runtime/state/session-control-configuration.js'
import { createSessionControlSource } from '../../../src/runtime/state/session-control-source.js'
import { RuntimeStateDatabase } from '../../../src/runtime/state/transactions.js'
import { createSessionControlSourceFixture } from './session-control-source.js'

const at = '2026-04-01T00:00:00.000Z',
  until = '2026-04-01T00:10:00.000Z'
export async function createStateSessionControlFixture() {
  const f = await createSessionControlSourceFixture()
  await f.configuration.issueBase('ticket', f.request, f.context)
  const source = createSessionControlSource({ database: f.db, configuration: f.configuration })
  f.state.installSessionControlSource(source)
  const store = createRuntimeStateStore(f.options, f.state)
  const cleanup: Array<() => void> = [f.close]
  function command(
    requestId = 'command',
    expectedRevision: number | null = 0,
    presetId = 'leaf',
  ): SessionControlRequest {
    const preset = [f.request.defaults.preset, ...f.request.presets].find((p) => {
      const document = p.document
      return document !== null && typeof document === 'object' && 'id' in document && document.id === presetId
    })
    if (!preset) throw Error('actual retained preset missing')
    return {
      sessionId: 'session',
      requestId,
      expectedRevision,
      command: { kind: 'set-preset', apply: 'next-run', presetId, presetDigest: preset.source.digest },
    }
  }
  async function secondActor(principal: string) {
    const secret = randomBytes(32).toString('hex'),
      header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
      payload = Buffer.from(
        JSON.stringify({ iss: 'issuer', sub: principal, exp: Date.parse(until) / 1000 }),
      ).toString('base64url')
    const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
    const verified = verifyIdentityJwt(`${header}.${payload}.${signature}`, {
      now: () => Date.parse(at),
      generation: 'generation',
      nonces: createIdentityNonceOwner(f.db),
      jwt: { issuer: 'issuer', secret },
    })
    if (!verified.ok) throw Error('genuine second credential refused')
    const actor = await f.identity.accept({
      verified: verified.value,
      principalRef: principal,
      tenantRef: 'tenant',
      bindingId: f.context.bindingId,
      scope: f.context.scope,
      signal: new AbortController().signal,
      source: { kind: 'deployment', generation: 'generation', keyId: 'fixture' },
    })
    if (!actor) throw Error('genuine second actor refused')
    const context = f.identity.issue(actor.authorizationRef, {
      bindingId: f.context.bindingId,
      scope: f.context.scope,
      invocationId: 'second-control',
      traceRef: 'trace',
      deadline: until,
      signal: new AbortController().signal,
    })
    if (!context) throw Error('genuine second context refused')
    return { actor, context }
  }
  async function reopen(workspaceId?: string) {
    f.identity.close()
    f.state.close()
    const state = new RuntimeStateDatabase(f.options)
    cleanup.push(() => state.close())
    const db = Object.values(Object.getOwnPropertyDescriptors(state))
      .map((d) => d.value)
      .find((v) => v instanceof DatabaseSync)
    if (!(db instanceof DatabaseSync)) throw Error('native original State database missing')
    const codec = f.permissionCodec
    const claims = createSessionControlClaimsOwner(db, codec)
    if (f.context.scope.kind !== 'session') throw Error('real full session namespace required')
    const scope = { ...f.context.scope, workspaceId: workspaceId ?? f.context.scope.workspaceId }
    const identity = createIdentityAuthority(
      db,
      claims,
      () => Date.parse(at),
      (_a, target) =>
        target.bindingId === f.context.bindingId && canonicalJson(target.scope) === canonicalJson(scope),
      () => true,
    )
    cleanup.push(() => identity.close())
    const secret = randomBytes(32).toString('hex'),
      header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
      payload = Buffer.from(
        JSON.stringify({ iss: 'issuer', sub: 'controller', exp: Date.parse(until) / 1000 }),
      ).toString('base64url')
    const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
    const verified = verifyIdentityJwt(`${header}.${payload}.${signature}`, {
      now: () => Date.parse(at),
      generation: 'generation',
      nonces: createIdentityNonceOwner(db),
      jwt: { issuer: 'issuer', secret },
    })
    if (!verified.ok) throw Error('genuine reopened credential refused')
    const actor = await identity.accept({
      verified: verified.value,
      principalRef: 'controller',
      tenantRef: 'tenant',
      bindingId: f.context.bindingId,
      scope,
      signal: new AbortController().signal,
      source: { kind: 'deployment', generation: 'generation', keyId: 'fixture' },
    })
    if (!actor) throw Error('genuine reopened actor refused')
    const context: CallContext | null = identity.issue(actor.authorizationRef, {
      bindingId: f.context.bindingId,
      scope,
      invocationId: 'cold-control',
      traceRef: 'trace',
      deadline: until,
      signal: new AbortController().signal,
    })
    if (!context) throw Error('genuine reopened context refused')
    state.installAdmissionSource(
      createRuntimeAdmissionSource({ database: db, identity, authority: f.options.authority }),
    )
    const configuration = createSessionControlConfiguration({
      database: db,
      state,
      stateOptions: f.options,
      identity,
      parameterSchema: f.parameterSchema,
      permissionOwner: claims,
      producerCodeDigest: digestOf({ code: 'restricted-session-config' }),
      qualifiedUntil: until,
    })
    state.installSessionControlSource(createSessionControlSource({ database: db, configuration }))
    return { state, db, context, identity, actor, store: createRuntimeStateStore(f.options, state) }
  }
  return {
    ...f,
    store,
    command,
    reopen,
    secondActor,
    close() {
      for (const fn of cleanup.splice(0).reverse()) fn()
    },
  }
}
