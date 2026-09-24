/** Only call after inspectJsonData has copied and validated the complete JSON tree. */
export function frozenJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozenJson(child)
    Object.freeze(value)
  }
  return value
}
