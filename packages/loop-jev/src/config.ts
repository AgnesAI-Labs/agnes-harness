import type { JevLoopConfig } from './types.js'

export const DEFAULT_CONFIG: Readonly<JevLoopConfig> = Object.freeze({
  jev: Object.freeze({
    route: 'jev',
    model: 'typesafe/jev-1.13-20260917',
    deadlineMs: 15000,
    maxRetries: 2,
  }),
  llmMaxAttempts: 2,
  thresholds: Object.freeze({
    escalate: 0.5,
    externalWriteMin: 0.6,
    ambiguityGate: 0.4,
    answerProgressFloor: null,
  }),
  stepCap: 30,
  stateTokenBudget: 24000,
  requestTokenBudget: 48000,
})

type Field =
  | { kind: 'string' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'number'; min: number; max: number; nullable?: boolean }

type Group = { [key: string]: Field }

const SCHEMA = {
  jev: {
    route: { kind: 'string' },
    model: { kind: 'string' },
    deadlineMs: { kind: 'int', min: 1000, max: 120000 },
    maxRetries: { kind: 'int', min: 0, max: 3 },
  },
  llmMaxAttempts: { kind: 'int', min: 1, max: 5 },
  thresholds: {
    escalate: { kind: 'number', min: 0, max: 1 },
    externalWriteMin: { kind: 'number', min: 0, max: 1 },
    ambiguityGate: { kind: 'number', min: 0, max: 1, nullable: true },
    answerProgressFloor: { kind: 'number', min: 0, max: 3, nullable: true },
  },
  stepCap: { kind: 'int', min: 1, max: 200 },
  stateTokenBudget: { kind: 'int', min: 4000, max: 30000 },
  requestTokenBudget: { kind: 'int', min: 8000, max: 60000 },
} satisfies { [key: string]: Field | Group }

const invalid = (path: string): never => {
  throw new Error(`Invalid agnes.jev configuration at ${path}`)
}

const isRecord = (value: unknown): value is { [key: string]: unknown } =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function checkField(field: Field, value: unknown, path: string): string | number | null {
  if (field.kind === 'string') return typeof value === 'string' && value !== '' ? value : invalid(path)
  if (value === null && field.kind === 'number' && field.nullable) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(path)
  if (field.kind === 'int' && !Number.isSafeInteger(value)) return invalid(path)
  return value >= field.min && value <= field.max ? value : invalid(path)
}

function isField(entry: Field | Group): entry is Field {
  return typeof entry.kind === 'string'
}

/**
 * Merge user input over the defaults, one key at a time (two levels). Unknown keys, wrong types and
 * out-of-range values throw an error naming the dotted key.
 */
export function resolveConfig(input: unknown): JevLoopConfig {
  const merged = structuredClone(DEFAULT_CONFIG) as unknown as { [key: string]: unknown }
  if (input === undefined || input === null) return merged as unknown as JevLoopConfig
  if (!isRecord(input)) return invalid('config')
  const schema: { [key: string]: Field | Group } = SCHEMA
  for (const key of Object.keys(input)) if (!Object.hasOwn(schema, key)) invalid(key)
  for (const [key, entry] of Object.entries(schema)) {
    const value = input[key]
    if (value === undefined) continue
    if (isField(entry)) {
      merged[key] = checkField(entry, value, key)
      continue
    }
    if (!isRecord(value)) invalid(key)
    const group = merged[key] as { [key: string]: unknown }
    for (const sub of Object.keys(value as object)) if (!Object.hasOwn(entry, sub)) invalid(`${key}.${sub}`)
    for (const [sub, field] of Object.entries(entry)) {
      const raw = (value as { [key: string]: unknown })[sub]
      if (raw !== undefined) group[sub] = checkField(field, raw, `${key}.${sub}`)
    }
  }
  return merged as unknown as JevLoopConfig
}
