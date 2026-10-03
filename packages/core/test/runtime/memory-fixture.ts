/** Runtime-only tooling loader; each test declares the contracts it consumes. */
export async function loadMemoryBindings<T>(): Promise<T> {
  const url = new URL('../../../../tools/acceptance/runtime/platform/memory-conformance.ts', import.meta.url)
  return import(url.href)
}
