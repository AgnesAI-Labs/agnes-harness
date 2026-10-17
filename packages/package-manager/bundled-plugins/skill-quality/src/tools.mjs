import { defineTool, readOnlyTool, toolError, workflowResult, writeTool } from '@agnes/plugin-runtime'
import { Type } from '@sinclair/typebox'
import {
  candidateReceipt,
  digest,
  EVENT,
  emptyState,
  keyOf,
  parseEvidence,
  qualityView,
  upsert,
} from './model.mjs'

const id = Type.String({ pattern: '^candidate-[a-f0-9]{32}$' })
const hash = Type.String({ pattern: '^sha256-[a-f0-9]{64}$' })
const files = Type.Array(
  Type.Object(
    {
      path: Type.String({ minLength: 1, maxLength: 240 }),
      content: Type.String({ maxLength: 131072 }),
    },
    { additionalProperties: false },
  ),
  { minItems: 1, maxItems: 64 },
)
const closed = (properties) => Type.Object(properties, { additionalProperties: false })
const failed = (candidate) =>
  ['failed', 'interrupted', 'rejected'].includes(candidate.state) || candidate.hostTests?.state === 'failed'

export function createTools(plugin) {
  const requireContext = (ctx) => {
    ctx.signal.throwIfAborted()
    if (!ctx.store || !ctx.pluginManage || ctx.session.depth !== 0)
      throw new Error('QUALITY_LOCAL_MAIN_SESSION_REQUIRED')
    keyOf(ctx.session.key)
  }
  const record = async (ctx, candidate, evidence, observation) => {
    ctx.signal.throwIfAborted()
    const key = keyOf(ctx.session.key)
    const previous = ctx.store.get(key) ?? emptyState()
    const old = previous.records.find((row) => row.candidate.candidateId === candidate.candidateId)
    const next = {
      candidate,
      evidence: evidence ?? old?.evidence ?? null,
      importedDigest: evidence ? digest(JSON.stringify(evidence)) : (old?.importedDigest ?? null),
      // Every observation is explicitly supplied, never inferred from the candidate's frozen base.
      ...(observation !== undefined ? { installedObservation: observation } : {}),
    }
    const state = upsert(previous, next)
    if (Buffer.byteLength(JSON.stringify(state)) > 56 * 1024) throw new Error('QUALITY_STATE_LIMIT')
    // Ledger first. A failed cache write is an error; its event remains inspectable in the projection.
    await plugin.eventLog.append(EVENT, next)
    ctx.signal.throwIfAborted()
    ctx.store.set(key, state)
    return qualityView(next)
  }
  const run = (execute) => async (input, ctx) => {
    try {
      requireContext(ctx)
      return await execute(input, ctx)
    } catch (error) {
      ctx.signal.throwIfAborted()
      // Do not expose paths or raw Host diagnostics in the model-facing failure.
      const message =
        error instanceof Error && /^QUALITY_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'QUALITY_OPERATION_FAILED_CHECK_HOST_STATE'
      return toolError(
        `${message}: Quality evidence was not updated. Check the candidate and its current hash in Settings → Plugins, or correct the import envelope. Do not retry an unknown operation automatically.`,
      )
    }
  }
  return [
    defineTool({
      name: 'skill_quality_candidate',
      description:
        'Create/read/write/test/submit a Skill candidate through Host authorization. Submit requests human review only. No publish/install/enable operation. Tests have the normal exact-hash Host confirmation. Unknown results must be inspected, never retried automatically.',
      parameters: closed({
        action: Type.Union(['create', 'read', 'write', 'test', 'submit'].map((value) => Type.Literal(value))),
        candidateId: Type.Optional(id),
        expectedHash: Type.Optional(hash),
        files: Type.Optional(files),
      }),
      meta: { ...writeTool, isDestructive: false, deferLoading: true },
      policyVersion: 'skill-quality-candidate-v1',
      classify(input) {
        return {
          ...(input.action === 'read' ? readOnlyTool : writeTool),
          isDestructive: false,
          requiresApproval: ['read', 'test'].includes(input.action) ? 'never' : 'always',
          approvalScopes: [],
        }
      },
      execute: run(async (input, ctx) => {
        const { action, candidateId, expectedHash, files: source } = input
        if (!['create', 'read', 'write', 'test', 'submit'].includes(action))
          throw new Error('QUALITY_ARGUMENTS_INVALID')
        if (
          action === 'create'
            ? !source || candidateId !== undefined || expectedHash !== undefined
            : !candidateId ||
              (action !== 'read' && !expectedHash) ||
              (action === 'write' ? !source : source !== undefined)
        )
          throw new Error('QUALITY_ARGUMENTS_INVALID')
        const request =
          action === 'create'
            ? { action: 'candidate.create', files: source }
            : {
                action: `candidate.${action === 'read' ? 'show' : action}`,
                candidateId,
                ...(expectedHash ? { expectedHash } : {}),
                ...(source ? { files: source } : {}),
              }
        const raw = await ctx.pluginManage.request(request)
        ctx.signal.throwIfAborted()
        const candidate = candidateReceipt(raw)
        if (candidateId && candidate.candidateId !== candidateId) throw new Error('QUALITY_CANDIDATE_INVALID')
        const quality = await record(ctx, candidate)
        return {
          ...workflowResult({ candidate, quality }),
          ...(action !== 'read' && failed(candidate) ? { isError: true } : {}),
        }
      }),
    }),
    defineTool({
      name: 'skill_quality_import',
      description:
        'Manually attach a normalized P01 eval artifact or self-assessment to a candidate. JSON is always unverified imported evidence, never a Host test receipt or human approval. Supply currentInstalledHash only from an explicit current inventory observation; omit if unknown. This does not run models or publish.',
      parameters: closed({
        candidateId: id,
        evidenceJson: Type.String({ maxLength: 49152 }),
        currentInstalledHash: Type.Optional(Type.Union([hash, Type.Null()])),
      }),
      meta: { ...writeTool, isDestructive: false, deferLoading: true },
      execute: run(async (input, ctx) => {
        const evidence = parseEvidence(input.evidenceJson)
        const candidate = candidateReceipt(
          await ctx.pluginManage.request({ action: 'candidate.show', candidateId: input.candidateId }),
        )
        ctx.signal.throwIfAborted()
        if (candidate.candidateId !== input.candidateId) throw new Error('QUALITY_CANDIDATE_INVALID')
        const quality = await record(ctx, candidate, evidence, input.currentInstalledHash)
        return workflowResult(quality)
      }),
    }),
  ]
}
