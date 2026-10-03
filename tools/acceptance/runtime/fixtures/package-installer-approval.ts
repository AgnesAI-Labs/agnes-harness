import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createReferenceDeploymentApprovalAdapter } from '../../../../examples/runtime-reference/src/providers/deployment-approval.js'
import type { Outcome } from '../../../../packages/extension-api/src/runtime/index.js'
import {
  createDeploymentApprovalAdapter,
  type DeploymentApprovalAdapterPorts,
  type DeploymentApprovalBinding,
  type DeploymentApprovalRequest,
  type DeploymentApprovalTerminal,
} from '../../../../packages/package-manager/src/runtime/deployment-approval.js'
import { inlineInstallerRef } from '../../../../packages/package-manager/test/runtime/fixtures/installer.js'
import { jcs } from '../../../../packages/protocol/src/jcs.js'
import {
  canonicalJsonDigest,
  computeApprovalIntentDigest,
  RuntimeSchemaRefs,
  type RuntimeWireTypes as W,
} from '../../../../packages/protocol/src/runtime/index.js'

const data = (value: W['JsonValue']): Extract<W['DataRef'], { kind: 'inline' }> => {
  const ref = inlineInstallerRef(value)
  if (ref.kind !== 'inline') throw new Error('inline fixture codec required')
  return { ...ref, bytes: Buffer.byteLength(jcs(value)) }
}

const failure = (detailCode: string): Outcome<never> => ({
  ok: false,
  error: {
    code: 'denied',
    detailCode,
    message: detailCode,
    diagnosticId: 'fixture',
    retryAdvice: { kind: 'never' },
  },
})
/** Restricted durable State/admission/codec fixture. It is not the production State authority. */
export function installerApprovalFixture(
  kind: 'default' | 'reference',
  directory: string,
  now: () => string,
  sourceHeads: () => Promise<W['UpgradeExpectedHeads'] | null>,
  hook?: (phase: string) => Promise<void>,
) {
  const path = join(directory, 'deployment-approval.json')
  const statePath = join(directory, 'approval-action.json')
  const control = {
    helperRunEligible: true,
    admissionAvailable: true,
    stateActionAvailable: true,
    stateAuthorizationAvailable: true,
    hostApprovalAvailable: true,
    sourceChanged: false,
    scopeChanged: false,
  }
  const read = () => JSON.parse(readFileSync(path, 'utf8')) as DeploymentApprovalTerminal
  const mapPath = join(directory, 'deployment-approvals.json')
  const records = (): Record<string, DeploymentApprovalTerminal> => {
    try {
      return JSON.parse(readFileSync(mapPath, 'utf8'))
    } catch {
      return {}
    }
  }
  const write = (value: DeploymentApprovalTerminal) => {
    writeFileSync(mapPath, JSON.stringify({ ...records(), [value.proposalId]: value }), { flush: true })
    writeFileSync(path, JSON.stringify(value), { flush: true })
  }
  let frozenRequest: DeploymentApprovalRequest
  let frozenBinding: DeploymentApprovalBinding
  const store = (value: W['JsonValue']): W['DataRef'] => {
    const encoded = jcs(value),
      digest = canonicalJsonDigest(value)
    writeFileSync(join(directory, `approval-codec-${digest}.json`), encoded, { flush: true })
    return {
      kind: 'blob',
      schema: data(null).schema,
      blob: {
        authorityId: 'fixture-frozen-input-owner',
        blobId: digest,
        digest,
        bytes: Buffer.byteLength(encoded),
        mediaType: 'application/json',
        pinId: `fixture-pin:${digest}`,
      },
    }
  }
  const decode = (ref: W['DataRef']): W['JsonValue'] => {
    if (ref.kind === 'inline') return ref.value
    const bytes = readFileSync(join(directory, `approval-codec-${ref.blob.blobId}.json`))
    const value = JSON.parse(bytes.toString()) as W['JsonValue']
    if (bytes.length !== ref.blob.bytes || canonicalJsonDigest(value) !== ref.blob.digest)
      throw new Error('fixture codec integrity failed')
    return value
  }
  const ports: DeploymentApprovalAdapterPorts = {
    async freeze(request) {
      frozenRequest = request
      const planRef = store(request.plan.value)
      const input = store({
        proposalId: request.proposalId,
        planRevision: request.planRevision,
        planRef,
        planDigest: request.planDigest,
        targetScope: request.scope,
        sourceDifference: request.sourceDifference,
        capabilityDifference: request.capabilityDifference,
      })
      return {
        ok: true,
        value: {
          planRef,
          input,
          inputDigest: canonicalJsonDigest(input),
          sourceHeads: await sourceHeads(),
          expiresAt: request.plan.kind === 'release' ? request.plan.value.expiresAt : '2030-01-01T00:00:00Z',
        },
      }
    },
    async openCarrier(_request, context) {
      if (!control.helperRunEligible && !control.admissionAvailable)
        return failure('deployment_carrier_unavailable')
      // Restricted fixtures have distinct helper and admitted management Run records.
      const runId = control.helperRunEligible ? 'fixture-helper-run' : 'fixture-management-run'
      writeFileSync(
        join(directory, 'approval-carrier.json'),
        JSON.stringify({
          runId,
          admitted: !control.helperRunEligible,
          admissionTicket: control.helperRunEligible ? null : 'fixture-admission-ticket',
        }),
        { flush: true },
      )
      await hook?.('approval-carrier-opened')
      return {
        ok: true,
        value: {
          runId,
          context: {
            ...context,
            principalRef: 'fixture-carrier-principal',
            authorizationRef: `fixture-carrier-authorization:${runId}`,
            bindingId: `fixture-c23-binding:${runId}`,
            invocationId: `fixture-carrier-call:${runId}`,
          },
        },
      }
    },
    async prepareAction({ request, frozen, runId }, context) {
      if (
        context.principalRef !== 'fixture-carrier-principal' ||
        context.bindingId !== `fixture-c23-binding:${runId}`
      )
        return failure('deployment_carrier_mismatch')
      if (!control.stateActionAvailable) return failure('deployment_action_unavailable')
      const prior = records()[request.proposalId]
      const suffix = Object.keys(records()).length ? `:${canonicalJsonDigest(request.proposalId)}` : ''
      const owner = prior?.binding.owner ?? { runId, actionId: `fixture-new-approval-action${suffix}` }
      const draft: W['ApprovalRequest'] = {
        kind: 'approval',
        title: 'Approve fixed deployment',
        body: 'Deploy the frozen maintenance plan',
        actionRef: owner.actionId,
        inputDigest: frozen.inputDigest,
        policyDecisionRef: 'fixture-deployment-policy',
        scope: request.scope,
        allowedResponders: ['fixture-human'],
        allowedGrantScopes: ['once'],
        expiresAt: frozen.expiresAt,
        idempotencyKey: request.proposalId,
        risk: 'destructive',
        intentDigest: '0'.repeat(64),
      }
      const intent = computeApprovalIntentDigest(draft)
      if (!intent.ok) throw new Error('invalid native approval input')
      draft.intentDigest = intent.value
      writeFileSync(
        statePath,
        JSON.stringify({
          stage: 'action-prepared',
          owner,
          input: frozen.input,
          inputDigest: frozen.inputDigest,
          request: draft,
          sourceRequest: request,
        }),
        { flush: true },
      )
      await hook?.('approval-action-prepared')
      return { ok: true, value: { owner, actionRef: owner.actionId, request: draft } }
    },
    async prepareAuthorization(input, context) {
      if (context.principalRef !== 'fixture-carrier-principal') return failure('deployment_carrier_mismatch')
      if (!control.stateAuthorizationAvailable) return failure('deployment_authorization_unavailable')
      const action = JSON.parse(readFileSync(statePath, 'utf8'))
      if (
        action.stage !== 'action-prepared' ||
        canonicalJsonDigest(action.input) !== input.request.inputDigest
      )
        return failure('deployment_authorization_mismatch')
      const authorizationRef = data({ owner: input.owner, inputDigest: input.request.inputDigest })
      writeFileSync(
        statePath,
        JSON.stringify({ ...action, stage: 'authorization-prepared', authorizationRef }),
        { flush: true },
      )
      await hook?.('approval-authorization-prepared')
      return { ok: true, value: authorizationRef }
    },
    async verify({ request, binding }) {
      const action = JSON.parse(readFileSync(statePath, 'utf8'))
      const expected = {
        proposalId: request.proposalId,
        planRevision: request.planRevision,
        planRef: binding.planRef,
        planDigest: request.planDigest,
        targetScope: request.scope,
        sourceDifference: request.sourceDifference,
        capabilityDifference: request.capabilityDifference,
      }
      if (
        control.sourceChanged ||
        control.scopeChanged ||
        action.stage !== 'authorization-prepared' ||
        canonicalJsonDigest(action.authorizationRef) !== canonicalJsonDigest(binding.authorizationRef) ||
        canonicalJsonDigest(decode(binding.planRef)) !== canonicalJsonDigest(request.plan.value) ||
        canonicalJsonDigest(decode(binding.input)) !== canonicalJsonDigest(expected) ||
        canonicalJsonDigest(binding.input) !== binding.inputDigest ||
        canonicalJsonDigest(action.owner) !== canonicalJsonDigest(binding.owner) ||
        canonicalJsonDigest(binding.sourceHeads) !== canonicalJsonDigest(await sourceHeads())
      )
        return failure('deployment_source_changed')
      frozenBinding = binding
      return { ok: true, value: undefined }
    },
    async prepareApproval({ owner, request, authorizationRef }, context) {
      if (
        context.principalRef !== 'fixture-carrier-principal' ||
        context.bindingId !== `fixture-c23-binding:${owner.runId}`
      )
        return failure('deployment_carrier_mismatch')
      if (!control.hostApprovalAvailable) return failure('deployment_approval_unavailable')
      const action = JSON.parse(readFileSync(statePath, 'utf8'))
      if (
        action.stage !== 'authorization-prepared' ||
        canonicalJsonDigest(action.authorizationRef) !== canonicalJsonDigest(authorizationRef)
      )
        return failure('deployment_authorization_mismatch')
      let previous: DeploymentApprovalTerminal | null = null
      try {
        previous = records()[frozenRequest.proposalId] ?? null
      } catch {
        /* New restricted fixture approval. */
      }
      if (previous) return { ok: true, value: previous.interaction }
      const answerValue: W['ApprovalAnswer'] = {
        decision: 'approve',
        grantScope: 'once',
        intentDigest: request.intentDigest,
      }
      const answer = { ...data(answerValue), value: answerValue, schema: RuntimeSchemaRefs.ApprovalAnswer }
      const interaction: W['InteractionRecord'] = {
        interactionId: Object.keys(records()).length
          ? `fixture-interaction:${canonicalJsonDigest(frozenRequest.proposalId)}`
          : 'fixture-interaction',
        owner,
        request,
        version: 2,
        createdAt: now(),
        updatedAt: now(),
        status: 'answered',
        terminationReason: null,
        resolution: {
          responseId: 'fixture-response',
          actorRef: 'fixture-human',
          answer,
          committedAt: now(),
          evidence: { kind: 'human', authenticationRef: data({ authenticated: 'fixture-human' }) },
        },
      }
      write({
        binding: frozenBinding,
        interaction,
        proposalId: frozenRequest.proposalId,
        interactionId: interaction.interactionId,
        responseId: interaction.status === 'answered' ? interaction.resolution.responseId : null,
        status: 'answered',
        decision: 'approve',
        intentDigest: request.intentDigest,
        expiresAt: request.expiresAt,
        owner,
        tenantId: frozenRequest.identity.tenantId,
        scope: frozenRequest.scope,
        reference: data({ interactionId: interaction.interactionId, proposalId: frozenRequest.proposalId }),
      })
      await hook?.('approval-requested')
      return { ok: true, value: interaction }
    },
    async read({ proposalId, interactionId }) {
      const result = records()[proposalId]
      if (!result) return failure('deployment_approval_mismatch')
      return result.proposalId === proposalId && result.interactionId === interactionId
        ? { ok: true, value: result }
        : failure('deployment_approval_mismatch')
    },
    async responseStatus({ proposalId, interactionId, responseId }) {
      const result = records()[proposalId]
      if (!result) return failure('deployment_approval_mismatch')
      return result.proposalId === proposalId &&
        result.interactionId === interactionId &&
        result.responseId === responseId
        ? { ok: true, value: result }
        : failure('operation_identity_conflict')
    },
    async cancelInteraction({ interactionId, expectedVersion, reason }) {
      const previous = Object.values(records()).find((record) => record.interactionId === interactionId)
      if (!previous || previous.interaction.version !== expectedVersion)
        return failure('proposal_revision_conflict')
      if (previous.status !== 'pending') return { ok: true, value: previous.interaction }
      const interaction: W['InteractionRecord'] = {
        ...previous.interaction,
        version: expectedVersion + 1,
        status: 'cancelled',
        resolution: null,
        terminationReason: reason,
      }
      write({ ...previous, interaction, status: 'cancelled', responseId: null, decision: null })
      return { ok: true, value: interaction }
    },
  }
  return {
    ports,
    control,
    read,
    decode,
    port: (kind === 'default' ? createDeploymentApprovalAdapter : createReferenceDeploymentApprovalAdapter)(
      ports,
    ),
    patch(patch: Partial<DeploymentApprovalTerminal>) {
      const next = { ...read(), ...patch }
      if (next.status !== 'answered') {
        next.responseId = null
        next.decision = null
        next.interaction =
          next.status === 'pending'
            ? { ...next.interaction, status: 'pending', resolution: null, terminationReason: null }
            : { ...next.interaction, status: next.status, resolution: null, terminationReason: next.status }
      } else if (next.interaction.status === 'answered') {
        const value: W['ApprovalAnswer'] =
          next.decision === 'approve'
            ? { decision: 'approve', grantScope: 'once', intentDigest: next.intentDigest }
            : { decision: 'deny', intentDigest: next.intentDigest }
        next.interaction = {
          ...next.interaction,
          resolution: {
            ...next.interaction.resolution,
            answer: { ...data(value), value, schema: RuntimeSchemaRefs.ApprovalAnswer },
          },
        }
      }
      write(next)
    },
  }
}
