function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0) as number)
  const b = Array.from(right, (character) => character.codePointAt(0) as number)
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const difference = (a[index] as number) - (b[index] as number)
    if (difference !== 0) return difference
  }
  return a.length - b.length
}

export function canonicalStringSet(values: readonly string[] | undefined): readonly string[] | undefined {
  if (values === undefined) return undefined
  return [...new Set(values)].sort(compareCodePoints)
}

export function canonicalStringMap(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  const output: Record<string, string> = {}
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    const item = value[key]
    if (item !== undefined) output[key] = item
  }
  return output
}

export function encodeCanonicalRecord(value: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
  return JSON.stringify(entries)
}
