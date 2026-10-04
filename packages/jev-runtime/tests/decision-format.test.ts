import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { brandString } from '../src/brand.js'
import { compileQuestions, DECISION_GUIDANCE } from '../src/decision.js'
import type {
  Candidate,
  CandidateId,
  DecisionToolProfile,
  EnvironmentEpoch,
  RecordId,
  RuntimeConfig,
  ToolDescriptor,
} from '../src/types.js'

const profiles: DecisionToolProfile[] = [
  {
    operation: 'write',
    toolRevision: 'v1',
    selection: 'Replace complete file text',
    phases: ['ACT'],
    inputs: 'Path and text',
    result: 'Saved file',
    constraints: ['Use an admitted target'],
  },
  {
    operation: 'job_list',
    toolRevision: 'v1',
    selection: 'List known background jobs',
    phases: ['INSPECT', 'VERIFY'],
    inputs: 'None',
    result: 'Job ids and statuses',
    constraints: ['Inventory is not output collection'],
  },
  {
    operation: 'read',
    toolRevision: 'v1',
    selection: 'Read saved text',
    phases: ['INSPECT', 'ACT', 'VERIFY'],
    inputs: 'Path and optional window',
    result: 'File content and coverage',
    constraints: ['A locator does not establish content'],
  },
]
const tools: ToolDescriptor[] = profiles.map((profile) => ({
  name: profile.operation,
  description: 'Native description',
  revision: profile.toolRevision,
  phases: profile.phases,
  parameters:
    profile.operation === 'job_list'
      ? { type: 'object', properties: {}, additionalProperties: false }
      : { type: 'object' },
  output: {},
  effectClass: profile.operation === 'write' ? 'workspace_mutation' : 'read_only',
}))
const candidate: Candidate = {
  id: brandString<CandidateId>('private-candidate'),
  tool: 'read',
  label: 'Read observed file',
  arguments: { path: 'observed.txt', window: { offset: 0, limit: 10 }, note: 'line\n"quoted"' },
  sourceRecordIds: [brandString<RecordId>('private-record')],
  environmentEpoch: brandString<EnvironmentEpoch>('private-epoch'),
  toolRevision: 'v1',
}
const config: RuntimeConfig = {
  maxSteps: 3,
  maxModelAttempts: 4,
  maxNoProgress: 2,
  maxRepeatedFailures: 2,
  maxCandidates: 3,
  maxHistory: 8,
  maxQuestionBytes: 30_000,
  maxOutputBytes: 10_000,
  escalateBelow: 0.6,
  mutationEscalateBelow: 0.6,
  bindingBelow: 0.6,
  equivalentSupportThreshold: 0.8,
  ambiguityGate: null,
  answerProgressFloor: null,
  responseReviewMode: 'diagnostic',
  maxResponseReviewAttempts: 2,
}

describe('shared operation definitions and conditional request presentation', () => {
  it('preserves compiler wording, keys, criteria order and labeled JSON arguments', () => {
    const surface = compileQuestions(tools, [candidate], config, profiles)
    const expected: unknown = JSON.parse(
      readFileSync(new URL('./decision-format.expected.json', import.meta.url), 'utf8'),
    )
    // JSON file layout is formatter-owned; wording, object insertion order and array order are not.
    expect(
      JSON.stringify({
        sharedGuidance: DECISION_GUIDANCE,
        catalog: surface.catalog,
        questions: surface.questions,
      }),
    ).toBe(JSON.stringify(expected))
  })
})
