/** Canonical JSON: object keys sorted, so two spellings of one argument object hash alike. */
export function jcs(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jcs((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}
