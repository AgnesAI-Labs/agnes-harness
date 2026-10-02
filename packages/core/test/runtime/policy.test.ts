import {
  createConformanceHarness,
  registerPolicyContract,
  runPolicyContractScenario,
  SCENARIOS,
} from '@agnes/extension-api/testkit'
import {
  type ApprovalRequest,
  computeApprovalIntentDigest,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { encodePolicyValue } from '../../src/runtime/policy/wire.js'
import { createDefaultPolicyFactory } from '../../src/runtime/providers/policy.js'
import { createPolicyFixture, digest, policyEvidence, policyInput, scope, until } from './policy-fixture.js'

const create = () => createPolicyFixture(createDefaultPolicyFactory)
const provider = async (fixture: ReturnType<typeof create>) =>
  fixture.factory.create(fixture.config, fixture.dependencies, fixture.factoryContext)

describe('default Policy public factory', () => {
  for (const scenario of SCENARIOS)
    it(`public TCK ${scenario}`, async () => {
      await runPolicyContractScenario(scenario, async () => create())
    })
  it('runs the public registrar as a complete six-slot report for this provider', async () => {
    const harness = createConformanceHarness()
    registerPolicyContract(harness, {
      providerId: 'default',
      command: 'policy-focused',
      build: {
        codeSha: 'b'.repeat(40),
        buildDigest: 'a'.repeat(64),
        lockDigest: 'c'.repeat(64),
        specVersion: '1',
        sdkVersion: '1',
        sdkDigest: 'd'.repeat(64),
        platform: 'test',
      },
      releaseSetDigest: 'e'.repeat(64),
      create: async () => create(),
    })
    const report = await harness.run({
      contracts: ['agh.policy'],
      providers: ['default'],
      command: 'policy-focused',
      clock: { startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:00:01Z' },
    })
    expect(report.status).toBe('passed')
    expect(report.assertions).toHaveLength(6)
    expect(
      report.assertions.every(
        (assertion) =>
          assertion.contract === 'agh.policy' &&
          assertion.providerId === 'default' &&
          assertion.status === 'passed',
      ),
    ).toBe(true)
  })
  it('does not accept a valid but unproven caller facts snapshot or copied authorization', async () => {
    const fixture = create()
    const service = await provider(fixture)
    try {
      const changed = policyInput()
      changed.verifiedFacts.configuration.yolo = true
      const encoded = encodePolicyValue(
        'PolicyEvaluateRequest',
        RuntimeMethodSchemaRefs['agh.policy'].evaluate.input,
        changed,
      )
      if (!encoded.ok || !service.compute) throw new Error('fixture')
      expect((await service.compute({ ...fixture.evaluate, input: encoded.value }, fixture.context)).ok).toBe(
        false,
      )
      expect(
        (await service.compute(fixture.evaluate, { ...fixture.context, authorizationRef: 'forged' })).ok,
      ).toBe(false)
      expect(
        (
          await service.compute(fixture.evaluate, {
            ...fixture.context,
            scope: { ...fixture.context.scope, installationId: 'other' },
          })
        ).ok,
      ).toBe(false)
    } finally {
      await service.close('shutdown')
      await fixture.finish()
    }
  })
  it('rejects current facts drift between verified read and decision publication', async () => {
    const fixture = create()
    const original = fixture.authority.verifyEvaluation.bind(fixture.authority)
    fixture.authority.verifyEvaluation = async (...args) => {
      const result = await original(...args)
      fixture.bumpGuard()
      return result
    }
    const service = await provider(fixture)
    try {
      expect((await service.compute?.(fixture.evaluate, fixture.context))?.ok).toBe(false)
    } finally {
      await service.close('shutdown')
      await fixture.finish()
    }
  })
  it('keeps grant mutation atomic and detects conflicting request reuse after reopen', async () => {
    const fixture = create()
    const service = await provider(fixture)
    try {
      fixture.failRevoke = true
      expect((await service.control?.(fixture.revoke, fixture.context))?.ok).toBe(false)
      expect(fixture.decisions()).toBe(0)
      const list = await service.query?.(fixture.list, fixture.context)
      if (!list?.ok || list.value.kind !== 'value' || list.value.output.kind !== 'inline')
        throw new Error('fixture list')
      const parsed = validateRuntime('ApprovalGrantListResult', list.value.output.value)
      expect(parsed.ok && parsed.value.grants[0]?.revokedAt).toBeUndefined()
      fixture.failRevoke = false
      expect((await service.control?.(fixture.revoke, fixture.context))?.ok).toBe(true)
      expect(fixture.decisions()).toBe(1)
      const original = fixture.revoke.input
      if (original.kind !== 'inline') throw new Error('fixture')
      const input = validateRuntime('PermissionClientRevokeGrantRequest', original.value)
      if (!input.ok) throw new Error('fixture')
      const changed = encodePolicyValue(
        'PermissionClientRevokeGrantRequest',
        RuntimeMethodSchemaRefs['agh.policy'].revokeGrant.input,
        { ...input.value, grantId: 'missing' },
      )
      if (!changed.ok) throw new Error('fixture')
      const conflict = await service.control?.({ ...fixture.revoke, input: changed.value }, fixture.context)
      expect(conflict && !conflict.ok && conflict.error.code).toBe('conflict')
      expect(fixture.decisions()).toBe(1)
    } finally {
      await service.close('shutdown')
      await fixture.finish()
    }
  })
  it('validates the exact deployed empty config and freezes its selected descriptor', async () => {
    const fixture = create()
    try {
      expect(Object.isFrozen(fixture.factory.descriptor)).toBe(true)
      if (fixture.config.kind !== 'inline') throw new Error('fixture')
      await expect(
        fixture.factory.create(
          { ...fixture.config, value: { yolo: true } },
          fixture.dependencies,
          fixture.factoryContext,
        ),
      ).rejects.toThrow('configuration')
      await expect(
        fixture.factory.create(
          { ...fixture.config, schema: { ...fixture.config.schema, digest: 'b'.repeat(64) } },
          fixture.dependencies,
          fixture.factoryContext,
        ),
      ).rejects.toThrow('schema mismatch')
    } finally {
      await fixture.finish()
    }
  })
  it('reports active calls during drain and cancels their authority access on close', async () => {
    const fixture = create()
    const service = await provider(fixture)
    let unblock: () => void = () => {}
    const waiting = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const original = fixture.authority.verifyEvaluation.bind(fixture.authority)
    let entered: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    fixture.authority.verifyEvaluation = async (...args) => {
      entered()
      await waiting
      return original(...args)
    }
    const call = service.compute?.(fixture.evaluate, fixture.context)
    await started
    const drained = await service.drain(fixture.context.deadline, fixture.context)
    expect(drained.ok && drained.value.state).toBe('blocked')
    expect(drained.ok && drained.value.activeInvocationIds).toEqual(['invocation'])
    await service.close('shutdown')
    unblock()
    expect((await call)?.ok).toBe(false)
    await fixture.finish()
  })
  it('does not return stale allow after publication changes the current guard', async () => {
    const fixture = create()
    const service = await provider(fixture)
    const original = fixture.authority.publish.bind(fixture.authority)
    fixture.authority.publish = async (...args) => {
      const result = await original(...args)
      fixture.bumpGuard()
      return result
    }
    try {
      expect((await service.compute?.(fixture.evaluate, fixture.context))?.ok).toBe(false)
    } finally {
      await service.close('shutdown')
      await fixture.finish()
    }
  })
  it('retains the committed revoke when output publication fails and allows only explicit same-ID retry', async () => {
    const fixture = create()
    const service = await provider(fixture)
    const original = fixture.authority.publish.bind(fixture.authority)
    fixture.authority.publish = async () => ({
      ok: false,
      error: {
        code: 'retryable',
        detailCode: 'publish_failed',
        message: 'unavailable',
        retryAdvice: { kind: 'never' },
        diagnosticId: 'test',
      },
    })
    try {
      const unknown = await service.control?.(fixture.revoke, fixture.context)
      expect(unknown && !unknown.ok && unknown.error.code).toBe('unknown_effect')
      expect(fixture.decisions()).toBe(1)
      fixture.authority.publish = original
      const repeated = await service.control?.(fixture.revoke, fixture.context)
      expect(repeated?.ok).toBe(true)
      expect(fixture.decisions()).toBe(1)
    } finally {
      await service.close('shutdown')
      await fixture.finish()
    }
  })
  it('does not fabricate an approval question for a mandatory ask with no prepared display', async () => {
    const fixture = create()
    const original = fixture.authority.verifyEvaluation.bind(fixture.authority)
    fixture.authority.verifyEvaluation = async (...args) => {
      const verified = await original(...args)
      if (!verified.ok) return verified
      return {
        ok: true,
        value: {
          ...verified.value,
          policies: [
            {
              id: 'mandatory',
              after: [],
              mandatory: true,
              evaluate: () => ({ decision: 'ask', reasonCodes: ['additional_approval'] }),
            },
          ],
        },
      }
    }
    const service = await provider(fixture)
    try {
      expect((await service.compute?.(fixture.evaluate, fixture.context))?.ok).toBe(false)
    } finally {
      await service.close('shutdown')
      await fixture.finish()
    }
  })
  it('keeps the approved human responder distinct from the action principal', async () => {
    const fixture = create()
    const input = policyInput()
    if (!input.verifiedFacts.toolPolicy) throw new Error('fixture')
    input.verifiedFacts.toolPolicy.requiresApproval = 'always'
    const approval: ApprovalRequest = {
      kind: 'approval',
      title: 'Review',
      body: 'Fixed',
      actionRef: 'action',
      inputDigest: digest,
      policyDecisionRef: 'decision',
      scope,
      allowedResponders: ['human-manager'],
      expiresAt: until,
      idempotencyKey: 'ask',
      risk: 'always',
      intentDigest: digest,
    }
    const intent = computeApprovalIntentDigest(approval)
    if (!intent.ok) throw new Error('fixture')
    approval.intentDigest = intent.value
    const data = encodePolicyValue(
      'InteractionRequest',
      RuntimeMethodSchemaRefs['agh.interaction'].request.input,
      approval,
    )
    if (!data.ok) throw new Error('fixture')
    input.verifiedFacts.approvalRequestRef = data.value
    fixture.replaceInput(input, { ...policyEvidence(), approval })
    const service = await provider(fixture)
    try {
      const result = await service.compute?.(fixture.evaluate, fixture.context)
      if (!result?.ok || result.value.kind !== 'inline') throw new Error('fixture output')
      const parsed = validateRuntime('PolicyDecision', result.value.value)
      expect(parsed.ok && parsed.value.decision).toBe('ask')
      expect(parsed.ok && parsed.value.approvalSpec?.allowedResponders).toEqual(['human-manager'])
    } finally {
      await service.close('shutdown')
      await fixture.finish()
    }
  })
  it('publishes large grant lists through the actual Blob owner and refuses tampered output identity', async () => {
    const fixture = create()
    fixture.seedGrants(400)
    const service = await provider(fixture)
    try {
      const listed = await service.query?.(fixture.list, fixture.context)
      if (!listed?.ok || listed.value.kind !== 'value') throw new Error('fixture')
      expect(listed.value.output.kind).toBe('blob')
      const loaded = await fixture.read(listed.value.output)
      const checked = validateRuntime('ApprovalGrantListResult', loaded)
      expect(checked.ok && checked.value.grants.length).toBe(401)
      const original = fixture.authority.publish.bind(fixture.authority)
      fixture.authority.publish = async (...args) => {
        const result = await original(...args)
        return result.ok
          ? { ok: true, value: { ...result.value, schema: { ...result.value.schema, revision: 99 } } }
          : result
      }
      expect((await service.query?.(fixture.list, fixture.context))?.ok).toBe(false)
      const foreign = { ...listed.value.output }
      if (foreign.kind !== 'blob') throw new Error('fixture')
      foreign.blob = { ...foreign.blob, authorityId: 'foreign' }
      await expect(fixture.read(foreign)).rejects.toThrow('foreign_blob')
    } finally {
      await service.close('shutdown')
      await fixture.finish()
    }
  })
  it('rejects compute masquerading as revoke and corrupted DataRef content', async () => {
    const fixture = create()
    const service = await provider(fixture)
    try {
      expect((await service.compute?.(fixture.revoke, fixture.context))?.ok).toBe(false)
      const input = fixture.evaluate.input
      if (input.kind !== 'inline') throw new Error('fixture')
      expect(
        (
          await service.compute?.(
            { ...fixture.evaluate, input: { ...input, digest: '0'.repeat(64) } },
            fixture.context,
          )
        )?.ok,
      ).toBe(false)
    } finally {
      await service.close('shutdown')
      await fixture.finish()
    }
  })
})
