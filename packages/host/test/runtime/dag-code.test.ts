import { validateRuntime } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import { assessPresetSupport, type DagCodeInput, selectDagCode } from '../../src/runtime/config/dag-code.js'

function baseInput(): DagCodeInput {
  return {
    preset: {
      name: 'dag-code',
      disclosure: 'code',
      model: { route: { primary: { route: 'main', model: 'code-model' } } },
      tools: { core: ['run_code'] },
      code_runtime: { language: 'python', state: 'persistent' },
      budget: { max_steps: 7 },
      operations: { remove: ['agnes/refine'] },
      harness: { auto_refine: { enabled: false } },
      completion_gate: { enabled: false },
    },
    selection: { packageId: 'reference-loop', providerId: 'agh.reference/loop' },
    loop: {
      features: ['legacy-primary-decision-budget.v1', 'legacy-tool-result-control.v1'],
      tools: ['run_code'],
      codePromptSections: ['persona', 'environment', 'code-doctrine', 'tools:sdk'],
      languages: ['python'],
      states: ['persistent'],
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>
  throw new Error('expected an object')
}

it('accepts the explicit combination on the published session schema', () => {
  const input = baseInput()
  const snap = structuredClone(input)
  const result = selectDagCode(input)
  expect(input).toEqual(snap)
  expect(result.status).toBe('accepted')
  expect(result.presetId).toBe('dag-code')
  expect(result.providerId).toBe('agh.reference/loop')
  expect(result.features).toEqual(['legacy-primary-decision-budget.v1', 'legacy-tool-result-control.v1'])
  expect(result.parameters).toEqual({
    disclosure: 'code',
    model: { route: { primary: { route: 'main', model: 'code-model' } } },
    tools: { core: ['run_code'] },
    code_runtime: { language: 'python', state: 'persistent' },
    budget: { max_steps: 7 },
    operations: { remove: ['agnes/refine'] },
    harness: { auto_refine: { enabled: false } },
    completion_gate: { enabled: false },
  })
  expect(result.parameters).not.toHaveProperty('quality')
  expect(result.parameters).not.toHaveProperty('loop')
  expect(result.parameters).not.toHaveProperty('verifier')
  expect(result.parameters).not.toHaveProperty('repair')
  expect(result.inherited).toBeNull()
  expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
  const validated = validateRuntime('DefaultSessionParameters', result.parameters)
  expect(validated.ok).toBe(true)
})

it('keeps an explicit harness entry limit instead of filling session defaults', () => {
  const input = baseInput()
  record(input.preset.harness).max_entries = { prompt: 10 }
  const result = selectDagCode(input)
  expect(result.status).toBe('accepted')
  expect(record(result.parameters.harness).max_entries).toEqual({ prompt: 10 })
  expect(result.parameters).not.toHaveProperty('verifier')
  expect(record(result.parameters.budget)).not.toHaveProperty('preflight')
})

it('gives the same digest when parameter keys are ordered differently', () => {
  const first = baseInput()
  const second = baseInput()
  second.preset = {
    name: 'dag-code',
    completion_gate: { enabled: false },
    harness: { auto_refine: { enabled: false } },
    operations: { remove: ['agnes/refine'] },
    budget: { max_steps: 7 },
    code_runtime: { language: 'python', state: 'persistent' },
    tools: { core: ['run_code'] },
    model: { route: { primary: { route: 'main', model: 'code-model' } } },
    disclosure: 'code',
  }
  const accepted = selectDagCode(first)
  const reordered = selectDagCode(second)
  expect(accepted.status).toBe('accepted')
  expect(reordered.status).toBe('accepted')
  expect(reordered.digest).toBe(accepted.digest)
})

it('refuses a missing declared feature and still reports the submitted limit', () => {
  const input = baseInput()
  input.loop.features = ['legacy-primary-decision-budget.v1']
  const snap = structuredClone(input)
  const refused = selectDagCode(input)
  expect(input).toEqual(snap)
  expect(refused.status).toBe('refused')
  expect(refused.digest).toBeNull()
  expect(refused.features).toEqual([])
  expect(record(refused.parameters.budget).max_steps).toBe(7)
  expect(
    refused.diagnostics.some(
      (item) => item.code === 'missing_capability' && item.feature === 'legacy-tool-result-control.v1',
    ),
  ).toBe(true)
  const recovered = selectDagCode({
    ...input,
    loop: { ...input.loop, features: [...snap.loop.features, 'legacy-tool-result-control.v1'] },
  })
  expect(recovered.status).toBe('accepted')
  expect(record(recovered.parameters.budget).max_steps).toBe(7)
})

it.each([
  {
    title: 'quality',
    code: 'unsupported_parameter',
    apply: (input: DagCodeInput) => {
      input.preset.quality = { deviation_max: 0.2 }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(parameters.quality).toEqual({ deviation_max: 0.2 })
    },
  },
  {
    title: 'the default loop strategy',
    code: 'unsupported_parameter',
    apply: (input: DagCodeInput) => {
      input.preset.loop = { repeat_threshold: 3, no_progress_steps: 4 }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(parameters.loop).toEqual({ repeat_threshold: 3, no_progress_steps: 4 })
    },
  },
  {
    title: 'a verifier',
    code: 'unsupported_parameter',
    apply: (input: DagCodeInput) => {
      input.preset.verifier = { timeout_ms: 30_000, default_tier: 0 }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(parameters.verifier).toEqual({ timeout_ms: 30_000, default_tier: 0 })
    },
  },
  {
    title: 'repair',
    code: 'unsupported_parameter',
    apply: (input: DagCodeInput) => {
      input.preset.repair = { max_rounds: 5 }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(parameters.repair).toEqual({ max_rounds: 5 })
    },
  },
  {
    title: 'an extra model slot',
    code: 'unsupported_parameter',
    feature: 'model-slot:escalation',
    apply: (input: DagCodeInput) => {
      record(record(input.preset.model).route).escalation = { route: 'main', model: 'big' }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(record(record(parameters.model).route).escalation).toEqual({ route: 'main', model: 'big' })
    },
  },
  {
    title: 'operation replacement',
    code: 'unsupported_parameter',
    apply: (input: DagCodeInput) => {
      input.preset.operations = { remove: ['agnes/refine'], replace: { Custom: 'pkg.op' } }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(record(parameters.operations).replace).toEqual({ Custom: 'pkg.op' })
    },
  },
  {
    title: 'an enabled completion gate',
    code: 'unsupported_parameter',
    feature: 'loop-quality:completion-gate',
    apply: (input: DagCodeInput) => {
      input.preset.completion_gate = { enabled: true }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(parameters.completion_gate).toEqual({ enabled: true })
    },
  },
  {
    title: 'extra completion-gate parameters',
    code: 'unsupported_parameter',
    apply: (input: DagCodeInput) => {
      input.preset.completion_gate = { enabled: false, min_items: 3 }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(parameters.completion_gate).toEqual({ enabled: false, min_items: 3 })
    },
  },
  {
    title: 'enabled auto refine',
    code: 'unsupported_parameter',
    feature: 'agnes/refine',
    apply: (input: DagCodeInput) => {
      input.preset.harness = { auto_refine: { enabled: true } }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(record(record(parameters.harness).auto_refine).enabled).toBe(true)
    },
  },
  {
    title: 'removing code prompts',
    code: 'missing_capability',
    feature: 'code:prompts',
    apply: (input: DagCodeInput) => {
      input.preset.operations = { remove: ['agnes/refine', 'code:prompts'] }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(record(parameters.operations).remove).toEqual(['agnes/refine', 'code:prompts'])
    },
  },
  {
    title: 'an omitted decision budget',
    code: 'missing_capability',
    feature: 'legacy-primary-decision-budget.v1',
    apply: (input: DagCodeInput) => {
      input.preset.budget = {}
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(parameters.budget).toEqual({})
    },
  },
  {
    title: 'an omitted code disclosure',
    code: 'missing_capability',
    feature: 'disclosure=code',
    apply: (input: DagCodeInput) => {
      delete input.preset.disclosure
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(parameters.disclosure).toBeUndefined()
    },
  },
  {
    title: 'an empty tool list',
    code: 'missing_capability',
    feature: 'run_code',
    apply: (input: DagCodeInput) => {
      input.preset.tools = { core: [] }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(record(parameters.tools).core).toEqual([])
    },
  },
  {
    title: 'a missing primary route',
    code: 'missing_capability',
    feature: 'model.route.primary',
    apply: (input: DagCodeInput) => {
      input.preset.model = {}
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(parameters.model).toEqual({})
    },
  },
  {
    title: 'a required sandbox turned off',
    code: 'safety_disabled',
    apply: (input: DagCodeInput) => {
      input.preset.sandbox = { required: false }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(record(parameters.sandbox).required).toBe(false)
    },
  },
  {
    title: 'a sandbox that fails open',
    code: 'safety_disabled',
    apply: (input: DagCodeInput) => {
      input.preset.sandbox = { on_unavailable: 'allow' }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(record(parameters.sandbox).on_unavailable).toBe('allow')
    },
  },
  {
    title: 'an undeclared hook',
    code: 'missing_capability',
    feature: 'hook:shutdown',
    apply: (input: DagCodeInput) => {
      input.preset.hooks = ['shutdown']
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(parameters.hooks).toEqual(['shutdown'])
    },
  },
  {
    title: 'an unsupported code language',
    code: 'missing_capability',
    feature: 'code_runtime.language',
    apply: (input: DagCodeInput) => {
      input.preset.code_runtime = { language: 'typescript', state: 'persistent' }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(record(parameters.code_runtime).language).toBe('typescript')
    },
  },
  {
    title: 'a core operation removal',
    code: 'schema_invalid',
    apply: (input: DagCodeInput) => {
      input.preset.operations = { remove: ['Inbox'] }
    },
    kept: (parameters: Record<string, unknown>) => {
      expect(record(parameters.operations).remove).toEqual(['Inbox'])
    },
  },
])('refuses $title without dropping the submitted value', ({ code, feature, apply, kept }) => {
  const input = baseInput()
  apply(input)
  const result = selectDagCode(input)
  expect(result.status).toBe('refused')
  expect(result.digest).toBeNull()
  expect(
    result.diagnostics.some(
      (item) => item.code === code && (feature === undefined || item.feature === feature),
    ),
  ).toBe(true)
  kept(result.parameters)
})

it('keeps a schema-valid quality field refused rather than treating schema success as admission', () => {
  const input = baseInput()
  input.preset.quality = { deviation_max: 0.2 }
  const result = selectDagCode(input)
  expect(validateRuntime('DefaultSessionParameters', result.parameters).ok).toBe(true)
  expect(result.status).toBe('refused')
  expect(result.parameters.quality).toEqual({ deviation_max: 0.2 })
})

it('refuses extending a parent and keeps the inherited quality and refine', () => {
  const input = baseInput()
  input.preset.extends = 'base'
  input.preset.quality = { deviation_max: 0.2 }
  input.parent = {
    name: 'base',
    quality: { deviation_max: 0.4 },
    harness: { auto_refine: { enabled: true } },
    budget: { max_steps: 40 },
    verifier: { timeout_ms: 30_000, default_tier: 0 },
  }
  const result = selectDagCode(input)
  expect(result.status).toBe('refused')
  expect(result.digest).toBeNull()
  expect(result.diagnostics.some((item) => item.code === 'extends_forbidden')).toBe(true)
  expect(result.inherited?.quality).toEqual({ deviation_max: 0.4 })
  expect(record(result.inherited?.harness).auto_refine).toEqual({ enabled: true })
  expect(result.inherited?.budget).toEqual({ max_steps: 40 })
  expect(result.parameters.quality).toEqual({ deviation_max: 0.2 })
  expect(record(result.parameters.budget).max_steps).toBe(7)
})

it('refuses a different provider instead of retargeting the combination', () => {
  const input = baseInput()
  input.selection.providerId = 'agh.default/loop'
  const result = selectDagCode(input)
  expect(result.status).toBe('refused')
  expect(result.providerId).toBe('agh.default/loop')
  expect(result.diagnostics.some((item) => item.feature === 'agh.reference/loop')).toBe(true)
})

it('refuses a decision budget above the profile ceiling and keeps the requested limit', () => {
  const over = baseInput()
  over.preset.budget = { max_steps: 11 }
  over.profile = { maxSteps: 10 }
  const refused = selectDagCode(over)
  expect(refused.status).toBe('refused')
  expect(refused.diagnostics.some((item) => item.code === 'ceiling_exceeded')).toBe(true)
  expect(record(refused.parameters.budget).max_steps).toBe(11)

  const fit = baseInput()
  fit.preset.budget = { max_steps: 10 }
  fit.profile = { maxSteps: 10 }
  const accepted = selectDagCode(fit)
  expect(accepted.status).toBe('accepted')
  expect(record(accepted.parameters.budget).max_steps).toBe(10)
})

it('refuses the minimum combination when the profile requires quality or refine', () => {
  const quality = selectDagCode({ ...baseInput(), profile: { requiresQuality: true } })
  expect(quality.status).toBe('refused')
  expect(
    quality.diagnostics.some(
      (item) => item.code === 'profile_requires_capability' && item.feature === 'quality',
    ),
  ).toBe(true)
  expect(record(record(quality.parameters.harness).auto_refine).enabled).toBe(false)

  const refine = selectDagCode({ ...baseInput(), profile: { requiresRefine: true } })
  expect(refine.status).toBe('refused')
  expect(refine.diagnostics.some((item) => item.feature === 'agnes/refine')).toBe(true)
  expect(record(record(refine.parameters.harness).auto_refine).enabled).toBe(false)
})

it('refuses a code prompt section the loop does not contribute', () => {
  const input = baseInput()
  input.loop.codePromptSections = ['persona']
  const result = selectDagCode(input)
  expect(result.status).toBe('refused')
  const missing = result.diagnostics
    .filter((item) => item.feature === 'code:prompts')
    .map((item) => item.path)
  expect(missing).toEqual([
    '/code-prompts/environment',
    '/code-prompts/code-doctrine',
    '/code-prompts/tools:sdk',
  ])
  expect(result.parameters.disclosure).toBe('code')
  expect(record(result.parameters.tools).core).toEqual(['run_code'])
})

it('refuses an effective preset whose required slot and quality are unsupported', () => {
  const original = {
    name: 'code-preset',
    extends: 'base',
    model: {
      route: {
        primary: { route: 'main', model: 'code-model' },
        verifier: { route: 'main', model: 'judge' },
      },
    },
    quality: { deviation_max: 0.2 },
    budget: { max_steps: 12 },
    repair: { max_rounds: 5 },
  }
  const before = structuredClone(original)
  const refused = assessPresetSupport({
    name: 'code-preset',
    document: original,
    features: ['legacy-primary-decision-budget.v1', 'legacy-tool-result-control.v1'],
  })
  expect(original).toEqual(before)
  expect(refused.status).toBe('refused')
  expect(refused.presetName).toBe('code-preset')
  expect(refused.parameters).toEqual(before)
  expect(refused.documentDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(refused.missing.map((item) => item.feature)).toEqual([
    'quality',
    'loop-quality:step-verifier',
    'loop-quality:repair',
  ])
  expect(refused.diagnostics.every((item) => item.source === 'code-preset')).toBe(true)
  expect(record(record(record(refused.parameters.model).route).verifier).model).toBe('judge')
  expect(record(refused.parameters.budget).max_steps).toBe(12)

  const selected = selectDagCode(baseInput())
  expect(selected.status).toBe('accepted')
  expect(selected.presetId).toBe('dag-code')
  expect(selected.parameters).not.toHaveProperty('quality')
  expect(refused.parameters).toEqual(before)

  const rewritten = selectDagCode({
    ...baseInput(),
    preset: original,
  })
  expect(rewritten.status).toBe('refused')
  expect(rewritten.presetId).toBe('code-preset')
  expect(rewritten.digest).toBeNull()
  expect(rewritten.parameters.quality).toEqual({ deviation_max: 0.2 })
  expect(record(record(record(rewritten.parameters.model).route).verifier).model).toBe('judge')
  expect(record(rewritten.parameters.budget).max_steps).toBe(12)
})

it('accepts the same effective preset once the loop declares its features', () => {
  const original = {
    name: 'code-preset',
    extends: 'base',
    quality: { deviation_max: 0.2 },
    budget: { max_steps: 12 },
    model: { route: { verifier: { route: 'main', model: 'judge' } } },
    repair: { max_rounds: 5 },
  }
  const accepted = assessPresetSupport({
    name: 'code-preset',
    document: original,
    features: [
      'legacy-primary-decision-budget.v1',
      'quality',
      'loop-quality:step-verifier',
      'loop-quality:repair',
    ],
  })
  expect(accepted.status).toBe('accepted')
  expect(accepted.missing).toEqual([])
  expect(accepted.parameters).toEqual(original)
  expect(accepted.parameters.extends).toBe('base')
  expect(accepted.presetName).toBe('code-preset')
})
