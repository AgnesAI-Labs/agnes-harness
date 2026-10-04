import { describe, expect, it } from 'vitest'
import type { SelectedDecision } from '../src/decision.js'
import {
  escalationReason,
  operationGateReasons,
  operationSupportUsed,
  requiresResponseReview,
} from '../src/decision-gates.js'
import type { RuntimeConfig, ToolDescriptor } from '../src/types.js'

const config: RuntimeConfig = {
  maxSteps: 3,
  maxModelAttempts: 4,
  maxNoProgress: 2,
  maxRepeatedFailures: 2,
  maxCandidates: 3,
  maxHistory: 8,
  maxQuestionBytes: 30_000,
  maxOutputBytes: 10_000,
  escalateBelow: 0.5,
  mutationEscalateBelow: 0.7,
  bindingBelow: 0.6,
  equivalentSupportThreshold: 0.8,
  ambiguityGate: null,
  answerProgressFloor: null,
  responseReviewMode: 'diagnostic',
  maxResponseReviewAttempts: 2,
}
const tool: ToolDescriptor = {
  name: 'read',
  description: 'Read',
  parameters: {},
  output: {},
  revision: '1',
  effectClass: 'read_only',
}
const decision: SelectedDecision = {
  kind: 'tool',
  operation: 'read',
  parameterMode: 'parameterized',
  bindingMode: 'selected_candidate',
  purpose: 'INSPECT',
  purposeConfidence: 0.9,
  purposeProbabilities: { INSPECT: 1 },
  operationConfidence: 0.3,
  operationProbabilities: { read: 1 },
  operationPathConfidence: 0.3,
  equivalentSupport: 1,
  operationBranches: [],
  invalidOperationBranches: [],
  consumedQuestionIds: ['purpose', 'operation_INSPECT', 'binding_read'],
  bindingConfidence: 0.2,
  ambiguity: 0.1,
}
const scores = (
  purposeConfidence: number,
  operationConfidence: number | null,
  equivalentSupport = 0,
): SelectedDecision => ({
  ...decision,
  purposeConfidence,
  operationConfidence,
  equivalentSupport,
  operationProbabilities: operationConfidence === null ? null : decision.operationProbabilities,
  operationPathConfidence:
    operationConfidence === null ? purposeConfidence : Math.min(purposeConfidence, operationConfidence),
})

describe('independent selection and parameter admission', () => {
  it('never relaxes low O from ambiguity or support, including trusted read-only tools', () => {
    for (const purpose of ['INSPECT', 'ACT', 'VERIFY'] as const) {
      for (const ambiguity of [undefined, 0, 0.9]) {
        const selected = {
          ...scores(0.99, 0.49, 1),
          purpose,
          ...(ambiguity === undefined ? {} : { ambiguity }),
        }
        expect(escalationReason(selected, tool, config, false)).toBe('low_confidence')
        expect(operationSupportUsed(selected, tool, config)).toBe(false)
      }
    }
    expect(escalationReason(scores(0.99, null, 1), tool, config, false)).toBe('low_confidence')
  })

  it('rescues only insufficient P for the same selected tool after the independent O threshold', () => {
    const rescued = scores(0.1, 0.5, 0.8)
    expect(escalationReason(rescued, tool, config, false)).toBeUndefined()
    expect(operationSupportUsed(rescued, tool, config)).toBe(true)
    expect(rescued.bindingConfidence).toBeLessThan(config.bindingBelow)
    expect(escalationReason(scores(0.1, 0.5, 0.799), tool, config, false)).toBe('low_confidence')
    expect(escalationReason(scores(0.1, 0.499, 1), tool, config, false)).toBe('low_confidence')
    expect(escalationReason({ ...rescued, equivalentSupport: null }, tool, config, false)).toBe(
      'low_confidence',
    )
    expect(escalationReason(rescued, tool, { ...config, equivalentSupportThreshold: 0.9 }, false)).toBe(
      'low_confidence',
    )
  })

  it('preserves ordinary baseline acceptance regardless of absent or disagreeing supporting heads', () => {
    for (const equivalentSupport of [null, 0, 1]) {
      const accepted = {
        ...scores(0.5, 0.5),
        equivalentSupport,
        invalidOperationBranches: [
          { purpose: 'VERIFY' as const, question: 'operation_VERIFY', error: 'invalid' },
        ],
      }
      expect(escalationReason(accepted, tool, config, false)).toBeUndefined()
      expect(operationSupportUsed(accepted, tool, config)).toBe(false)
    }
  })

  it('uses the mutation threshold for writes, unknown effects and missing tool metadata', () => {
    const { effectClass: _effectClass, ...unclassified } = tool
    for (const current of [
      { ...tool, effectClass: 'workspace_mutation' as const },
      { ...tool, effectClass: 'external_write' as const },
      unclassified,
      undefined,
    ]) {
      expect(escalationReason(scores(0.9, 0.6, 1), current, config, false)).toBe('low_confidence')
      expect(escalationReason(scores(0.2, 0.7, 0.8), current, config, false)).toBeUndefined()
      expect(operationSupportUsed(scores(0.6, 0.7, 0.8), current, config)).toBe(true)
    }
  })

  it('never lends tool support or diagnostic can_end to RESPOND', () => {
    const response: SelectedDecision = {
      ...scores(0.69, null, 1),
      kind: 'respond',
      operation: 'RESPOND',
      purpose: 'RESPOND',
      canEnd: 1,
    }
    expect(escalationReason(response, undefined, config, false)).toBe('low_confidence')
    expect(operationSupportUsed(response, undefined, config)).toBe(false)
    expect(
      escalationReason({ ...response, purposeConfidence: 0.7, canEnd: 0 }, undefined, config, false),
    ).toBeUndefined()
  })

  it('keeps pending recovery first even when support rescues the confidence path', () => {
    expect(operationGateReasons(scores(0.1, 0.9, 0.8), tool, config, true)).toEqual([
      'recoverable_observation',
    ])
    expect(operationGateReasons(scores(0.1, 0.1, 1), tool, config, true)).toEqual([
      'recoverable_observation',
      'low_confidence',
    ])
    expect(escalationReason(scores(0.1, 0.1, 1), tool, config, true)).toBe('recoverable_observation')
  })

  it('applies the same operation and recovery checks to genuine no-argument calls', () => {
    const noArguments: SelectedDecision = {
      ...scores(0.3, 0.6, 0.8),
      operation: 'reset',
      parameterMode: 'no_arguments',
      purpose: 'ACT',
    }
    const mutation = { ...tool, name: 'reset', effectClass: 'workspace_mutation' as const }
    expect(escalationReason(noArguments, mutation, config, false)).toBe('low_confidence')
    expect(
      escalationReason({ ...noArguments, operationConfidence: 0.7 }, mutation, config, false),
    ).toBeUndefined()
    expect(escalationReason({ ...noArguments, operationConfidence: 0.7 }, mutation, config, true)).toBe(
      'recoverable_observation',
    )
  })

  it('keeps completion signals diagnostic except separately configured progress review', () => {
    const response: SelectedDecision = {
      ...scores(0.9, null),
      kind: 'respond',
      operation: 'RESPOND',
      purpose: 'RESPOND',
    }
    expect(requiresResponseReview(response, config)).toBe(false)
    expect(
      escalationReason({ ...response, canEnd: 0, progress: 0 }, undefined, config, false),
    ).toBeUndefined()
    const review = { ...config, responseReviewMode: 'review' as const, answerProgressFloor: 2 }
    expect(requiresResponseReview({ ...response, canEnd: 1 }, review)).toBe(true)
    expect(requiresResponseReview({ ...response, progress: 1.99 }, review)).toBe(true)
    expect(requiresResponseReview({ ...response, progress: 2 }, review)).toBe(false)
    expect(requiresResponseReview({ ...decision, progress: 0 }, review)).toBe(false)
  })
})
