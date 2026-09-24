const reserved = new Set(
  `False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type _ tools`.split(
    ' ',
  ),
)
export const PY_RESERVED: ReadonlySet<string> = Object.freeze({
  size: reserved.size,
  has: (name: string) => reserved.has(name),
  keys: () => reserved.keys(),
  values: () => reserved.values(),
  entries: () => reserved.entries(),
  [Symbol.iterator]: () => reserved[Symbol.iterator](),
  forEach: (callback: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown) =>
    reserved.forEach((value) => {
      callback.call(thisArg, value, value, PY_RESERVED)
    }),
})
export function pythonBinding(name: string): { binding: string; renamed: boolean } | null {
  const binding = name.replace(/[-.]/g, '_')
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(binding) ? { binding, renamed: binding !== name } : null
}
