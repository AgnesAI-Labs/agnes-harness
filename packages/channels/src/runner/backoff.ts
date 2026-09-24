export function* backoffDelays(
  options: { baseMs?: number; maxMs?: number; jitter?: () => number } = {},
): Generator<number, never, unknown> {
  const baseMs = options.baseMs ?? 1_000
  const maxMs = options.maxMs ?? 60_000
  const jitter = options.jitter ?? Math.random
  let exponent = 0

  while (true) {
    const raw = Math.min(maxMs, baseMs * 2 ** exponent)
    exponent++
    yield Math.round(raw * (0.8 + 0.4 * jitter()))
  }
}
