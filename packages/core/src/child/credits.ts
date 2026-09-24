import { CoreError } from '../types.js'

export const MICROCREDITS_PER_CREDIT = 1_000_000n

function assertFiniteNonNegative(credits: number, label: string): void {
  if (typeof credits !== 'number' || Number.isNaN(credits) || !Number.isFinite(credits) || credits < 0)
    throw new CoreError('E_BUDGET', `${label} must be a finite non-negative number`, { credits })
}

function scaledInteger(credits: number, mode: 'floor' | 'ceil'): bigint {
  assertFiniteNonNegative(credits, 'credits')
  const scaled = credits * 1_000_000
  if (!Number.isFinite(scaled)) throw new CoreError('E_BUDGET', 'credit conversion overflow', { credits })
  const rounded = mode === 'floor' ? Math.floor(scaled) : Math.ceil(scaled)
  if (!Number.isSafeInteger(rounded))
    throw new CoreError('E_BUDGET', 'credit conversion overflow', { credits })
  return BigInt(rounded)
}

/** Caps round down. A positive value that floors to 0 is refused rather than treated as free. */
export function capToMicrocredits(credits: number): bigint {
  assertFiniteNonNegative(credits, 'tree budget cap')
  if (credits <= 0)
    throw new CoreError('E_BUDGET', 'tree budget cap must be a finite positive number', { credits })
  const micro = scaledInteger(credits, 'floor')
  if (micro <= 0n) throw new CoreError('E_BUDGET', 'tree budget cap rounds to zero', { credits })
  return micro
}

/** Charges and holds round up so the reservation is conservative. */
export function chargeToMicrocredits(credits: number): bigint {
  return scaledInteger(credits, 'ceil')
}

/** Coarse upper bound: one token per JSON code unit, covering tools and other wire fields. */
export function conservativeSerializedTokens(value: unknown): number {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    json = undefined
  }
  if (typeof json !== 'string' || !Number.isSafeInteger(json.length))
    throw new CoreError('E_BUDGET', 'billable request content cannot be serialized')
  return json.length
}

/** Catalogue prices are credits per million tokens. */
export function conservativeModelCredits(
  inputTokens: number,
  maxTokens: number,
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const input = Math.max(0, inputTokens)
  const output = Math.max(0, maxTokens)
  const raw = (input * cost.input + output * cost.output + input * Math.max(0, cost.cacheWrite)) / 1_000_000
  if (!Number.isFinite(raw) || raw < 0) throw new CoreError('E_BUDGET', 'conservative fee is not finite')
  return raw
}

export function addMicro(a: bigint, b: bigint): bigint {
  const sum = a + b
  if (a > 0n && b > 0n && sum < a) throw new CoreError('E_BUDGET', 'microcredit addition overflow')
  if (sum < 0n) throw new CoreError('E_BUDGET', 'microcredit addition underflow')
  return sum
}

export function fitsCap(settled: bigint, held: bigint, q: bigint, cap: bigint): boolean {
  if (q < 0n || settled < 0n || held < 0n || cap <= 0n) return false
  return settled + held + q <= cap
}
