/**
 * Restricted fixtures for the previous session, approval, tool, code, preset and stdio behavior.
 * They carry inputs and fault points only. They do not call a default provider, and a structural
 * match is not behavioral equivalence.
 */

export interface RestrictedFixtureInput {
  readonly name: string
  readonly value: Readonly<Record<string, unknown>>
}

export interface RestrictedFixture {
  readonly name: string
  readonly kind: 'session' | 'approval' | 'package' | 'transport' | 'migration' | 'admission'
  readonly callsDefaultProvider: false
  readonly structuralAssertionIsEquivalence: false
  readonly inputs: readonly RestrictedFixtureInput[]
  readonly faultPoints: readonly string[]
}

export const LEGACY_PROFILE = {
  budget: { preflight: 'estimate', per_request_cap: null, on_exceed: 'quote', max_steps: 50 },
} as const

export const LEGACY_PRESET = {
  budget: { per_request_cap: 4000, max_steps: 80 },
  completion_gate: { enabled: false, min_items: 1 },
} as const

function fixture(
  name: string,
  kind: RestrictedFixture['kind'],
  inputs: readonly RestrictedFixtureInput[],
  faultPoints: readonly string[],
): RestrictedFixture {
  return {
    name,
    kind,
    callsDefaultProvider: false,
    structuralAssertionIsEquivalence: false,
    inputs,
    faultPoints,
  }
}

const profileFields = { profile: LEGACY_PROFILE, preset: LEGACY_PRESET }

export const LEGACY_FIXTURES: readonly RestrictedFixture[] = [
  fixture(
    'session-facts',
    'session',
    [{ name: 'visible-history', value: { turns: 1, tools: 1 } }],
    ['kill-mid-turn', 'retry-same-commit'],
  ),
  fixture(
    'default-approval',
    'approval',
    [{ name: 'grant-scope', value: { mode: 'manual' } }],
    ['expired-grant', 'cross-principal'],
  ),
  fixture(
    'operation-context',
    'package',
    [{ name: 'slot-order', value: { slots: ['before', 'after'] } }],
    ['unsupported-slot', 'conflicting-registration'],
  ),
  fixture(
    'legacy-tool-result',
    'package',
    [{ name: 'classify', value: { policyVersion: 'frozen', terminate: false } }],
    ['reclassify-after-restart', 'deferred-result'],
  ),
  fixture(
    'nested-code-bridge',
    'package',
    [{ name: 'run-code', value: { depth: 1 } }],
    ['parent-lost', 'duplicate-bridge'],
  ),
  fixture(
    'quality-gate',
    'package',
    [{ name: 'completion-gate', value: { enabled: false, min_items: 1 } }],
    ['false-verifier-pass', 'cancel-during-repair'],
  ),
  fixture(
    'builtin-seams',
    'package',
    [{ name: 'checkpoint', value: { beforeWrite: true } }],
    ['snapshot-failed', 'unsupported-capability'],
  ),
  fixture(
    'tool-directory',
    'package',
    [{ name: 'disclosure', value: { deferLoading: true } }],
    ['stale-directory', 'model-switch'],
  ),
  fixture(
    'session-control',
    'admission',
    [{ name: 'next-request', value: { command: 'set-preset' } }],
    ['same-id-different-input', 'restart'],
  ),
  fixture(
    'acp-stdio',
    'transport',
    [{ name: 'initialize', value: { transport: 'stdio' } }],
    ['disconnect', 'late-message'],
  ),
  fixture(
    'profile-preset-fields',
    'migration',
    [{ name: 'current-fields', value: profileFields }],
    ['unknown-field', 'lost-quota'],
  ),
  fixture(
    'hook-visibility',
    'admission',
    [{ name: 'receipt-before-view', value: { visible: false } }],
    ['transform-not-committed', 'cancel'],
  ),
  fixture(
    'command-admission',
    'admission',
    [{ name: 'same-key', value: { input: 'a' } }],
    ['different-input', 'cancel-race', 'fork-prefix', 'restart'],
  ),
  fixture(
    'acp-stdio-child',
    'transport',
    [
      {
        name: 'stdio-script',
        value: { steps: ['initialize', 'new', 'load', 'prompt', 'cancel', 'set-mode'] },
      },
    ],
    ['kill-child', 'restart', 'late-permission'],
  ),
  fixture(
    'profile-preset-migration',
    'migration',
    [
      { name: 'budget.max_steps', value: { from: 80, unit: 'steps' } },
      { name: 'budget.per_request_cap', value: { from: 4000, unit: 'tokens' } },
      { name: 'completion_gate.enabled', value: { from: false } },
      { name: 'completion_gate.min_items', value: { from: 1 } },
      { name: 'budget.unknown_cap', value: { diagnose: true } },
    ],
    ['unknown-field', 'restore'],
  ),
]

export function faultPoint(fixtureName: string, point: string): string {
  const found = LEGACY_FIXTURES.find((item) => item.name === fixtureName)
  if (found === undefined || !found.faultPoints.includes(point)) {
    throw new Error(`unknown fault point ${fixtureName} ${point}`)
  }
  return point
}
