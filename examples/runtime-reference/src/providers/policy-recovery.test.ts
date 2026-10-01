import { validateRuntime, validateRuntimeErrorDetail } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { createDefaultPolicyFactory } from '../../../../packages/core/src/runtime/providers/policy.js'
import { createPolicyFixture } from '../../../../packages/core/test/runtime/policy-fixture.js'
import { createReferencePolicyFactory } from './policy.js'

describe.each([
  ['default', createDefaultPolicyFactory],
  ['reference', createReferencePolicyFactory],
] as const)('%s durable Policy reconciliation', (_name, factory) => {
  it.each(['failed', 'throw'] as const)(
    'proves and recovers the committed result after publication %s',
    async (mode) => {
      const f = createPolicyFixture(factory)
      const service = await f.factory.create(f.config, f.dependencies, f.factoryContext)
      const publish = f.authority.publish.bind(f.authority)
      f.authority.publish = async () => {
        if (mode === 'throw') throw new Error('lost publication')
        return {
          ok: false,
          error: {
            code: 'retryable',
            detailCode: 'publication_failed',
            message: 'unavailable',
            retryAdvice: { kind: 'never' },
            diagnosticId: 'test',
          },
        }
      }
      try {
        const unknown = await service.control?.(f.revoke, f.context)
        if (!unknown || unknown.ok || unknown.error.retryAdvice.kind !== 'reconcile')
          throw new Error('missing reconciliation')
        expect(validateRuntimeErrorDetail(unknown.error).ok).toBe(true)
        expect(validateRuntimeErrorDetail({ ...unknown.error, retryAdvice: { kind: 'never' } }).ok).toBe(
          false,
        )
        expect(validateRuntimeErrorDetail({ ...unknown.error, retryAdvice: { kind: 'reconcile' } }).ok).toBe(
          false,
        )
        const owner = unknown.error.retryAdvice.ownerRef
        if (f.revoke.input.kind !== 'inline') throw new Error('missing fixture request')
        const request = f.revoke.input
          .value as import('@agnes/protocol/runtime').PermissionClientRevokeGrantRequest
        const recovered = f.recovery(owner, request)
        expect(recovered.ok && recovered.value.revokedAt).toBeTruthy()
        expect(f.recovery({ ...owner, id: 'fabricated-owner' }, request).ok).toBe(false)
        expect(f.recovery(owner, { ...request, grantId: 'different-grant' }).ok).toBe(false)
        expect(f.decisions()).toBe(1)
        await service.close('upgrade')
        await f.recover()
        expect(f.recovery(owner, request)).toEqual(recovered)
        f.authority.publish = publish
        const reopened = await f.factory.create(f.config, f.dependencies, f.factoryContext)
        expect((await reopened.control?.(f.revoke, f.context))?.ok).toBe(true)
        expect(f.decisions()).toBe(1)
        await f.deny()
        expect(f.recovery(owner, request).ok).toBe(false)
        expect((await reopened.control?.(f.revoke, f.context))?.ok).toBe(false)
        await reopened.close('shutdown')
      } finally {
        await service.close('shutdown')
        await f.finish()
      }
    },
  )
  it('does not invent a result after the durable owner record is deleted', async () => {
    const f = createPolicyFixture(factory)
    const service = await f.factory.create(f.config, f.dependencies, f.factoryContext)
    const publish = f.authority.publish.bind(f.authority)
    f.authority.publish = async () => {
      throw new Error('lost publication')
    }
    try {
      const unknown = await service.control?.(f.revoke, f.context)
      if (
        !unknown ||
        unknown.ok ||
        unknown.error.retryAdvice.kind !== 'reconcile' ||
        f.revoke.input.kind !== 'inline'
      )
        throw new Error('missing owner')
      const owner = unknown.error.retryAdvice.ownerRef
      const request = f.revoke.input
        .value as import('@agnes/protocol/runtime').PermissionClientRevokeGrantRequest
      expect(f.recovery(owner, request).ok).toBe(true)
      f.dropRecovery(owner)
      expect(f.recovery(owner, request).ok).toBe(false)
      f.authority.publish = publish
      const listed = await service.query?.(f.list, f.context)
      if (!listed?.ok || listed.value.kind !== 'value') throw new Error('missing persisted grant list')
      const grants = validateRuntime('ApprovalGrantListResult', await f.read(listed.value.output))
      expect(
        grants.ok && grants.value.grants.find((grant) => grant.grantId === request.grantId)?.revokedAt,
      ).toBeTruthy()
    } finally {
      await service.close('shutdown')
      await f.finish()
    }
  })
  it('refuses an unavailable or structurally invalid recovery owner before the revoke effect', async () => {
    const f = createPolicyFixture(factory)
    const service = await f.factory.create(f.config, f.dependencies, f.factoryContext)
    f.authority.revokeOwner = async () => ({
      ok: false,
      error: {
        code: 'denied',
        detailCode: 'owner_unavailable',
        message: 'unavailable',
        retryAdvice: { kind: 'never' },
        diagnosticId: 'test',
      },
    })
    try {
      expect((await service.control?.(f.revoke, f.context))?.ok).toBe(false)
      expect(f.decisions()).toBe(0)
      f.authority.revokeOwner = async () => ({
        ok: true,
        value: { kind: 'action', id: 'not-a-request-owner' },
      })
      expect((await service.control?.(f.revoke, f.context))?.ok).toBe(false)
      expect(f.decisions()).toBe(0)
    } finally {
      await service.close('shutdown')
      await f.finish()
    }
  })
})
