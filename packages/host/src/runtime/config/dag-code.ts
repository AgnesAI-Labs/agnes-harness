// Explicit dag-code selection over the published session-parameter schema.
// An older preset is reported intact; it is never rewritten into this combination.

import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { MAX_STEPS_FEATURE } from './legacy-fields.js'

export const DAG_CODE_ID = 'dag-code'
export const DAG_CODE_PROVIDER_ID = 'agh.reference/loop'
export const TOOL_RESULT_CONTROL_FEATURE = 'legacy-tool-result-control.v1'
export const REFINE_OPERATION = 'agnes/refine'
export const CODE_PROMPT_OPERATION = 'code:prompts'
export const RUN_CODE_TOOL = 'run_code'
export const CODE_PROMPT_SECTIONS = ['persona', 'environment', 'code-doctrine', 'tools:sdk'] as const

const REQUIRED_FEATURES = [MAX_STEPS_FEATURE, TOOL_RESULT_CONTROL_FEATURE] as const
const RESERVED_PRESET_KEYS = new Set(['name', 'extends', 'revision'])
const ALLOWED_PARAMETERS = new Set([
  'model',
  'disclosure',
  'tools',
  'code_runtime',
  'budget',
  'approval',
  'sandbox',
  'checkpoint',
  'compaction',
  'subagent',
  'recovery',
  'operations',
  'harness',
  'completion_gate',
  'hooks',
])
const INHERITED_KEYS = [
  'quality',
  'harness',
  'verifier',
  'repair',
  'loop',
  'completion_gate',
  'budget',
  'model',
] as const

export type DagCodeDiagnosticCode =
  | 'missing_capability'
  | 'unsupported_parameter'
  | 'extends_forbidden'
  | 'provider_not_selected'
  | 'safety_disabled'
  | 'schema_invalid'
  | 'profile_requires_capability'
  | 'ceiling_exceeded'

export type DagCodeDiagnostic = {
  code: DagCodeDiagnosticCode
  path: string
  message: string
  feature?: string
  source?: string
}

export type DagCodeLoop = {
  features: readonly string[]
  tools: readonly string[]
  codePromptSections: readonly string[]
  languages: readonly string[]
  states: readonly string[]
  isolations?: readonly string[]
  hooks?: readonly string[]
}

export type DagCodeProfileConstraint = {
  requiresQuality?: boolean
  requiresRefine?: boolean
  maxSteps?: number
}

export type DagCodeInput = {
  preset: Record<string, unknown>
  parent?: Record<string, unknown>
  selection: { packageId: string; providerId: string }
  loop: DagCodeLoop
  profile?: DagCodeProfileConstraint
}

export type DagCodeResult = {
  status: 'accepted' | 'refused'
  presetId: string
  providerId: string
  packageId: string
  parameters: Record<string, unknown>
  features: string[]
  diagnostics: DagCodeDiagnostic[]
  digest: string | null
  inherited: Record<string, unknown> | null
}

export type PresetSupport = {
  status: 'accepted' | 'refused'
  presetName: string
  parameters: Record<string, unknown>
  documentDigest: string
  missing: { feature: string; path: string }[]
  diagnostics: DagCodeDiagnostic[]
}

const json = (value: unknown): Parameters<typeof canonicalJsonDigest>[0] =>
  JSON.parse(JSON.stringify(value)) as Parameters<typeof canonicalJsonDigest>[0]

function digest(value: unknown): string {
  return canonicalJsonDigest(json(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function diagnostic(
  code: DagCodeDiagnosticCode,
  path: string,
  message: string,
  extra?: { feature?: string; source?: string },
): DagCodeDiagnostic {
  const item: DagCodeDiagnostic = { code, path, message }
  if (extra?.feature !== undefined) item.feature = extra.feature
  if (extra?.source !== undefined) item.source = extra.source
  return item
}

function sessionParameters(preset: Record<string, unknown>): Record<string, unknown> {
  const parameters: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(preset)) {
    if (RESERVED_PRESET_KEYS.has(key)) continue
    parameters[key] = structuredClone(value)
  }
  return parameters
}

function inheritedFrom(parent: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!parent) return null
  const inherited: Record<string, unknown> = {}
  for (const key of INHERITED_KEYS) {
    if (Object.hasOwn(parent, key)) inherited[key] = structuredClone(parent[key])
  }
  return inherited
}

function hasOnlyEnabledFalse(value: unknown): boolean {
  if (!isRecord(value) || value.enabled !== false) return false
  return Object.keys(value).every((key) => key === 'enabled')
}

function checkSelection(input: DagCodeInput, diagnostics: DagCodeDiagnostic[]): void {
  if (input.selection.providerId !== DAG_CODE_PROVIDER_ID) {
    diagnostics.push(
      diagnostic(
        'provider_not_selected',
        '/selection/providerId',
        `provider must be ${DAG_CODE_PROVIDER_ID}`,
        { feature: DAG_CODE_PROVIDER_ID, source: DAG_CODE_ID },
      ),
    )
  }
  if (input.selection.packageId === '') {
    diagnostics.push(
      diagnostic('provider_not_selected', '/selection/packageId', 'package id is required', {
        source: DAG_CODE_ID,
      }),
    )
  }
}

function checkIdentity(preset: Record<string, unknown>, diagnostics: DagCodeDiagnostic[]): void {
  if (preset.name !== DAG_CODE_ID) {
    diagnostics.push(
      diagnostic('unsupported_parameter', '/name', 'the explicit combination id is dag-code', {
        source: typeof preset.name === 'string' ? preset.name : DAG_CODE_ID,
      }),
    )
  }
  if (typeof preset.extends === 'string') {
    diagnostics.push(
      diagnostic(
        'extends_forbidden',
        '/extends',
        'dag-code does not extend a parent and does not drop inherited quality or refine',
        { source: typeof preset.name === 'string' ? preset.name : DAG_CODE_ID },
      ),
    )
  }
}

function checkClosedParameters(parameters: Record<string, unknown>, diagnostics: DagCodeDiagnostic[]): void {
  for (const key of Object.keys(parameters)) {
    if (ALLOWED_PARAMETERS.has(key)) continue
    diagnostics.push(
      diagnostic(
        'unsupported_parameter',
        `/${key}`,
        `${key} is not a parameter of the minimum combination and is left unchanged`,
        { source: DAG_CODE_ID },
      ),
    )
  }
}

function checkCodeCapability(
  parameters: Record<string, unknown>,
  loop: DagCodeLoop,
  diagnostics: DagCodeDiagnostic[],
): void {
  if (parameters.disclosure !== 'code') {
    diagnostics.push(
      diagnostic('missing_capability', '/disclosure', 'disclosure must be code', {
        feature: 'disclosure=code',
        source: DAG_CODE_ID,
      }),
    )
  }
  const route =
    isRecord(parameters.model) && isRecord(parameters.model.route) ? parameters.model.route : undefined
  const primary = route && isRecord(route.primary) ? route.primary : undefined
  if (
    typeof primary?.route !== 'string' ||
    primary.route === '' ||
    typeof primary.model !== 'string' ||
    primary.model === ''
  ) {
    diagnostics.push(
      diagnostic('missing_capability', '/model/route/primary', 'missing feature model.route.primary', {
        feature: 'model.route.primary',
        source: DAG_CODE_ID,
      }),
    )
  }
  if (route) {
    for (const slot of Object.keys(route)) {
      if (slot === 'primary') continue
      diagnostics.push(
        diagnostic(
          'unsupported_parameter',
          `/model/route/${slot}`,
          `the minimum combination does not select slot ${slot}`,
          { feature: `model-slot:${slot}`, source: DAG_CODE_ID },
        ),
      )
    }
  }
  const tools = isRecord(parameters.tools) ? parameters.tools : undefined
  const core = Array.isArray(tools?.core) ? tools.core : []
  if (!core.includes(RUN_CODE_TOOL)) {
    diagnostics.push(
      diagnostic('missing_capability', '/tools/core', 'missing feature run_code', {
        feature: RUN_CODE_TOOL,
        source: DAG_CODE_ID,
      }),
    )
  }
  for (const tool of core) {
    if (typeof tool === 'string' && !loop.tools.includes(tool)) {
      diagnostics.push(
        diagnostic('missing_capability', '/tools/core', `missing feature ${tool}`, {
          feature: tool,
          source: DAG_CODE_ID,
        }),
      )
    }
  }
  const runtime = isRecord(parameters.code_runtime) ? parameters.code_runtime : undefined
  if (!runtime) {
    diagnostics.push(
      diagnostic('missing_capability', '/code_runtime', 'missing feature code_runtime', {
        feature: 'code_runtime',
        source: DAG_CODE_ID,
      }),
    )
  } else {
    if (typeof runtime.language !== 'string' || !loop.languages.includes(runtime.language)) {
      diagnostics.push(
        diagnostic(
          'missing_capability',
          '/code_runtime/language',
          `unsupported language ${String(runtime.language)}`,
          {
            feature: 'code_runtime.language',
            source: DAG_CODE_ID,
          },
        ),
      )
    }
    if (typeof runtime.state !== 'string' || !loop.states.includes(runtime.state)) {
      diagnostics.push(
        diagnostic(
          'missing_capability',
          '/code_runtime/state',
          `unsupported state ${String(runtime.state)}`,
          {
            feature: 'code_runtime.state',
            source: DAG_CODE_ID,
          },
        ),
      )
    }
    if (runtime.isolation !== undefined) {
      const isolations = loop.isolations ?? []
      if (typeof runtime.isolation !== 'string' || !isolations.includes(runtime.isolation)) {
        diagnostics.push(
          diagnostic(
            'missing_capability',
            '/code_runtime/isolation',
            `unsupported isolation ${String(runtime.isolation)}`,
            { feature: 'code_runtime.isolation', source: DAG_CODE_ID },
          ),
        )
      }
    }
  }
  for (const section of CODE_PROMPT_SECTIONS) {
    if (loop.codePromptSections.includes(section)) continue
    diagnostics.push(
      diagnostic('missing_capability', `/code-prompts/${section}`, `missing code prompt section ${section}`, {
        feature: CODE_PROMPT_OPERATION,
        source: DAG_CODE_ID,
      }),
    )
  }
}

function checkBudgetAndSafety(
  parameters: Record<string, unknown>,
  profile: DagCodeProfileConstraint | undefined,
  diagnostics: DagCodeDiagnostic[],
): void {
  const budget = isRecord(parameters.budget) ? parameters.budget : undefined
  const maxSteps = budget?.max_steps
  if (typeof maxSteps !== 'number' || !Number.isInteger(maxSteps) || maxSteps < 1) {
    diagnostics.push(
      diagnostic(
        'missing_capability',
        '/budget/max_steps',
        'budget.max_steps must be an explicit positive limit',
        {
          feature: MAX_STEPS_FEATURE,
          source: DAG_CODE_ID,
        },
      ),
    )
  } else if (typeof profile?.maxSteps === 'number' && maxSteps > profile.maxSteps) {
    diagnostics.push(
      diagnostic('ceiling_exceeded', '/budget/max_steps', 'budget.max_steps widens the profile ceiling', {
        feature: MAX_STEPS_FEATURE,
        source: DAG_CODE_ID,
      }),
    )
  }
  const sandbox = isRecord(parameters.sandbox) ? parameters.sandbox : undefined
  if (sandbox?.required === false) {
    diagnostics.push(
      diagnostic('safety_disabled', '/sandbox/required', 'required sandbox cannot be turned off', {
        source: DAG_CODE_ID,
      }),
    )
  }
  if (sandbox?.on_unavailable === 'allow') {
    diagnostics.push(
      diagnostic('safety_disabled', '/sandbox/on_unavailable', 'sandbox cannot fail open', {
        source: DAG_CODE_ID,
      }),
    )
  }
}

function checkMinimumRecipe(parameters: Record<string, unknown>, diagnostics: DagCodeDiagnostic[]): void {
  const operations = isRecord(parameters.operations) ? parameters.operations : undefined
  const remove = operations?.remove
  if (Array.isArray(remove) && remove.includes(CODE_PROMPT_OPERATION)) {
    diagnostics.push(
      diagnostic(
        'missing_capability',
        '/operations/remove',
        'code prompts cannot be removed to hide a missing before-inference contribution',
        { feature: CODE_PROMPT_OPERATION, source: DAG_CODE_ID },
      ),
    )
  }
  const exactRefine = Array.isArray(remove) && remove.length === 1 && remove[0] === REFINE_OPERATION
  if (!exactRefine) {
    diagnostics.push(
      diagnostic(
        'unsupported_parameter',
        '/operations/remove',
        'the minimum combination removes only agnes/refine',
        { source: DAG_CODE_ID },
      ),
    )
  }
  if (operations && Object.hasOwn(operations, 'replace')) {
    diagnostics.push(
      diagnostic(
        'unsupported_parameter',
        '/operations/replace',
        'the minimum combination does not replace operations',
        { source: DAG_CODE_ID },
      ),
    )
  }
  const harness = isRecord(parameters.harness) ? parameters.harness : undefined
  if (!hasOnlyEnabledFalse(harness?.auto_refine)) {
    diagnostics.push(
      diagnostic(
        'unsupported_parameter',
        '/harness/auto_refine',
        'the minimum combination sets auto_refine.enabled to false and no other refine parameter',
        { feature: REFINE_OPERATION, source: DAG_CODE_ID },
      ),
    )
  }
  if (!hasOnlyEnabledFalse(parameters.completion_gate)) {
    diagnostics.push(
      diagnostic(
        'unsupported_parameter',
        '/completion_gate',
        'the minimum combination sets completion_gate.enabled to false and no other gate parameter',
        { feature: 'loop-quality:completion-gate', source: DAG_CODE_ID },
      ),
    )
  }
}

function checkDeclaredLoop(
  parameters: Record<string, unknown>,
  loop: DagCodeLoop,
  profile: DagCodeProfileConstraint | undefined,
  diagnostics: DagCodeDiagnostic[],
): void {
  const declared = new Set(loop.features)
  for (const feature of REQUIRED_FEATURES) {
    if (declared.has(feature)) continue
    diagnostics.push(
      diagnostic('missing_capability', '/features', `missing feature ${feature}`, {
        feature,
        source: DAG_CODE_ID,
      }),
    )
  }
  const hooks = Array.isArray(parameters.hooks) ? parameters.hooks : []
  const supportedHooks = new Set(loop.hooks ?? [])
  for (const hook of hooks) {
    if (typeof hook === 'string' && supportedHooks.has(hook)) continue
    const name = typeof hook === 'string' ? hook : 'unknown'
    diagnostics.push(
      diagnostic('missing_capability', '/hooks', `missing feature hook:${name}`, {
        feature: `hook:${name}`,
        source: DAG_CODE_ID,
      }),
    )
  }
  if (profile?.requiresQuality) {
    diagnostics.push(
      diagnostic(
        'profile_requires_capability',
        '/quality',
        'profile requires quality; the minimum combination is not admitted',
        { feature: 'quality', source: DAG_CODE_ID },
      ),
    )
  }
  if (profile?.requiresRefine) {
    diagnostics.push(
      diagnostic(
        'profile_requires_capability',
        '/harness/auto_refine',
        'profile requires refine; the minimum combination is not admitted',
        { feature: REFINE_OPERATION, source: DAG_CODE_ID },
      ),
    )
  }
}

function checkSchema(parameters: Record<string, unknown>, diagnostics: DagCodeDiagnostic[]): void {
  const validated = validateRuntime('DefaultSessionParameters', parameters)
  if (validated.ok) return
  for (const error of validated.errors) {
    diagnostics.push(
      diagnostic(
        'schema_invalid',
        error.path || '/',
        `session parameters failed validation (${error.code})`,
        {
          source: DAG_CODE_ID,
        },
      ),
    )
  }
}

export function selectDagCode(input: DagCodeInput): DagCodeResult {
  const parameters = sessionParameters(input.preset)
  const diagnostics: DagCodeDiagnostic[] = []
  const inherited = typeof input.preset.extends === 'string' ? inheritedFrom(input.parent) : null
  checkIdentity(input.preset, diagnostics)
  checkSelection(input, diagnostics)
  checkClosedParameters(parameters, diagnostics)
  checkCodeCapability(parameters, input.loop, diagnostics)
  checkBudgetAndSafety(parameters, input.profile, diagnostics)
  checkMinimumRecipe(parameters, diagnostics)
  checkDeclaredLoop(parameters, input.loop, input.profile, diagnostics)
  checkSchema(parameters, diagnostics)
  const accepted = diagnostics.length === 0
  const features = accepted ? [...REQUIRED_FEATURES] : []
  return {
    status: accepted ? 'accepted' : 'refused',
    presetId: typeof input.preset.name === 'string' ? input.preset.name : '',
    providerId: input.selection.providerId,
    packageId: input.selection.packageId,
    parameters,
    features,
    diagnostics,
    digest: accepted
      ? digest({
          presetId: DAG_CODE_ID,
          providerId: input.selection.providerId,
          packageId: input.selection.packageId,
          parameters,
          features,
        })
      : null,
    inherited,
  }
}

function capabilityNeeds(document: Record<string, unknown>): { feature: string; path: string }[] {
  const needs: { feature: string; path: string }[] = []
  const budget = isRecord(document.budget) ? document.budget : undefined
  if (typeof budget?.max_steps === 'number') {
    needs.push({ feature: MAX_STEPS_FEATURE, path: '/budget/max_steps' })
  }
  if (isRecord(document.quality)) needs.push({ feature: 'quality', path: '/quality' })
  if (isRecord(document.verifier)) needs.push({ feature: 'loop-quality:step-verifier', path: '/verifier' })
  const route = isRecord(document.model) && isRecord(document.model.route) ? document.model.route : undefined
  if (route) {
    for (const slot of Object.keys(route)) {
      if (slot === 'primary') continue
      needs.push({
        feature: slot === 'verifier' ? 'loop-quality:step-verifier' : `model-slot:${slot}`,
        path: `/model/route/${slot}`,
      })
    }
  }
  if (isRecord(document.repair)) needs.push({ feature: 'loop-quality:repair', path: '/repair' })
  const gate = isRecord(document.completion_gate) ? document.completion_gate : undefined
  if (gate && gate.enabled !== false) {
    needs.push({ feature: 'loop-quality:completion-gate', path: '/completion_gate' })
  }
  if (isRecord(document.loop)) needs.push({ feature: 'loop', path: '/loop' })
  const autoRefine =
    isRecord(document.harness) && isRecord(document.harness.auto_refine)
      ? document.harness.auto_refine
      : undefined
  if (autoRefine?.enabled === true) needs.push({ feature: REFINE_OPERATION, path: '/harness/auto_refine' })
  if (Array.isArray(document.hooks)) {
    for (const hook of document.hooks) {
      if (typeof hook !== 'string') continue
      needs.push({ feature: `hook:${hook}`, path: '/hooks' })
    }
  }
  return needs
}

export function assessPresetSupport(input: {
  name: string
  document: Record<string, unknown>
  features: readonly string[]
}): PresetSupport {
  const parameters = structuredClone(input.document)
  const declared = new Set(input.features)
  const missing = capabilityNeeds(parameters).filter((need) => !declared.has(need.feature))
  const diagnostics = missing.map((need) =>
    diagnostic('missing_capability', need.path, `missing feature ${need.feature}`, {
      feature: need.feature,
      source: input.name,
    }),
  )
  return {
    status: missing.length === 0 ? 'accepted' : 'refused',
    presetName: input.name,
    parameters,
    documentDigest: digest(parameters),
    missing,
    diagnostics,
  }
}
