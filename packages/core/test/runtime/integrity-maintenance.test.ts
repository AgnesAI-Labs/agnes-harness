import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  type DataRef,
  type JsonValue,
  type OwnerRef,
  RuntimeMethodSchemaRefs,
  type SchemaRef,
  validateRuntime,
  validateRuntimeErrorDetail,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { createIntegrityProvider, type IntegrityTransferPort } from '../../src/runtime/providers/integrity.js'

const binding = {
  bindingId: 'integrity-binding',
  providerId: 'default.integrity',
  logicalName: 'primary',
  contract: 'agh.integrity',
}
const scope = { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' } as const
const refs = RuntimeMethodSchemaRefs['agh.integrity']
const refuse = (): Outcome<never> => ({
  ok: false,
  error: {
    code: 'denied',
    detailCode: 'permission_denied',
    message: 'denied',
    diagnosticId: 'fixture-owner',
    retryAdvice: { kind: 'never' },
  },
})
function inline(schema: SchemaRef, value: JsonValue): DataRef {
  return {
    kind: 'inline',
    schema,
    value,
    digest: canonicalJsonDigest(value),
    bytes: Buffer.byteLength(jcs(value)),
  }
}
const request = () => ({
  target: binding,
  method: 'authorityAbort',
  input: inline(refs.authorityAbort.input, {
    upgradeId: 'upgrade',
    expectedFenceId: 'fence',
    recoveryRoute: inline(refs.canonicalize.input, { value: null }),
  }),
})
function context(signal = new AbortController().signal): CallContext {
  return {
    principalRef: 'admin',
    authorizationRef: 'grant',
    scope,
    bindingId: binding.bindingId,
    invocationId: 'call',
    traceRef: 'trace',
    deadline: new Date(Date.now() + 60000).toISOString(),
    signal,
  }
}
const output = () =>
  inline(refs.authorityAbort.output, {
    state: 'aborted',
    source: { authorityId: 'source', tenantId: 'tenant', authorityEpoch: 2 },
    restoredEpoch: 2,
  })

/** A fixture owner with actual durable identity/receipt rows; not a production transfer driver. */
function ownerFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'integrity-owner-'))
  const path = join(directory, 'owner.sqlite')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE owners(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, output TEXT)')
  const owner: OwnerRef = { kind: 'reconciliation', id: 'persisted-owner' }
  let current = true
  let writes = 0
  const fingerprint = (operation: unknown, call: CallContext) =>
    jcs({
      operation,
      actor: call.principalRef,
      authorization: call.authorizationRef,
      binding: call.bindingId,
      scope: call.scope,
    })
  const port: IntegrityTransferPort = {
    descriptor: { binding, scope, feature: 'authority-transfer.v1', methods: ['authorityAbort'] },
    prepare: async (operation, call) => {
      if (!current || call.principalRef !== 'admin' || call.authorizationRef !== 'grant') return refuse()
      const fp = fingerprint(operation, call)
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('INSERT OR IGNORE INTO owners(id,fingerprint) VALUES(?,?)').run(owner.id, fp)
        const row = db.prepare('SELECT fingerprint FROM owners WHERE id=?').get(owner.id) as {
          fingerprint: string
        }
        if (row.fingerprint !== fp) {
          db.exec('ROLLBACK')
          return refuse()
        }
        db.exec('COMMIT')
        return { ok: true, value: owner }
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    execute: async (operation, ref, call) => {
      if (!current || ref.kind !== owner.kind || ref.id !== owner.id) return refuse()
      const row = db.prepare('SELECT fingerprint,output FROM owners WHERE id=?').get(ref.id) as
        | { fingerprint: string; output: string | null }
        | undefined
      if (!row || row.fingerprint !== fingerprint(operation, call)) return refuse()
      if (row.output) return { ok: true, value: JSON.parse(row.output) as DataRef }
      const value = output()
      db.prepare('UPDATE owners SET output=? WHERE id=?').run(jcs(value), ref.id)
      writes++
      return { ok: true, value }
    },
    reconcile: async (operation, ref, call) => {
      if (
        !current ||
        ref.kind !== owner.kind ||
        call.principalRef !== 'admin' ||
        call.authorizationRef !== 'grant'
      )
        return refuse()
      const row = db.prepare('SELECT fingerprint,output FROM owners WHERE id=?').get(ref.id) as
        | { fingerprint: string; output: string | null }
        | undefined
      if (!row || row.fingerprint !== fingerprint(operation, call) || !row.output) return refuse()
      return { ok: true, value: JSON.parse(row.output) as DataRef }
    },
  }
  return {
    port,
    owner,
    path,
    current: () => current,
    revoke: () => {
      current = false
    },
    writes: () => writes,
    dispose: () => {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

describe('Integrity persisted maintenance owner boundary', () => {
  it.each(['abort', 'revoke', 'throw', 'false', 'invalid-output'] as const)(
    'never reports zero-effect after a real owner commit followed by %s',
    async (mode) => {
      const fixture = ownerFixture()
      const controller = new AbortController()
      const original = fixture.port.execute
      fixture.port.execute = async (operation, owner, call) => {
        const result = await original(operation, owner, call)
        if (mode === 'abort') controller.abort()
        if (mode === 'revoke') fixture.revoke()
        if (mode === 'throw') throw new Error('lost reply after durable effect')
        if (mode === 'false') return refuse()
        if (mode === 'invalid-output')
          return { ok: true, value: inline(refs.authorityAbort.output, { wrong: true }) }
        return result
      }
      try {
        const actualInput = request().input
        expect(
          validateRuntime(
            'AuthorityTransferControlAbortRequest',
            actualInput.kind === 'inline' ? actualInput.value : null,
          ).ok,
        ).toBe(true)
        const formalOutput = output()
        expect(
          validateRuntime(
            'AuthorityTransferProbe',
            formalOutput.kind === 'inline' ? formalOutput.value : null,
          ).ok,
        ).toBe(true)
        const provider = createIntegrityProvider({
          binding,
          scope,
          authorize: async () => (fixture.current() ? { ok: true, value: undefined } : refuse()),
          maintenance: { verifyPackage: async () => refuse(), authorityTransfer: fixture.port },
        })
        if (!provider.maintenance) throw new Error('missing actual maintenance route')
        const result = await provider.maintenance(request(), context(controller.signal))
        const second = new DatabaseSync(fixture.path)
        const stored = second.prepare('SELECT output FROM owners WHERE id=?').get(fixture.owner.id) as {
          output: string
        }
        second.close()
        expect(stored.output).toBe(jcs(output()))
        expect(fixture.writes()).toBe(1)
        if (mode === 'abort' || mode === 'revoke') {
          expect(result.ok).toBe(false)
          if (!result.ok) {
            expect(result.error).toMatchObject({
              code: 'unknown_effect',
              detailCode: 'effect_unknown',
              retryAdvice: { kind: 'reconcile', ownerRef: fixture.owner },
            })
            expect(validateRuntimeErrorDetail(result.error).ok).toBe(true)
          }
        } else {
          expect(result.ok).toBe(true)
          if (result.ok) expect(jcs(result.value)).toBe(stored.output)
        }
      } finally {
        fixture.dispose()
      }
    },
  )
  it('keeps a lost pending result unknown and its owner available instead of guessing no effect', async () => {
    const fixture = ownerFixture()
    fixture.port.execute = async () => refuse()
    try {
      const provider = createIntegrityProvider({
        binding,
        scope,
        authorize: async () => ({ ok: true, value: undefined }),
        maintenance: { verifyPackage: async () => refuse(), authorityTransfer: fixture.port },
      })
      if (!provider.maintenance) throw new Error('missing route')
      const result = await provider.maintenance(request(), context())
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('unknown_effect')
        expect(validateRuntimeErrorDetail(result.error).ok).toBe(true)
      }
      expect(fixture.writes()).toBe(0)
    } finally {
      fixture.dispose()
    }
  })
  it('refuses a foreign binding, undeclared methods, missing reconcile and an invalid prepared owner before dispatch', async () => {
    const fixture = ownerFixture()
    try {
      const options = {
        binding,
        scope,
        authorize: async (): Promise<Outcome<void>> => ({ ok: true, value: undefined }),
        maintenance: { verifyPackage: async () => refuse(), authorityTransfer: fixture.port },
      }
      for (const port of [
        {
          ...fixture.port,
          descriptor: { ...fixture.port.descriptor, binding: { ...binding, providerId: 'foreign' } },
        },
        { ...fixture.port, descriptor: { ...fixture.port.descriptor, methods: ['verifyPackage'] } },
        { ...fixture.port, reconcile: undefined },
      ])
        expect(() =>
          createIntegrityProvider({
            ...options,
            maintenance: { ...options.maintenance, authorityTransfer: port as IntegrityTransferPort },
          }),
        ).toThrow()
      fixture.port.prepare = async () => ({
        ok: true,
        value: { kind: 'action', id: 'not-a-reconciliation-owner' },
      })
      const provider = createIntegrityProvider(options)
      if (!provider.maintenance) throw new Error('missing route')
      expect((await provider.maintenance(request(), context())).ok).toBe(false)
      expect(fixture.writes()).toBe(0)
    } finally {
      fixture.dispose()
    }
  })
  it('reconciles only the actual stored owner with identical operation/caller and current authorization', async () => {
    const fixture = ownerFixture()
    try {
      const call = context()
      const prepared = await fixture.port.prepare(request(), call)
      if (!prepared.ok) throw new Error('prepare failed')
      expect((await fixture.port.execute(request(), prepared.value, call)).ok).toBe(true)
      expect((await fixture.port.reconcile(request(), prepared.value, call)).ok).toBe(true)
      expect(
        (await fixture.port.reconcile(request(), { kind: 'reconciliation', id: 'absent-owner' }, call)).ok,
      ).toBe(false)
      expect(
        (
          await fixture.port.reconcile(
            {
              ...request(),
              input: inline(refs.authorityAbort.input, {
                upgradeId: 'changed',
                expectedFenceId: 'fence',
                recoveryRoute: inline(refs.canonicalize.input, { value: null }),
              }),
            },
            prepared.value,
            call,
          )
        ).ok,
      ).toBe(false)
      expect(
        (await fixture.port.reconcile(request(), prepared.value, { ...call, principalRef: 'foreign' })).ok,
      ).toBe(false)
      fixture.revoke()
      expect((await fixture.port.reconcile(request(), prepared.value, call)).ok).toBe(false)
    } finally {
      fixture.dispose()
    }
  })
})
