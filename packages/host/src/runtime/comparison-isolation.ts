import { isAbsolute, relative, sep } from 'node:path'
import type { Enforcement, FsPolicy } from '@agnes/core'
import { ComparisonError } from '@agnes/runtime-comparison'

/** Host-only coordinates, reconstructed from the comparison's durable allocation. */
export interface ComparisonIsolation {
  sourceRoot: string
  storageRoot: string
  workspaceRoots: readonly string[]
  externalPaths: readonly string[]
}

const inside = (root: string, path: string) => {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a)

/** Copies alone are insufficient: inspect the actual fitted policy and proven OS boundary. */
export function assertComparisonIsolation(
  policy: FsPolicy | undefined,
  enforcement: Enforcement | undefined,
  yolo: boolean,
  isolation: ComparisonIsolation,
): void {
  if (!policy || yolo || enforcement?.level !== 'full' || !enforcement.scope.includes('file'))
    throw new ComparisonError(
      'COMPARISON_ISOLATION_REQUIRED',
      'Comparison requires full filesystem confinement',
    )
  const root = policy.workspaceRoot
  const protectedPaths = [isolation.sourceRoot, ...isolation.externalPaths]
  if (
    isolation.workspaceRoots.length !== 2 ||
    !isolation.workspaceRoots.includes(root) ||
    overlaps(isolation.workspaceRoots[0]!, isolation.workspaceRoots[1]!) ||
    !inside(isolation.storageRoot, root) ||
    root === isolation.storageRoot ||
    protectedPaths.some((path) => overlaps(root, path)) ||
    policy.rules.some((rule) => {
      if (rule.effect !== 'allow') return false
      if (inside(root, rule.path)) return false
      // Host scratch may be shared, but never with a source, baseline, lane or external dependency.
      return (
        rule.source !== 'data-tmp' ||
        [isolation.storageRoot, ...protectedPaths].some((path) => overlaps(rule.path, path))
      )
    })
  )
    throw new ComparisonError('COMPARISON_WRITABLE_OVERLAP', 'Comparison writable roots are not isolated')
}
