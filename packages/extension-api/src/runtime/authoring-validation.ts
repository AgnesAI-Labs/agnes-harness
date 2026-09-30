import { jcs } from '@agnes/protocol'

export function declarationError(message: string): never {
  throw new TypeError(`Invalid author declaration: ${message}`)
}

export function assertFields(value: object, allowed: readonly string[]): void {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) declarationError('expected a plain object')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) declarationError('unknown declaration field')
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (!property || !Object.hasOwn(property, 'value') || !property.enumerable)
      declarationError('accessors and hidden declaration fields are forbidden')
  }
}

export function assertId(value: string): void {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value))
    declarationError('invalid contribution ID')
}

export function assertFunction(value: unknown): void {
  if (typeof value !== 'function') declarationError('expected a handler function')
}

export function assertSynchronous(value: unknown): void {
  assertFunction(value)
  if (Object.prototype.toString.call(value) !== '[object Function]')
    declarationError('decision callbacks must be synchronous functions')
}

export function uniqueStrings(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) declarationError('expected an array')
  const safeValues = copyJson(values)
  const seen = new Set<string>()
  for (const value of safeValues) {
    if (!validName(value)) declarationError('invalid name')
    if (seen.has(value)) declarationError('duplicate name')
    seen.add(value)
  }
  return safeValues
}

export function copyLocalArray<T>(values: readonly T[]): readonly T[] {
  if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype)
    declarationError('expected a plain declaration array')
  const properties = Object.getOwnPropertyDescriptors(values)
  if (Reflect.ownKeys(properties).length !== values.length + 1)
    declarationError('unknown declaration array field')
  const result: T[] = []
  for (let index = 0; index < values.length; index++) {
    const property = properties[String(index)]
    if (!property?.enumerable || !Object.hasOwn(property, 'value'))
      declarationError('declaration array accessors and holes are forbidden')
    result.push(property.value as T)
  }
  return Object.freeze(result)
}

export function validName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
}

export function copyJson<T>(value: T): T {
  jcs(value)
  return cloneJson(value) as T
}

function cloneJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const properties = Object.getOwnPropertyDescriptors(value)
  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (let index = 0; index < value.length; index++)
      result.push(cloneJson(properties[String(index)]?.value))
    return Object.freeze(result)
  }
  return Object.freeze(
    Object.fromEntries(
      Object.keys(properties)
        .sort()
        .map((key) => [key, cloneJson(properties[key]?.value)]),
    ),
  )
}

export function assertEntry(value: string): void {
  if (typeof value !== 'string' || !/^\.\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.[cm]?tsx?$/.test(value))
    declarationError('entry must be a source path inside the package')
  if (
    value
      .slice(2)
      .split('/')
      .some((part) => part === '.' || part === '..')
  )
    declarationError('entry cannot traverse the package')
}
