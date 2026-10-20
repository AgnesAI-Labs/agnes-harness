/** Structural changes are a review report, not an undocumented complexity ceiling. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type FunctionMeasurement, functionKey, measureFunctions, RISK_DIRECTORIES } from './function-size.js'
import { protectedBase } from './protected-allowances.js'
import { CODE_EXTENSIONS, withSourceTrees } from './source-ast.js'

export function structureChanges(current: FunctionMeasurement[], previous: FunctionMeasurement[]): string[] {
  const before = new Map(previous.map((fn) => [functionKey(fn), fn]))
  const digest = (fn: FunctionMeasurement) => createHash('sha256').update(fn.structure).digest('hex')
  const changes: string[] = []
  for (const fn of current) {
    const old = before.get(functionKey(fn))
    if (!old || old.structure !== fn.structure)
      changes.push(
        `${functionKey(fn)}: statements ${old?.statements ?? 'new'} -> ${fn.statements}; structure ${old ? digest(old) : 'new'} -> ${digest(fn)}; effective LOC ${old?.lines ?? 'new'} -> ${fn.lines}`,
      )
    before.delete(functionKey(fn))
  }
  for (const [key, fn] of before) changes.push(`${key}: removed (statements=${fn.statements})`)
  return changes
}
export function reportFunctionStructure(root: string, current: FunctionMeasurement[]): string[] {
  const base = protectedBase(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const changed = git('diff', '--name-only', '--no-renames', base, '--', ...RISK_DIRECTORIES)
    .trim()
    .split('\n')
    .filter((file) => CODE_EXTENSIONS.some((ext) => file.endsWith(ext)))
  if (!changed.length) return []
  const scratch = mkdtempSync(join(tmpdir(), 'agh-function-base-'))
  try {
    const files: { path: string; original: string }[] = []
    for (const file of changed) {
      if (!git('ls-tree', '--name-only', base, '--', file).trim()) continue
      const path = join(scratch, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, git('show', `${base}:${file}`))
      files.push({ path, original: file })
    }
    const previous = files.length
      ? withSourceTrees(
          files.map((file) => file.path),
          (trees) =>
            trees.flatMap((tree, index) =>
              measureFunctions(tree, (files[index] as { original: string }).original),
            ),
        )
      : []
    return structureChanges(
      current.filter((fn) => changed.includes(fn.path)),
      previous,
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
