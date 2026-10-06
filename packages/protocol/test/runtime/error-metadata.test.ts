import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RuntimeError } from '../../src/runtime/index.js'
import {
  RuntimeErrorDetails,
  RuntimeErrorHttpDefaults,
  runtimeErrorHttpStatus,
  validateRuntimeErrorDetail,
} from '../../src/runtime/index.js'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const SOURCE_ROOTS = [
  'packages/core/src/runtime',
  'packages/ai/src/runtime',
  'packages/host/src/runtime',
  'examples/runtime-reference/src',
]
const CODES = [
  'invalid_input',
  'denied',
  'incompatible',
  'quota',
  'cancelled',
  'timeout',
  'retryable',
  'unknown_effect',
  'conflict',
  'internal',
]

function sources(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path)
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [path] : []
  })
}

/** Every `'code', 'detail'` or `'detail', 'code'` literal pair in merged runtime code, by detail. */
function emittedPairs(): Map<string, Map<string, string[]>> {
  const alternation = CODES.join('|')
  const detail = "'([a-z][a-z0-9_]*)'"
  const codeFirst = new RegExp(`'(${alternation})'\\s*,\\s*${detail}`, 'g')
  const detailFirst = new RegExp(`${detail}\\s*,\\s*'(${alternation})'`, 'g')
  const found = new Map<string, Map<string, string[]>>()
  const note = (name: string, code: string, path: string) => {
    const codes = found.get(name) ?? new Map<string, string[]>()
    codes.set(code, [...(codes.get(code) ?? []), path])
    found.set(name, codes)
  }
  for (const path of SOURCE_ROOTS.flatMap(sources)) {
    const text = readFileSync(join(root, path), 'utf8')
    for (const match of text.matchAll(codeFirst)) note(match[2] as string, match[1] as string, path)
    for (const match of text.matchAll(detailFirst)) note(match[1] as string, match[2] as string, path)
  }
  return found
}

/**
 * Pairs the scan reports that the table does not follow. `unsupported` and `integrity` are real
 * disagreements: State refuses with internal and incompatible where the table says the other, and
 * the owner of that emitter decides which side moves. The others are string lists whose neighbours only look like a pair
 * (a code list next to a status word), not an emission.
 */
const KNOWN_SCAN_DISAGREEMENTS: Readonly<Record<string, readonly string[]>> = {
  unsupported: ['internal'],
  integrity: ['incompatible'],
  cancelled: ['denied', 'timeout'],
  revision_conflict: ['cancelled'],
}

describe('registered runtime error details', () => {
  const rules: Readonly<
    Record<string, { code: string; httpStatus: number; retryAdviceKinds: readonly string[] }>
  > = RuntimeErrorDetails

  it('keeps the ten error codes and gives every registered detail a legal classification shape', () => {
    expect(Object.keys(RuntimeErrorHttpDefaults).sort()).toEqual([...CODES].sort())
    for (const [name, rule] of Object.entries(rules)) {
      expect(name, name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(CODES, name).toContain(rule.code)
      expect(rule.httpStatus, name).toBeGreaterThanOrEqual(400)
      expect(rule.httpStatus, name).toBeLessThanOrEqual(599)
      // Only an unknown effect is reconciled, and an unknown effect is never anything else.
      expect(rule.retryAdviceKinds.includes('reconcile'), name).toBe(rule.code === 'unknown_effect')
      if (rule.code === 'unknown_effect') expect(rule.retryAdviceKinds, name).toEqual(['reconcile'])
    }
  })

  it('keeps the registered Model, Media, Loop and State families in the table', () => {
    const names = Object.keys(rules)
    for (const family of ['model_wire_', 'model_egress_', 'media_', 'loop_', 'state_', 'run_', 'wait_'])
      expect(
        names.some((name) => name.startsWith(family)),
        family,
      ).toBe(true)
    expect(rules.model_prepared_lost).toMatchObject({ code: 'incompatible', httpStatus: 409 })
    expect(rules.model_stream_unknown).toMatchObject({
      code: 'unknown_effect',
      retryAdviceKinds: ['reconcile'],
    })
    expect(rules.run_state).toMatchObject({ code: 'conflict', retryAdviceKinds: ['never'] })
  })

  it('agrees with the code each emitter names next to a registered detail', () => {
    const pairs = emittedPairs()
    const disagreements: string[] = []
    for (const [name, rule] of Object.entries(rules)) {
      const allowed = KNOWN_SCAN_DISAGREEMENTS[name] ?? []
      for (const [code, paths] of pairs.get(name) ?? [])
        if (code !== rule.code && !allowed.includes(code))
          disagreements.push(
            `${name}: registered ${rule.code}, emitted ${code} in ${[...new Set(paths)].join(', ')}`,
          )
    }
    expect(disagreements).toEqual([])
  })

  it('lists only scan disagreements that are still present', () => {
    const pairs = emittedPairs()
    for (const [name, codes] of Object.entries(KNOWN_SCAN_DISAGREEMENTS))
      for (const code of codes) expect(pairs.get(name)?.has(code), `${name}/${code}`).toBe(true)
  })

  it('classifies a registered detail by its table row and rejects a disagreeing code', () => {
    const error = (code: RuntimeError['code'], detailCode: string): RuntimeError => ({
      code,
      detailCode,
      message: 'refused',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'diagnostic',
    })
    expect(validateRuntimeErrorDetail(error('incompatible', 'model_prepared_lost')).ok).toBe(true)
    expect(runtimeErrorHttpStatus(error('incompatible', 'model_prepared_lost'))).toBe(409)
    expect(validateRuntimeErrorDetail(error('denied', 'model_prepared_lost')).ok).toBe(false)
    expect(validateRuntimeErrorDetail(error('retryable', 'model_wire_tools')).ok).toBe(false)
    expect(runtimeErrorHttpStatus(error('invalid_input', 'session_absent'))).toBe(404)
    // An unregistered detail keeps the conservative default of its code.
    expect(runtimeErrorHttpStatus(error('conflict', 'future_extension'))).toBe(409)
    const unknown: RuntimeError = {
      ...error('unknown_effect', 'model_stream_unknown'),
      retryAdvice: { kind: 'reconcile', ownerRef: { kind: 'reconciliation', id: 'owner' } },
    }
    expect(validateRuntimeErrorDetail(unknown).ok).toBe(true)
    expect(validateRuntimeErrorDetail({ ...unknown, code: 'timeout' }).ok).toBe(false)
    expect(validateRuntimeErrorDetail({ ...unknown, retryAdvice: { kind: 'never' } }).ok).toBe(false)
  })
  it('has no Model, Media or adapter source that builds an unknown effect with a final advice', () => {
    const owned = [
      'packages/core/src/runtime/model',
      'packages/core/src/runtime/media',
      'packages/core/src/runtime/providers/model.ts',
      'packages/core/src/runtime/providers/media.ts',
      'packages/ai/src/runtime/model-adapter',
      'packages/ai/src/runtime/providers/model-adapter.ts',
      'packages/host/src/runtime/model',
      'examples/runtime-reference/src/providers/model.ts',
      'examples/runtime-reference/src/providers/model-adapter.ts',
      'examples/runtime-reference/src/providers/media.ts',
    ]
    const files = owned.flatMap((path) => (path.endsWith('.ts') ? [path] : sources(path)))
    expect(files.length).toBeGreaterThan(20)
    // The scan is a text heuristic. The model deployment's refusal helper only builds denied or
    // incompatible errors; the 'unknown_effect' it mentions is the code of a ModelEgressError that the
    // adapter classifies, never a RuntimeError built with a final advice.
    const exempt = new Set(['packages/host/src/runtime/model/model-deployment.ts'])
    const offenders = files.filter((path) => {
      if (exempt.has(path)) return false
      const text = readFileSync(join(root, path), 'utf8')
      return (
        text.includes("'unknown_effect'") &&
        text.includes("retryAdvice: { kind: 'never' }") &&
        !text.includes("kind: 'reconcile'")
      )
    })
    expect(offenders).toEqual([])
  })
})
