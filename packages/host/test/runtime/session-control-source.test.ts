import { createHmac, randomBytes } from 'node:crypto'
import type { CallContext } from '@agnes/extension-api/runtime'
import { afterEach, expect, it } from 'vitest'
import { createIdentityNonceOwner } from '../../src/runtime/identity/nonce.js'
import { verifyIdentityJwt } from '../../src/runtime/identity/verify.js'
import { digestOf } from '../../src/runtime/state/records.js'
import { createSessionControlConfiguration } from '../../src/runtime/state/session-control-configuration.js'
import { createSessionControlSource } from '../../src/runtime/state/session-control-source.js'
import { createSessionControlSourceFixture } from './fixtures/session-control-source.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})
async function fixture() {
  const f = await createSessionControlSourceFixture()
  cleanups.push(f.close)
  return f
}
it('requires an original issued configuration, not a resolver candidate', async () => {
  const f = await fixture()
  const source = createSessionControlSource({ database: f.db, configuration: f.configuration })
  expect(() => source.captureRead('session', f.context)).toThrow(/issuance/)
  expect(f.db.prepare('SELECT count(*) n FROM runtime_session_configuration_issued').get()?.n).toBe(0)
})
it('qualifies the real resolver, admitted binding and issued C14 session identity without writing a State command', async () => {
  const f = await fixture()
  const before = f.db.prepare('SELECT count(*) n FROM events').get()?.n
  const selectedPreset = f.request.presets[0]
  if (!selectedPreset) throw Error('original selected preset missing')
  const issued = await f.configuration.issueBase('ticket', f.request, f.context)
  const source = createSessionControlSource({ database: f.db, configuration: f.configuration })
  const cap = source.captureSubmit(
    {
      sessionId: 'session',
      requestId: 'command',
      expectedRevision: 0,
      command: {
        kind: 'set-preset',
        presetId: 'leaf',
        presetDigest: selectedPreset.source.digest,
        apply: 'next-run',
      },
    },
    f.context,
  )
  expect(cap.configuration.binding.profileDigest).toBe(issued.resolved.profileDigest)
  const afterIssue = f.db.prepare('SELECT total_changes() n').get()?.n
  expect(await f.configuration.issueBase('ticket', f.request, f.context)).toEqual(issued)
  expect(f.db.prepare('SELECT total_changes() n').get()?.n).toBe(afterIssue)
  cap.dynamicCheck()
  cap.finalCheck()
  expect(f.db.prepare('SELECT count(*) n FROM events').get()?.n).toBe(before)
  expect(() => source.captureRead('session', { ...f.context })).toThrow()
  f.identity.revoke(f.actor.authorizationRef)
  expect(() => cap.dynamicCheck()).toThrow()
  expect(f.configuration.readHistorical('session').issue).toEqual(issued)
})
it('refuses missing native issuance and constructor recovery without recreating it', async () => {
  const f = await fixture()
  await f.configuration.issueBase('ticket', f.request, f.context)
  f.db.prepare('DELETE FROM runtime_session_configuration_issued').run()
  const before = f.db.prepare('SELECT total_changes() n').get()?.n
  await expect(f.configuration.issueBase('ticket', f.request, f.context)).rejects.toThrow(/issuance/)
  expect(() =>
    createSessionControlConfiguration({
      database: f.db,
      state: f.state,
      stateOptions: f.options,
      identity: f.identity,
      parameterSchema: f.parameterSchema,
      permissionOwner: f.permissionOwner,
      producerCodeDigest: digestOf({ code: 'restricted-session-config' }),
      qualifiedUntil: '2026-04-01T00:10:00.000Z',
    }),
  ).toThrow(/issuance/)
  expect(f.db.prepare('SELECT total_changes() n').get()?.n).toBe(before)
})
it('rolls back native issuance if the last genuine issuer clock revokes the original identity', async () => {
  const f = await fixture()
  let count = 0
  f.setClock(() => {
    if (f.db.prepare('SELECT count(*) n FROM runtime_session_configuration_issued').get()?.n === 1) {
      count++
      f.identity.revoke(f.actor.authorizationRef)
    }
  })
  await expect(f.configuration.issueBase('ticket', f.request, f.context)).rejects.toThrow()
  expect(count).toBeGreaterThan(0)
  expect(f.db.prepare('SELECT count(*) n FROM runtime_session_configuration_issued').get()?.n).toBe(0)
})
it('rejects deletion of the original claims issuance at the final issuer clock', async () => {
  const f = await fixture()
  let deleted = 0
  f.setClock(() => {
    if (f.db.prepare('SELECT count(*) n FROM runtime_session_configuration_issued').get()?.n === 1) {
      deleted += Number(
        f.db
          .prepare('DELETE FROM runtime_session_control_claims_issued WHERE authorization_ref=?')
          .run(f.actor.authorizationRef).changes,
      )
    }
  })
  await expect(f.configuration.issueBase('ticket', f.request, f.context)).rejects.toThrow()
  expect(deleted).toBe(1)
  expect(f.db.prepare('SELECT count(*) n FROM runtime_session_control_claims_issued').get()?.n).toBe(1)
  expect(f.db.prepare('SELECT count(*) n FROM runtime_session_configuration_issued').get()?.n).toBe(0)
})

async function acceptCredential(
  f: Awaited<ReturnType<typeof fixture>>,
  principalRef: string,
  scope: CallContext['scope'] = f.context.scope,
) {
  const secret = randomBytes(32).toString('hex')
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ iss: 'issuer', sub: principalRef, exp: Date.parse(f.context.deadline) / 1000 }),
  ).toString('base64url')
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  const checked = verifyIdentityJwt(`${header}.${payload}.${signature}`, {
    now: () => Date.parse('2026-04-01T00:00:00.000Z'),
    generation: 'generation',
    nonces: createIdentityNonceOwner(f.db),
    jwt: { issuer: 'issuer', secret },
  })
  if (!checked.ok) throw Error('actual renewed credential refused')
  const actor = await f.identity.accept({
    verified: checked.value,
    principalRef,
    tenantRef: 'tenant',
    bindingId: 'controller',
    scope,
    signal: new AbortController().signal,
    source: { kind: 'deployment', generation: 'generation', keyId: 'fixture' },
  })
  if (!actor) throw Error('actual actor refused')
  const context = f.identity.issue(actor.authorizationRef, {
    bindingId: 'controller',
    scope,
    invocationId: 'control',
    traceRef: 'trace',
    deadline: f.context.deadline,
    signal: new AbortController().signal,
  })
  if (!context) throw Error('actual issued context refused')
  return { actor, context }
}
it('derives stable actors from the original issued identity across credentials and refuses another actor proof', async () => {
  const f = await fixture()
  await f.configuration.issueBase('ticket', f.request, f.context)
  const source = createSessionControlSource({ database: f.db, configuration: f.configuration })
  const first = source.captureRead('session', f.context)
  const renewed = await acceptCredential(f, 'controller')
  const second = source.captureRead('session', renewed.context)
  expect(renewed.actor.authorizationRef).not.toBe(f.actor.authorizationRef)
  expect(second.permission.actorRef).toBe(first.permission.actorRef)
  expect(second.permission.permissionSourceDigest).not.toBe(first.permission.permissionSourceDigest)
  expect(second.permission.authorizationRef).toBe(renewed.actor.authorizationRef)
  const other = await acceptCredential(f, 'other-controller')
  const otherPermission = source.captureRead('session', other.context).permission
  expect(otherPermission.actorRef).not.toBe(first.permission.actorRef)
  expect(() =>
    f.configuration.readHistoricalPermission({ ...otherPermission, actorRef: first.permission.actorRef }),
  ).toThrow()
})
it('reads the original command permission after revocation but denies current entry and missing native permission', async () => {
  const f = await fixture()
  await f.configuration.issueBase('ticket', f.request, f.context)
  const source = createSessionControlSource({ database: f.db, configuration: f.configuration })
  const selected = f.request.presets[0]
  if (!selected) throw Error('selected native preset missing')
  const request = {
    sessionId: 'session',
    requestId: 'command',
    expectedRevision: null,
    command: {
      kind: 'set-preset' as const,
      presetId: 'leaf',
      presetDigest: selected.source.digest,
      apply: 'next-run' as const,
    },
  }
  const cap = source.captureSubmit(request, f.context)
  expect(cap.permission.capability).toBe('set-preset:next-run')
  f.identity.revoke(f.actor.authorizationRef)
  const before = f.db.prepare('SELECT total_changes() n').get()?.n
  const historical = source.readHistoricalCommand(request, cap.permission)
  historical.staticCheck()
  expect(f.db.prepare('SELECT total_changes() n').get()?.n).toBe(before)
  expect(() => source.captureSubmit(request, f.context)).toThrow()
  expect(() => source.captureRead('session', f.context)).toThrow()
  expect(() => source.captureStatus('session', f.context)).toThrow()
  expect(() =>
    source.readHistoricalCommand({ ...request, sessionId: 'another-session' }, cap.permission),
  ).toThrow()
  f.db
    .prepare('DELETE FROM runtime_session_control_claims_issued WHERE authorization_ref=?')
    .run(f.actor.authorizationRef)
  expect(() => historical.staticCheck()).toThrow()
  expect(() => source.readHistoricalCommand(request, cap.permission)).toThrow()
})
it('selects the original default preset without duplicating it in the resolver inheritance chain', async () => {
  const f = await fixture()
  await f.configuration.issueBase('ticket', f.request, f.context)
  const source = createSessionControlSource({ database: f.db, configuration: f.configuration })
  const original = f.request.defaults.preset
  const cap = source.captureSubmit(
    {
      sessionId: 'session',
      requestId: 'base-command',
      expectedRevision: 0,
      command: {
        kind: 'set-preset',
        presetId: 'base',
        presetDigest: original.source.digest,
        apply: 'next-run',
      },
    },
    f.context,
  )
  expect(cap.selected.preset.id).toBe('base')
  expect(cap.selected.profileDigest).toBe(cap.configuration.binding.profileDigest)
  expect(cap.selected.presetDigest).not.toBe(cap.configuration.binding.presetDigest)
  cap.dynamicCheck()
  cap.finalCheck()
})

it('refuses another issued workspace with the same principal and session identifier before exposing configuration', async () => {
  const f = await createSessionControlSourceFixture({ additionalWorkspace: 'other-workspace' })
  cleanups.push(f.close)
  await f.configuration.issueBase('ticket', f.request, f.context)
  const source = createSessionControlSource({ database: f.db, configuration: f.configuration })
  source.captureRead('session', f.context).finalCheck()
  if (f.context.scope.kind !== 'session') throw Error('original session namespace missing')
  const foreignScope = { ...f.context.scope, workspaceId: 'other-workspace' }
  const foreign = await acceptCredential(f, 'controller', foreignScope)
  expect(f.identity.current(foreign.context)?.identity.principalRef).toBe('controller')
  const before = f.db.prepare('SELECT total_changes() n').get()?.n
  expect(() => source.captureRead('session', foreign.context)).toThrow()
  expect(() => source.captureStatus('session', foreign.context)).toThrow()
  const selected = f.request.presets[0]
  if (!selected) throw Error('selected original preset missing')
  expect(() =>
    source.captureSubmit(
      {
        sessionId: 'session',
        requestId: 'cross-workspace',
        expectedRevision: null,
        command: {
          kind: 'set-preset',
          presetId: 'leaf',
          presetDigest: selected.source.digest,
          apply: 'next-run',
        },
      },
      foreign.context,
    ),
  ).toThrow()
  await expect(f.configuration.issueBase('ticket', f.request, foreign.context)).rejects.toThrow()
  expect(f.db.prepare('SELECT total_changes() n').get()?.n).toBe(before)
})

it('allows every genuine session user to select an allowed preset without a grant table', async () => {
  const f = await fixture()
  expect(
    f.db
      .prepare("SELECT name FROM sqlite_master WHERE name='runtime_session_control_permission_grants'")
      .get(),
  ).toBeUndefined()
  await f.configuration.issueBase('ticket', f.request, f.context)
  const another = await acceptCredential(f, 'another-session-user')
  const source = createSessionControlSource({ database: f.db, configuration: f.configuration })
  const selected = f.request.defaults.preset
  const cap = source.captureSubmit(
    {
      sessionId: 'session',
      requestId: 'all-users',
      expectedRevision: 0,
      command: {
        kind: 'set-preset',
        presetId: 'base',
        presetDigest: selected.source.digest,
        apply: 'next-run',
      },
    },
    another.context,
  )
  cap.dynamicCheck()
  cap.finalCheck()
  expect(cap.permission.principalRef).toBe('another-session-user')
})
it.each([
  ["UPDATE runtime_record_heads SET min_reader=1 WHERE record_id='run-binding:run'"],
  [
    "UPDATE runtime_commit_proofs SET manifests_json=json_remove(manifests_json,'$[0]') WHERE commit_id=(SELECT last_commit_id FROM runtime_records WHERE record_id='run-binding:run')",
  ],
  ["DELETE FROM runtime_admission_source_proofs WHERE ticket_id='ticket'"],
])('refuses changed original Binding header or committed source proof: %s', async (sql) => {
  const f = await fixture()
  await f.configuration.issueBase('ticket', f.request, f.context)
  const source = createSessionControlSource({ database: f.db, configuration: f.configuration })
  source.captureRead('session', f.context).finalCheck()
  expect(f.db.prepare(sql).run().changes).toBe(1)
  expect(() => source.captureRead('session', f.context)).toThrow()
})
