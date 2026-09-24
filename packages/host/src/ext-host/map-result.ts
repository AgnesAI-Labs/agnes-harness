/** Map an author result without adding a microtask to synchronous callbacks. */
export function mapResult<T>(value: unknown, map: (value: unknown) => T): T | Promise<T> {
  const then =
    value && (typeof value === 'object' || typeof value === 'function')
      ? (value as { then?: unknown }).then
      : undefined
  if (typeof then !== 'function') return map(value)
  return new Promise<unknown>((resolve, reject) => {
    Reflect.apply(then, value, [resolve, reject])
  }).then(map)
}
