import type {
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  FactoryContext,
  Outcome,
  ProviderFactory,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import type {
  ApprovalGrantBindingInput,
  ApprovalGrantRecord,
  DataRef,
  OwnerRef,
  PolicyDecision,
  PolicyEvaluateRequest,
  ProviderDescriptor,
  ServiceOperation,
  ServiceQuery,
} from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  validateApprovalIntent,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { PolicyAuthority, VerifiedGrantAccess } from '../policy/authority.js'
import { policyFactsMatch } from '../policy/current-facts.js'
import { composePolicies, defaultPolicyDecision } from '../policy/decision-composition.js'
import {
  parsePolicyValue,
  policyFailure,
  policyUnknown,
  publishPolicyValue,
  sameSchema,
} from '../policy/wire.js'

const schemas = RuntimeMethodSchemaRefs['agh.policy']
const methods = ['evaluate', 'listGrants', 'revokeGrant'] as const

function descriptorValid(descriptor: ProviderDescriptor): boolean {
  return (
    validateRuntime('ProviderDescriptor', descriptor).ok &&
    descriptor.contract === 'agh.policy' &&
    descriptor.major === 1 &&
    descriptor.operations.length === 3 &&
    methods.every((method) => {
      const operation = descriptor.operations.find((entry) => entry.method === method)
      return (
        operation !== undefined &&
        operation.kind ===
          ({ evaluate: 'compute', listGrants: 'query', revokeGrant: 'control' } as const)[method] &&
        sameSchema(operation.inputSchema, schemas[method].input) &&
        sameSchema(operation.outputSchema, schemas[method].output)
      )
    })
  )
}
function bound(
  request: ServiceOperation | ServiceQuery,
  context: CallContext,
  factory: FactoryContext,
  descriptor: ProviderDescriptor,
): boolean {
  return (
    request.target.contract === 'agh.policy' &&
    request.target.providerId === descriptor.providerId &&
    request.target.logicalName === descriptor.logicalName &&
    request.target.bindingId === factory.bindingId &&
    context.bindingId === factory.bindingId &&
    Object.entries(factory.scope).every(
      ([key, value]) => key === 'kind' || context.scope[key as keyof typeof context.scope] === value,
    )
  )
}
function grantMatches(
  grant: ApprovalGrantRecord,
  input: ApprovalGrantBindingInput,
  access: VerifiedGrantAccess,
): boolean {
  return (
    grant.actorId === access.actorId &&
    grant.actorOrg === access.actorOrg &&
    grant.profileHash === access.profileHash &&
    grant.toolId === input.toolId &&
    grant.scope === input.scope &&
    grant.policyVersion === input.policyVersion
  )
}

/** Complete Policy surface with a trusted, deployment-owned authority supplied by Host assembly. */
export function createDefaultPolicyFactory(
  descriptor: ProviderDescriptor,
  authority: PolicyAuthority,
  configCodec: AuthorSchema<EmptyAuthorConfig>,
): ProviderFactory<ServiceProvider> {
  if (!sameSchema(descriptor.configSchema, configCodec.ref))
    throw new TypeError('Policy requires the deployed empty configuration codec')
  if (!descriptorValid(descriptor))
    throw new TypeError('Policy descriptor must declare the complete official contract')
  // Configuration JSON never receives the authority adapter or contributor closures.
  const frozenDescriptor = parsePolicyValue('ProviderDescriptor', descriptor)
  if (!frozenDescriptor.ok) throw new TypeError('Invalid Policy descriptor')
  const fixedDescriptor = frozenDescriptor.value
  return {
    descriptor: fixedDescriptor,
    async create(config, _dependencies, factory) {
      if (!sameSchema(config.schema, fixedDescriptor.configSchema))
        throw new TypeError('Policy configuration schema mismatch')
      const configRead = await authority.readConfig(config, factory)
      if (!configRead.ok) throw new Error(configRead.error.detailCode)
      const configParsed = configCodec.parse(configRead.value)
      if (!configParsed.ok || !validateRuntime('RuntimeEmptyAuthorConfig', configParsed.value).ok)
        throw new TypeError('Invalid Policy configuration')
      const configEncoded = configCodec.encode(configParsed.value)
      if (
        !configEncoded.ok ||
        configEncoded.value.kind !== 'inline' ||
        (config.kind === 'inline'
          ? config.digest !== configEncoded.value.digest || config.bytes !== configEncoded.value.bytes
          : config.blob.digest !== configEncoded.value.digest ||
            config.blob.bytes !== configEncoded.value.bytes)
      )
        throw new TypeError('Policy configuration proof mismatch')
      const opened = await authority.open(config, factory)
      if (!opened.ok) throw new Error(opened.error.detailCode)
      let state: 'ready' | 'draining' | 'closed' = 'ready'
      const active = new Map<symbol, string>()
      const lifetime = new AbortController()
      const preflight = (context: CallContext): Outcome<void> => {
        if (state !== 'ready') return policyFailure('retryable', 'policy_provider_closed')
        if (context.signal.aborted || factory.signal.aborted)
          return policyFailure('cancelled', 'policy_cancelled')
        const deadline = Date.parse(context.deadline)
        const time = Date.parse(authority.now())
        if (!Number.isFinite(deadline) || !Number.isFinite(time))
          return policyFailure('invalid_input', 'policy_clock_invalid')
        if (deadline <= time) return policyFailure('timeout', 'policy_deadline')
        return { ok: true, value: undefined }
      }
      async function decode<
        K extends
          | 'PolicyEvaluateRequest'
          | 'ApprovalGrantBindingInput'
          | 'PermissionClientRevokeGrantRequest',
      >(
        request: ServiceOperation | ServiceQuery,
        context: CallContext,
        method: (typeof methods)[number],
        name: K,
      ) {
        const checked = preflight(context)
        if (!checked.ok) return checked
        if (request.method !== method || !bound(request, context, factory, fixedDescriptor))
          return policyFailure('denied', 'policy_binding_mismatch')
        if (!sameSchema(request.input.schema, schemas[method].input))
          return policyFailure('invalid_input', 'policy_input_schema')
        const loaded = await authority.read(request.input, context)
        if (!loaded.ok) return loaded
        const parsed = parsePolicyValue(name, loaded.value)
        if (!parsed.ok) return parsed
        const budget = RuntimeAuthorCodecPolicy.payload
        const content = boundedCanonicalJson(parsed.value, {
          maxBytes: budget.maxCanonicalJsonBytes,
          maxDepth: budget.maxDepth,
          maxMembers: budget.maxMembers,
        })
        const proof = request.input.kind === 'inline' ? request.input : request.input.blob
        if (
          !content.ok ||
          content.value.bytes !== proof.bytes ||
          canonicalJsonDigest(content.value.json) !== proof.digest
        )
          return policyFailure('invalid_input', 'policy_input_digest')
        return parsed
      }
      return {
        async ready(context) {
          return preflight(context)
        },
        async health() {
          return { ok: true, value: { status: state === 'ready' ? 'ready' : 'failed', diagnosticIds: [] } }
        },
        async drain() {
          if (state !== 'closed') state = 'draining'
          return {
            ok: true,
            value: {
              state: active.size ? 'blocked' : 'drained',
              activeInvocationIds: [...active.values()],
              durableOwnerRefs: [],
              diagnosticIds: [],
            },
          }
        },
        async close() {
          if (state !== 'closed') {
            state = 'closed'
            lifetime.abort()
            await authority.close()
          }
        },
        async compute(request, context): Promise<Outcome<DataRef>> {
          const token = Symbol()
          active.set(token, context.invocationId)
          context = { ...context, signal: AbortSignal.any([context.signal, factory.signal, lifetime.signal]) }
          try {
            const decoded = await decode(request, context, 'evaluate', 'PolicyEvaluateRequest')
            if (!decoded.ok) return decoded
            if (!policyFactsMatch(decoded.value, context))
              return policyFailure('denied', 'policy_facts_binding')
            const verified = await authority.verifyEvaluation(decoded.value, context)
            if (!verified.ok) return verified
            const lockedInput = parsePolicyValue('PolicyEvaluateRequest', verified.value.input)
            if (!lockedInput.ok) return policyFailure('denied', 'policy_facts_invalid')
            const originalEvidence = verified.value.evidence
            const lockedApproval =
              originalEvidence.approval === null
                ? null
                : parsePolicyValue('ApprovalRequest', originalEvidence.approval)
            if (lockedApproval !== null && !lockedApproval.ok)
              return policyFailure('denied', 'policy_approval_invalid')
            const admission = {
              ...verified.value,
              input: lockedInput.value,
              evidence: {
                ...originalEvidence,
                priorDecisions: { ...originalEvidence.priorDecisions },
                rules: { ...originalEvidence.rules },
                guardianScopes: [...originalEvidence.guardianScopes],
                approval: lockedApproval === null ? null : lockedApproval.value,
              },
              policies: [...verified.value.policies],
            }
            if (
              canonicalJsonDigest(admission.input) !== canonicalJsonDigest(decoded.value) ||
              !policyFactsMatch(admission.input, context) ||
              Date.parse(admission.validUntil) <= Date.parse(authority.now())
            )
              return policyFailure('denied', 'policy_facts_stale')
            const defaults = defaultPolicyDecision(admission.input, admission.evidence)
            const composed = composePolicies(admission.input, admission.policies)
            const decision =
              defaults.decision === 'deny' || composed.decision === 'deny'
                ? 'deny'
                : defaults.decision === 'ask' || composed.decision === 'ask'
                  ? 'ask'
                  : 'allow'
            const defaultUsesDisplay = ![
              'mode_or_risk_allowed',
              'grant_or_prior_allowed',
              'hook_denied',
              'authorization_denied',
              'prior_denied',
            ].includes(defaults.reasonCodes[0] ?? '')
            const approval = admission.evidence.approval
            if (
              (decision === 'ask' || defaultUsesDisplay) &&
              (approval === null ||
                !validateApprovalIntent(approval).ok ||
                approval.actionRef !== admission.input.verifiedFacts.actionId ||
                approval.inputDigest !== admission.input.inputDigest ||
                canonicalJsonDigest(approval.scope) !== canonicalJsonDigest(admission.input.scope) ||
                Date.parse(approval.expiresAt) <= Date.parse(authority.now()))
            )
              return policyFailure('denied', 'policy_approval_binding')
            const current = await authority.checkCurrent(admission.readGuard, context)
            if (!current.ok) return current
            const live = preflight(context)
            if (!live.ok) return live
            const input: PolicyEvaluateRequest = admission.input
            const output: PolicyDecision = {
              decisionId: `policy-${canonicalJsonDigest({ factsId: input.verifiedFacts.factsId, inputDigest: input.inputDigest, scope: input.scope, policyRevision: input.policyRevision, decision })}`,
              decision,
              principalRef: input.principalRef,
              scope: input.scope,
              inputDigest: input.inputDigest,
              policyRevision: input.policyRevision,
              factsRef: admission.factsRef,
              conditions: admission.conditions,
              reasonCodes: [...defaults.reasonCodes, ...composed.reasonCodes],
              approvalSpec: decision === 'ask' ? admission.evidence.approval : null,
              validUntil: [
                admission.validUntil,
                context.deadline,
                ...(decision === 'ask' && approval ? [approval.expiresAt] : []),
              ].sort((a, b) => Date.parse(a) - Date.parse(b))[0] as string,
            }
            const emitted = await publishPolicyValue(
              'PolicyDecision',
              schemas.evaluate.output,
              output,
              context,
              authority,
            )
            if (!emitted.ok) return emitted
            const stillCurrent = await authority.checkCurrent(admission.readGuard, context)
            if (!stillCurrent.ok) return stillCurrent
            const stillLive = preflight(context)
            return stillLive.ok ? emitted : stillLive
          } catch {
            return policyFailure('retryable', 'policy_authority_unavailable')
          } finally {
            active.delete(token)
          }
        },
        async query(request, context) {
          const token = Symbol()
          active.set(token, context.invocationId)
          context = { ...context, signal: AbortSignal.any([context.signal, factory.signal, lifetime.signal]) }
          try {
            const decoded = await decode(request, context, 'listGrants', 'ApprovalGrantBindingInput')
            if (!decoded.ok) return decoded
            if (!('sessionId' in context.scope) || decoded.value.sessionId !== context.scope.sessionId)
              return policyFailure('denied', 'policy_grant_scope')
            const authorized = await authority.authorizeGrants('listGrants', decoded.value, context)
            if (!authorized.ok) return authorized
            const listed = await authority.listGrants(authorized.value, decoded.value, context)
            if (!listed.ok) return listed
            if (!listed.value.grants.every((grant) => grantMatches(grant, decoded.value, authorized.value)))
              return policyFailure('denied', 'policy_grant_binding')
            const current = await authority.checkCurrent(authorized.value.readGuard, context)
            if (!current.ok) return current
            const live = preflight(context)
            if (!live.ok) return live
            const encoded = await publishPolicyValue(
              'ApprovalGrantListResult',
              schemas.listGrants.output,
              listed.value,
              context,
              authority,
            )
            if (!encoded.ok) return encoded
            const stillCurrent = await authority.checkCurrent(authorized.value.readGuard, context)
            if (!stillCurrent.ok) return stillCurrent
            const stillLive = preflight(context)
            if (!stillLive.ok) return stillLive
            return encoded.ok
              ? {
                  ok: true,
                  value: { kind: 'value', output: encoded.value, snapshot: authorized.value.snapshotId },
                }
              : encoded
          } catch {
            return policyFailure('retryable', 'policy_authority_unavailable')
          } finally {
            active.delete(token)
          }
        },
        async control(request, context) {
          let mutationStarted = false
          let recoveryOwner: OwnerRef | undefined
          const token = Symbol()
          active.set(token, context.invocationId)
          context = { ...context, signal: AbortSignal.any([context.signal, factory.signal, lifetime.signal]) }
          try {
            const decoded = await decode(
              request,
              context,
              'revokeGrant',
              'PermissionClientRevokeGrantRequest',
            )
            if (!decoded.ok) return decoded
            if (!('sessionId' in context.scope) || decoded.value.sessionId !== context.scope.sessionId)
              return policyFailure('denied', 'policy_grant_scope')
            const authorized = await authority.authorizeGrants('revokeGrant', decoded.value, context)
            if (!authorized.ok) return authorized
            const live = preflight(context)
            if (!live.ok) return live
            const reserved = await authority.revokeOwner(authorized.value, decoded.value, context)
            if (!reserved.ok) return reserved
            const owner = parsePolicyValue('OwnerRef', reserved.value)
            if (!owner.ok || owner.value.kind !== 'reconciliation')
              return policyFailure('internal', 'policy_recovery_owner_invalid')
            recoveryOwner = owner.value
            const stillLive = preflight(context)
            if (!stillLive.ok) return stillLive
            // The owner checks current auth and commits idempotency + revoke together. No check-then-write split here.
            mutationStarted = true
            const revoked = await authority.revokeGrant(authorized.value, decoded.value, context)
            if (!revoked.ok) return revoked
            if (
              revoked.value.grantId !== decoded.value.grantId ||
              revoked.value.revokedAt === undefined ||
              !grantMatches(revoked.value, decoded.value, authorized.value)
            )
              return policyUnknown(recoveryOwner)
            const emitted = await publishPolicyValue(
              'ApprovalGrantRecord',
              schemas.revokeGrant.output,
              revoked.value,
              context,
              authority,
            )
            return emitted.ok ? emitted : policyUnknown(recoveryOwner)
          } catch {
            return mutationStarted && recoveryOwner
              ? policyUnknown(recoveryOwner)
              : policyFailure('retryable', 'policy_authority_unavailable')
          } finally {
            active.delete(token)
          }
        },
      }
    },
  }
}
