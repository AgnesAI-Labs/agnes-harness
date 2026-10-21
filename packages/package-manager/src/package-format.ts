import { PackageError } from './errors.js'

/** Refuse retired package envelopes before hashing, projecting or writing their bytes. */
export function assertCurrentPackageFormat(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const row = value as Record<string, unknown>
  const metadata = row.metadata as Record<string, unknown> | undefined
  if (
    Object.hasOwn(row, 'kinds') ||
    (metadata && (Object.hasOwn(metadata, 'category') || Object.hasOwn(metadata, 'launches')))
  )
    throw new PackageError(
      'E_LOCK_MISMATCH',
      'Retired category/launches/kinds package format; select a new, empty AGH_HOME (clean home) and reinstall and review plugins.',
      { detail: { reason: 'clean-home-required' } },
    )
  for (const key of ['previous', 'preview', 'installed', 'presentation', 'includes'])
    assertCurrentPackageFormat(row[key])
  for (const key of ['contributions', 'rows', 'plugins'])
    if (Array.isArray(row[key])) for (const entry of row[key]) assertCurrentPackageFormat(entry)
  if (row.packages && typeof row.packages === 'object')
    for (const entry of Object.values(row.packages)) assertCurrentPackageFormat(entry)
}
