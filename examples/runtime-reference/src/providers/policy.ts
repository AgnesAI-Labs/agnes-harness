import type {
  AuthorSchema,
  CallContext,
  EmptyAuthorConfig,
  FactoryContext,
  Outcome,
  ProviderFactory,
  RuntimeError,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import type {
  ApprovalGrantBindingInput,
  ApprovalGrantListResult,
  ApprovalGrantRecord,
  ApprovalRequest,
  DataRef,
  OwnerRef,
  PermissionClientRevokeGrantRequest,
  PolicyDecision,
  PolicyEvaluateRequest,
  ProviderDescriptor,
  RuntimeWireTypes,
  SchemaRef,
  ServiceOperation,
  ServiceQuery,
  TaintSnapshot,
  Timestamp,
} from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  MAX_AUTHOR_INLINE_BYTES,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  validateApprovalIntent,
  validateRuntime,
} from '@agnes/protocol/runtime'

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
export function createReferencePolicyFactory(
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

export interface VerifiedPolicyEvaluation {
  readonly input: PolicyEvaluateRequest
  readonly evidence: PreparedPolicyEvidence
  readonly factsRef: DataRef
  readonly conditions: DataRef
  readonly validUntil: Timestamp
  /** Opaque owner token; it must be checked against current State and permissions after composition. */
  readonly readGuard: object
  readonly policies: readonly PolicyContributor[]
}
export interface VerifiedGrantAccess {
  readonly actorId: string
  readonly actorOrg: string
  readonly profileHash: string
  readonly snapshotId: string
  readonly readGuard: object
}

/** Host-private adapter. Neither serialized facts nor authors can install or issue this authority. */
export interface PolicyAuthority {
  now(): Timestamp
  open(config: DataRef, context: FactoryContext): Promise<Outcome<void>>
  readConfig(reference: DataRef, context: FactoryContext): Promise<Outcome<unknown>>
  read(reference: DataRef, context: CallContext): Promise<Outcome<unknown>>
  verifyEvaluation(
    input: PolicyEvaluateRequest,
    context: CallContext,
  ): Promise<Outcome<VerifiedPolicyEvaluation>>
  checkCurrent(readGuard: object, context: CallContext): Promise<Outcome<void>>
  authorizeGrants(
    method: 'listGrants' | 'revokeGrant',
    input: ApprovalGrantBindingInput,
    context: CallContext,
  ): Promise<Outcome<VerifiedGrantAccess>>
  listGrants(
    access: VerifiedGrantAccess,
    input: ApprovalGrantBindingInput,
    context: CallContext,
  ): Promise<Outcome<ApprovalGrantListResult>>
  /** Returns a real durable request owner bound to this subject, request identity and fingerprint, before effects. */
  revokeOwner(
    access: VerifiedGrantAccess,
    input: PermissionClientRevokeGrantRequest,
    context: CallContext,
  ): Promise<Outcome<OwnerRef>>
  /** Owner performs current-auth + request identity/fingerprint CAS + revoke atomically. No activation API. */
  revokeGrant(
    access: VerifiedGrantAccess,
    input: PermissionClientRevokeGrantRequest,
    context: CallContext,
  ): Promise<Outcome<ApprovalGrantRecord>>
  publish(
    schema: SchemaRef,
    value: import('@agnes/protocol/runtime').JsonValue,
    context: CallContext,
  ): Promise<Outcome<DataRef>>
  close(): Promise<void>
}

export type PolicyVerdict = 'allow' | 'ask' | 'deny'
export interface PreparedPolicyEvidence {
  readonly toolName: string
  readonly trustedManagementTool: boolean
  readonly hookDenied: boolean
  readonly priorDecisions: Readonly<Record<string, PolicyVerdict>>
  readonly rules: Readonly<Record<string, PolicyVerdict>>
  readonly argvNormalized: boolean
  readonly approval: ApprovalRequest | null
  readonly guardianVerified: boolean
  readonly guardianScopes: readonly string[]
}
export interface ComposedPolicyDecision {
  readonly decision: PolicyVerdict
  readonly reasonCodes: readonly string[]
}

// Independent expression of the default policy, rather than calling Core's implementation.
function defaultPolicyDecision(
  request: PolicyEvaluateRequest,
  evidence: PreparedPolicyEvidence,
): ComposedPolicyDecision {
  const facts = request.verifiedFacts
  const policy = facts.toolPolicy
  const scopes = Array.from(
    new Set(policy?.approvalScopes.length ? policy.approvalScopes : [`tool:${evidence.toolName}:execute`]),
  )
  const result = (decision: PolicyVerdict, reason: string): ComposedPolicyDecision => ({
    decision,
    reasonCodes: [reason],
  })
  const strongDeny =
    evidence.hookDenied ||
    facts.authorization.decision === 'deny' ||
    scopes.some((s) => evidence.priorDecisions[s] === 'deny')
  if (strongDeny) return result('deny', 'strong_denied')
  const riskAsks =
    policy !== null &&
    !evidence.trustedManagementTool &&
    (policy?.requiresApproval === 'always' ||
      (policy?.requiresApproval === 'destructive' && policy.isDestructive) ||
      (facts.taint.tainted && policy?.isReadOnly !== true))
  const asks =
    !facts.configuration.yolo &&
    facts.configuration.mode !== 'off' &&
    (riskAsks || facts.authorization.decision === 'require-approval')
  if (!asks) return result('allow', 'mode_or_risk_allowed')
  let missing = scopes.filter((scope) => {
    if (evidence.priorDecisions[scope] === 'allow') return false
    if (evidence.priorDecisions[scope] === 'ask') return true
    return !facts.grants.some((g) => {
      if (
        g.consumed ||
        g.actorRef !== request.principalRef ||
        g.toolName !== evidence.toolName ||
        !g.scopes.includes(scope) ||
        g.policyVersion !== policy?.policyVersion
      )
        return false
      if (
        !('sessionId' in request.scope) ||
        (g.kind !== 'permanent' && g.sessionId !== request.scope.sessionId)
      )
        return false
      if (g.validUntil !== null && Date.parse(g.validUntil) <= Date.parse(facts.evaluatedAt)) return false
      if (g.kind === 'once') return g.inputDigest === request.inputDigest
      return g.kind !== 'permanent' || g.profileDigest === facts.configuration.profileDigest
    })
  })
  if (!missing.length) return result('allow', 'grant_or_prior_allowed')
  if (!evidence.approval || !facts.approvalRequestRef) return result('deny', 'approval_not_prepared')
  if (facts.configuration.mode === 'smart') {
    if (facts.guardian.state === 'pending') return result('ask', 'guardian_pending')
    if (facts.guardian.state === 'decided') {
      if (
        !evidence.guardianVerified ||
        evidence.guardianScopes.length === 0 ||
        facts.guardian.decision === null ||
        !facts.guardian.actionId ||
        !facts.guardian.resultRef
      )
        return result('deny', 'guardian_evidence_invalid')
      if (
        facts.guardian.decision === 'deny' &&
        missing.some((scope) => evidence.guardianScopes.includes(scope))
      )
        return result('deny', 'guardian_denied')
      if (facts.guardian.decision === 'allow') {
        missing = missing.filter((scope) => !evidence.guardianScopes.includes(scope))
        if (!missing.length) return result('allow', 'guardian_allowed')
      }
    }
  }
  const rules = missing.map((scope) => (evidence.argvNormalized ? evidence.rules[scope] : undefined))
  if (rules.includes('deny')) return result('deny', 'rule_denied')
  const resolved = missing.every(
    (scope, i) =>
      rules[i] === 'allow' &&
      policy?.requiresApproval !== 'always' &&
      (!facts.taint.tainted || scope.includes('/')),
  )
  return result(resolved ? 'allow' : 'ask', resolved ? 'rule_allowed' : 'human_required')
}
export interface PolicyContributor {
  readonly id: string
  readonly after: readonly string[]
  readonly mandatory: boolean
  evaluate(request: PolicyEvaluateRequest): ComposedPolicyDecision
}

/** Validate the complete graph before calling any contributor. Deny dominates ask, which dominates allow. */
export function composePolicies(
  request: PolicyEvaluateRequest,
  policies: readonly PolicyContributor[],
): ComposedPolicyDecision {
  const pending = new Map(policies.map((policy) => [policy.id, policy]))
  if (
    pending.size !== policies.length ||
    policies.some((policy) => !policy.id || policy.after.some((id) => !pending.has(id)))
  )
    return { decision: 'deny', reasonCodes: ['policy_graph_invalid'] }
  const sorted: PolicyContributor[] = []
  const done = new Set<string>()
  while (pending.size > 0) {
    const ready = [...pending.values()]
      .filter((policy) => policy.after.every((id) => done.has(id)))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (ready.length === 0) return { decision: 'deny', reasonCodes: ['policy_graph_cycle'] }
    for (const policy of ready) {
      sorted.push(policy)
      pending.delete(policy.id)
      done.add(policy.id)
    }
  }
  let decision: PolicyVerdict = 'allow'
  const reasonCodes: string[] = []
  for (const policy of sorted) {
    let result: ComposedPolicyDecision
    try {
      result = policy.evaluate(request)
      if (!['allow', 'ask', 'deny'].includes(result.decision)) throw new Error('invalid verdict')
    } catch {
      if (!policy.mandatory) continue
      result = { decision: 'deny', reasonCodes: ['mandatory_policy_unavailable'] }
    }
    if (result.decision === 'deny' || (result.decision === 'ask' && decision === 'allow'))
      decision = result.decision
    reasonCodes.push(...result.reasonCodes)
  }
  return { decision, reasonCodes }
}
/** Fold the captured boundary against the current acknowledgement before deciding contamination. */
export function effectiveTaint(current: TaintSnapshot, captured: TaintSnapshot): boolean {
  for (const snapshot of [current, captured]) {
    if (
      snapshot.clearedThroughSeq > snapshot.sourceSeq ||
      ![snapshot.recordRevision, snapshot.sourceSeq, snapshot.clearedThroughSeq].every(
        (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0),
      ) ||
      snapshot.recordRevision < 1
    )
      throw new Error('invalid taint boundary')
  }
  if (
    captured.sourceSeq > current.sourceSeq ||
    captured.recordRevision > current.recordRevision ||
    captured.clearedThroughSeq > current.clearedThroughSeq
  )
    throw new Error('captured taint boundary is ahead of current state')
  return Math.max(current.sourceSeq, captured.sourceSeq) > current.clearedThroughSeq
}

/** Structural binding checks complement, and never replace, the trusted current-facts authority. */
export function policyFactsMatch(request: PolicyEvaluateRequest, context: CallContext): boolean {
  const facts = request.verifiedFacts
  if (
    request.principalRef !== context.principalRef ||
    canonicalJsonDigest(request.scope) !== canonicalJsonDigest(context.scope) ||
    request.principalRef !== facts.actor.principalRef ||
    request.inputDigest !== facts.inputDigest ||
    request.policyRevision !== facts.authorization.policyRevision ||
    !('runId' in request.scope) ||
    request.scope.runId !== facts.taint.runId ||
    ('actionId' in request.scope && request.scope.actionId !== facts.actionId) ||
    (facts.toolPolicy !== null && facts.toolPolicy.inputDigest !== request.inputDigest)
  )
    return false
  try {
    return facts.taint.tainted === effectiveTaint(facts.taint.current, facts.taint.captured)
  } catch {
    return false
  }
}
export function policyFailure(code: RuntimeError['code'], detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Policy operation refused',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'policy-provider',
    },
  }
}
/** This owner comes from the durable request authority; the provider does not synthesize an id. */
export function policyUnknown(ownerRef: OwnerRef): Outcome<never> {
  return {
    ok: false,
    error: {
      code: 'unknown_effect',
      detailCode: 'unknown_result',
      message: 'Policy operation result requires reconciliation',
      retryAdvice: { kind: 'reconcile', ownerRef },
      diagnosticId: 'policy-provider',
    },
  }
}
export function sameSchema(a: SchemaRef, b: SchemaRef): boolean {
  return a.typeId === b.typeId && a.revision === b.revision && a.digest === b.digest
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
}
export function parsePolicyValue<K extends keyof RuntimeWireTypes>(
  name: K,
  value: unknown,
): Outcome<RuntimeWireTypes[K]> {
  const budget = RuntimeAuthorCodecPolicy.payload
  const safe = boundedCanonicalJson(value, {
    maxBytes: budget.maxCanonicalJsonBytes,
    maxDepth: budget.maxDepth,
    maxMembers: budget.maxMembers,
  })
  if (!safe.ok) return policyFailure('invalid_input', 'policy_value_invalid')
  const result = validateRuntime(name, safe.value.json)
  if (!result.ok) return policyFailure('invalid_input', 'policy_schema_invalid')
  freeze(result.value)
  return { ok: true, value: result.value }
}
export function encodePolicyValue<K extends keyof RuntimeWireTypes>(
  name: K,
  schema: SchemaRef,
  value: RuntimeWireTypes[K],
): Outcome<DataRef> {
  const checked = parsePolicyValue(name, value)
  if (!checked.ok) return checked
  const budget = RuntimeAuthorCodecPolicy.payload
  const encoded = boundedCanonicalJson(checked.value, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES,
    maxDepth: budget.maxDepth,
    maxMembers: budget.maxMembers,
  })
  if (!encoded.ok) return policyFailure('quota', 'inline_data_bytes')
  return {
    ok: true,
    value: {
      kind: 'inline',
      schema,
      value: encoded.value.json,
      bytes: encoded.value.bytes,
      digest: canonicalJsonDigest(encoded.value.json),
    },
  }
}
export async function publishPolicyValue<K extends keyof RuntimeWireTypes>(
  name: K,
  schema: SchemaRef,
  value: RuntimeWireTypes[K],
  context: CallContext,
  publisher: {
    publish(
      schema: SchemaRef,
      value: import('@agnes/protocol/runtime').JsonValue,
      context: CallContext,
    ): Promise<Outcome<DataRef>>
  },
): Promise<Outcome<DataRef>> {
  const parsed = parsePolicyValue(name, value)
  if (!parsed.ok) return parsed
  const limits = RuntimeAuthorCodecPolicy.payload
  const canonical = boundedCanonicalJson(parsed.value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
  if (!canonical.ok) return policyFailure('quota', 'policy_output_budget')
  const published = await publisher.publish(schema, canonical.value.json, context)
  if (!published.ok) return published
  const reference = parsePolicyValue('DataRef', published.value)
  if (!reference.ok) return policyFailure('internal', 'policy_output_reference_invalid')
  const data = reference.value
  const proof = data.kind === 'inline' ? data : data.blob
  if (
    !sameSchema(data.schema, schema) ||
    proof.digest !== canonicalJsonDigest(canonical.value.json) ||
    proof.bytes !== canonical.value.bytes
  )
    return policyFailure('internal', 'policy_output_reference_mismatch')
  if (
    data.kind === 'inline' &&
    (canonicalJsonDigest(data.value) !== proof.digest || !parsePolicyValue(name, data.value).ok)
  )
    return policyFailure('internal', 'policy_output_content_invalid')
  return { ok: true, value: data }
}
