import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import * as ts from 'typescript/unstable/ast'
import { countLines } from './count-lines.js'
import { astPath, productionFiles, walk, withSourceTrees } from './source-ast.js'

export const FUNCTION_LIMIT = 210
export const RISK_DIRECTORIES = [
  'packages/core/src/execution/turn',
  'packages/host/src/runtime/generation',
  'packages/daemon/src/supervisor',
] as const
export type FunctionMeasurement = {
  path: string
  symbol: string
  lines: number
  statements: number
  structure: string
  line: number
}

export function measureFunctions(tree: ts.SourceFile, path: string): FunctionMeasurement[] {
  const found: FunctionMeasurement[] = []
  walk(tree, (node) => {
    if (!ts.isFunctionLikeDeclaration(node) || !('body' in node) || !node.body) return
    let statements = 0
    const structure = new Map<string, number>()
    const shape = createHash('sha256')
    const inspect = (child: ts.Node): void => {
      shape.update(`${child.kind}(`)
      if (ts.isStatement(child) && !ts.isBlock(child)) statements++
      const kind = ts.SyntaxKind[child.kind]
      structure.set(kind, (structure.get(kind) ?? 0) + 1)
      child.forEachChild(inspect)
      shape.update(')')
    }
    inspect(node.body)
    found.push({
      path,
      symbol: astPath(node, tree),
      lines: countLines(node.getText(tree)),
      statements,
      structure:
        `shape=${shape.digest('hex')};` +
        [...structure]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([kind, count]) => `${kind}=${count}`)
          .join(','),
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
    })
  })
  return found
}

export function functionMeasurements(root: string): { files: number; functions: FunctionMeasurement[] } {
  const files = RISK_DIRECTORIES.flatMap((dir) => productionFiles(`${root}/${dir}`))
  const functions = withSourceTrees(files, (trees) =>
    trees.flatMap((tree, index) =>
      measureFunctions(tree, relative(root, files[index] as string).replaceAll('\\', '/')),
    ),
  )
  for (const dir of RISK_DIRECTORIES)
    if (!functions.some((fn) => fn.path.startsWith(`${dir}/`))) throw new Error(`Empty function scan: ${dir}`)
  return { files: files.length, functions }
}
export const functionKey = (fn: Pick<FunctionMeasurement, 'path' | 'symbol'>): string =>
  `${fn.path}#${fn.symbol}`
export function functionViolations(
  functions: FunctionMeasurement[],
  allowed: Record<string, number>,
): string[] {
  const measured = new Map(functions.map((fn) => [functionKey(fn), fn]))
  if (measured.size !== functions.length) throw new Error('Ambiguous function identity')
  return [
    ...functions
      .filter((fn) => fn.lines > (allowed[functionKey(fn)] ?? FUNCTION_LIMIT))
      .map(
        (fn) =>
          `${fn.path}:${fn.line} ${fn.symbol}: ${fn.lines} effective LOC > ${allowed[functionKey(fn)] ?? FUNCTION_LIMIT}; statements=${fn.statements}; structure=${fn.structure}`,
      ),
    ...Object.keys(allowed)
      .filter((key) => (measured.get(key)?.lines ?? 0) <= FUNCTION_LIMIT)
      .map((key) => `Stale function allowance: ${key}`),
  ]
}
