import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type AcpPermissionKind,
  automaticPermissionDecision,
  fromAcpOptionKind,
  OFFERED_OPTION_KINDS,
  STOP_REASON_TABLE,
  toAcpOptionKind,
  toAcpStopReason,
} from '../src/index.js'

describe('codec', () => {
  it.each([
    ['completed', 'end_turn'],
    ['max_steps', 'max_turn_requests'],
    ['aborted', 'cancelled'],
    ['interrupted', 'cancelled'],
    ['budget', 'refusal'],
    ['blocked', 'end_turn'],
    ['parked', 'end_turn'],
  ] as const)('turn/end %s → %s', (reason, stop) => {
    expect(toAcpStopReason(reason)).toBe(stop)
  })
  it('error is not a stop reason', () => {
    expect(() => toAcpStopReason('error' as never)).toThrow()
  })
  it('maps approval verdicts both ways', () => {
    expect(toAcpOptionKind('allowed-once')).toBe('allow_once')
    expect(toAcpOptionKind('allowed-session')).toBe('allow_always')
    expect(toAcpOptionKind('rejected')).toBe('reject_once')
    expect(fromAcpOptionKind('reject_always')).toBe('rejected')
    expect(fromAcpOptionKind('allow_always')).toBe('allowed-session')
    expect(OFFERED_OPTION_KINDS).toEqual(['allow_once', 'allow_always', 'reject_once'])
  })
})

// ── Runtime binding between the codec value tables and the schemas ──────────────────────────
// The compile-time half is carried by src/codec/*.ts taking its types straight from the generated
// module: adding a value to a schema leaves STOP_REASON_TABLE's Record missing a key and typecheck
// goes red. These cases add the runtime half, comparing both directions by **reading the two schema
// files directly** — the same approach used for METHOD_DEF.
// The experiment that motivated them: appending a ninth value to the schema's TurnEnd.reason.enum and
// re-running gen left 383 passed with nothing red. The three cases below exist so that experiment
// necessarily goes red.
const sessionDoc = JSON.parse(
  readFileSync(new URL('../schema/session-v1.json', import.meta.url), 'utf8'),
) as { $defs: { TurnEnd: { properties: { reason: { enum: string[] } } } } }
const acpDoc = JSON.parse(readFileSync(new URL('../schema/acp/schema.json', import.meta.url), 'utf8')) as {
  $defs: Record<string, { oneOf?: Array<{ const?: string }> }>
}
const constsOf = (name: string): string[] =>
  (acpDoc.$defs[name]?.oneOf ?? []).map((b) => String(b.const)).sort()

describe('codec value tables ↔ schema', () => {
  it('STOP_REASON_TABLE covers exactly TurnEnd.reason.enum minus "error" (both directions)', () => {
    const fromSchema = sessionDoc.$defs.TurnEnd.properties.reason.enum.filter((r) => r !== 'error').sort()
    expect(Object.keys(STOP_REASON_TABLE).sort()).toEqual(fromSchema)
  })

  it('every STOP_REASON_TABLE value is a real ACP StopReason', () => {
    const acpStopReasons = new Set(constsOf('StopReason'))
    expect(acpStopReasons.size).toBeGreaterThan(0) // do not silently become an empty set if upstream restructures
    for (const [reason, stop] of Object.entries(STOP_REASON_TABLE))
      expect(acpStopReasons.has(stop), `${reason} → ${stop}`).toBe(true)
  })

  it('fromAcpOptionKind is total over ACP PermissionOptionKind, and the offered subset is real', () => {
    const kinds = constsOf('PermissionOptionKind')
    expect(kinds.length).toBeGreaterThan(0)
    // Exhaustiveness: if upstream adds a kind and the switch does not follow, this yields undefined.
    for (const k of kinds) expect(fromAcpOptionKind(k as AcpPermissionKind), k).toBeDefined()
    for (const k of OFFERED_OPTION_KINDS) expect(kinds).toContain(k)
    // 'reject_always' is the one deliberately never offered to the user — it is only accepted when
    // received — so OFFERED is a proper subset.
    expect(OFFERED_OPTION_KINDS.length).toBeLessThan(kinds.length)
  })
})

// Full access is an explicit session choice; it never answers questions of fact or chosen modes.
it.each([
  'candidate.test',
  'plugin.publish',
  'memory',
  'credential.admin',
  'skills.install',
  'mcp.connect',
  'gate',
  'tool.permission',
])('automatically allows %s through the shared permission rule', (purpose) => {
  const actor = { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} }
  expect(automaticPermissionDecision({ policy: 'full-access', actor }, purpose)).toEqual({
    verdict: 'allowed-once',
    reason: 'full-access',
    answeredBy: { ...actor, role: 'system', attrs: { permissionPolicy: 'full-access' } },
  })
  for (const policy of ['workspace-write', 'read-only', 'standard', 'custom'])
    expect(automaticPermissionDecision({ policy, actor }, purpose)).toBeUndefined()
  for (const question of ['plan.exit', 'unknown-outcome', 'business.confirm', 'unrecognized.purpose'])
    expect(automaticPermissionDecision({ policy: 'full-access', actor }, question)).toBeUndefined()
  expect(
    automaticPermissionDecision({ policy: 'full-access', actor }, 'business.confirm', ['Proceed', 'Cancel']),
  ).toBeUndefined()
  expect(automaticPermissionDecision(undefined, purpose)).toBeUndefined()
})

it('auto-confirms only explicit business contracts for a human using the declared response value', () => {
  const actor = { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} }
  const presentation = {
    'zh-CN': { title: '签署', fields: [], responseValue: '我确认。' },
    en: { title: 'Sign', fields: [], responseValue: 'I confirm.' },
  }
  const options = ['rejected', 'allowed-once']
  expect(
    automaticPermissionDecision(
      { policy: 'full-access', actor },
      'business.confirm',
      options,
      'question',
      presentation,
    ),
  ).toMatchObject({
    verdict: 'allowed-once',
    responseValue: 'I confirm.',
    answeredBy: {
      id: 'owner',
      role: 'owner',
      attrs: { confirmationMode: 'auto-confirmed under full access' },
    },
  })
  for (const role of ['system', 'agent'])
    expect(
      automaticPermissionDecision(
        { policy: 'full-access', actor: { ...actor, role } },
        'business.confirm',
        options,
        'question',
        presentation,
      ),
    ).toBeUndefined()
  for (const purpose of ['ask_user', 'plan.exit', 'fact-check', 'author.question', 'unknown'])
    expect(
      automaticPermissionDecision(
        { policy: 'full-access', actor },
        purpose,
        options,
        'question',
        presentation,
      ),
    ).toBeUndefined()
  expect(
    automaticPermissionDecision(
      { policy: 'full-access', actor },
      'business.confirm',
      ['allowed-once', 'allowed-session', 'rejected'],
      'question',
      presentation,
    ),
  ).toBeUndefined()
})
