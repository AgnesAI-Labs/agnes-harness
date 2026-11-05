import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import * as ts from 'typescript/unstable/ast'
import { describe, expect, it } from 'vitest'
import { isTestFile, listSourceFiles, repoRoot } from './repo.js'
import { walk, withSourceTrees } from './source-ast.js'

const root = repoRoot()
const OWNER = 'packages/extension-api/src/tokens.ts'

/** Production sources under any `src` directory of `packages/`, as repository-relative paths. */
function sources(): { path: string; text: string }[] {
  return listSourceFiles(join(root, 'packages'))
    .map((file) => relative(root, file).replaceAll('\\', '/'))
    .filter((path) => path.includes('/src/') && !isTestFile(path))
    .map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }))
}

const DEFINES = /\bfunction\s+estimateTokens\b|\b(?:const|let|var)\s+estimateTokens\s*=/
const BYTES_OR_THIRDS = /Buffer\.byteLength|\.length\s*\/\s*3\b/

function functionName(node: ts.Node, tree: ts.SourceFile): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name)
    return node.name.getText(tree)
  if (
    (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  )
    return node.name.getText(tree)
  return undefined
}

function byteCountingTokenFunctions(paths: readonly string[]): string[] {
  if (!paths.length) return []
  return withSourceTrees(paths, (trees) =>
    trees.flatMap((tree, index) => {
      const found: string[] = []
      walk(tree, (node) => {
        const name = functionName(node, tree)
        if (name?.includes('Tokens') && BYTES_OR_THIRDS.test(node.getText(tree)))
          found.push(`${relative(root, paths[index] as string).replaceAll('\\', '/')}: ${name}`)
      })
      return found
    }),
  )
}

/**
 * Token budgets (window, compaction, experience snapshot) are only comparable with the usage a model
 * reports if every place that estimates tokens estimates them the same way. There is one estimator,
 * `estimateTokens` in extension-api; a second copy drifts, and a function named for tokens that
 * counts bytes or a third of the length is a byte limit under a token name.
 */
describe('one token estimator', () => {
  const files = sources()

  it('only extension-api defines estimateTokens', () => {
    expect(files.length, 'the source scan found nothing, so this guard checked nothing').toBeGreaterThan(1000)
    const defining = files.filter((file) => DEFINES.test(file.text)).map((file) => file.path)
    expect(defining).toEqual([OWNER])
  })

  it('no function named for tokens counts bytes or a third of the length', () => {
    const candidates = files.filter((file) => file.text.includes('Tokens') && BYTES_OR_THIRDS.test(file.text))
    const offenders = byteCountingTokenFunctions(candidates.map((file) => join(root, file.path)))
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('finds such a function when there is one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-token-guard-'))
    try {
      const file = join(dir, 'sample.ts')
      writeFileSync(
        file,
        [
          'export function wireTokens(s: string) { return Buffer.byteLength(s) }',
          'export const thirdTokens = (s: string) => Math.ceil(s.length / 3)',
          'export function sizeBytes(s: string) { return Buffer.byteLength(s) }',
        ].join('\n'),
      )
      expect(byteCountingTokenFunctions([file]).map((found) => found.split(': ')[1])).toEqual([
        'wireTokens',
        'thirdTokens',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
