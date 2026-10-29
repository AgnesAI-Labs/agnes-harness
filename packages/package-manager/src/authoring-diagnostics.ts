import { authoringDiagnosticText, safeAuthoringDiagnostics, safePackagePath } from '@agnes/error-sanitization'
import type { AuthoringCandidate, AuthoringFile } from '@agnes/protocol'
import { PackageError } from './errors.js'

export function candidateTreeStatus(files: readonly AuthoringFile[]) {
  const paths = new Set(files.map((f) => f.path))
  const entries = new Set<string>()
  const diagnostics: unknown[] = []
  const missing = (path: string, field: string) =>
    diagnostics.push({
      code: 'missing-required-file',
      path: 'package.json',
      field,
      name: path,
    })
  const entry = (value: unknown, field: string, directory = '') => {
    if (typeof value !== 'string' || !safePackagePath(value)) return
    const path = directory + value.replace(/^\.\//, '')
    if (!safePackagePath(path)) return
    entries.add(path)
    if (!paths.has(path)) missing(path, field)
  }
  const manifest = files.find((f) => f.path === 'package.json')
  if (!manifest) missing('package.json', 'files')
  else
    try {
      const pkg = JSON.parse(manifest.content)
      const exported = (value: unknown) => {
        if (typeof value === 'string') entry(value, 'exports')
        else if (value && typeof value === 'object') Object.values(value).forEach(exported)
      }
      exported(pkg.exports)
      entry(pkg.main, 'main')
      for (const item of pkg.agnes?.clientDescriptors ?? []) {
        entry(item.path, 'agnes.clientDescriptors')
        const path = typeof item.path === 'string' ? item.path.replace(/^\.\//, '') : ''
        const descriptor = files.find((f) => f.path === path)
        if (!descriptor) continue
        try {
          const data = JSON.parse(descriptor.content)
          entry(data.client?.entry, 'client.entry', path.slice(0, path.lastIndexOf('/') + 1))
        } catch {
          /* The package inspector owns descriptor validation. */
        }
      }
    } catch {
      /* The package inspector owns manifest validation. */
    }
  return { entries: [...entries].sort().slice(0, 64), diagnostics: safeAuthoringDiagnostics(diagnostics) }
}
export function requireCompleteCandidate(files: readonly AuthoringFile[]): void {
  const { diagnostics } = candidateTreeStatus(files)
  if (diagnostics.length)
    throw new PackageError('E_DEP_MISSING', authoringDiagnosticText(diagnostics), {
      detail: { diagnostics },
    })
}
export function candidateWriteSummary(
  before: readonly AuthoringFile[],
  after: readonly AuthoringFile[],
): NonNullable<AuthoringCandidate['writeSummary']> {
  const old = new Map(before.map((f) => [f.path, f.content]))
  const next = new Map(after.map((f) => [f.path, f.content]))
  const { entries, diagnostics } = candidateTreeStatus(after)
  const added = after.filter((f) => !old.has(f.path)).map((f) => f.path)
  const removed = before.filter((f) => !next.has(f.path)).map((f) => f.path)
  const changed = after.filter((f) => old.has(f.path) && old.get(f.path) !== f.content).map((f) => f.path)
  return {
    added,
    removed,
    changed,
    entries,
    missing: diagnostics.map((d) => d.name),
    unchanged: added.length + removed.length + changed.length === 0,
  }
}
