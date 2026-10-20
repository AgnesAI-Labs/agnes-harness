/** Use the repository-pinned compiler; parse failures and empty scans are errors. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import * as ts from 'typescript/unstable/ast'
import { API } from 'typescript/unstable/sync'
import { isTestFile, listSourceFiles } from './repo.js'

export const CODE_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']

export function productionFiles(root: string): string[] {
  // Do not exclude fixtures or directories named test inside production roots.
  const all = listSourceFiles(root, { extensions: [''] })
  const files = all.filter((file) => !isTestFile(file) && !/\.test\.[cm]?jsx?$/.test(file))
  const unknown = files.filter(
    (file) =>
      !CODE_EXTENSIONS.includes(extname(file)) &&
      ![
        '.json',
        '.css',
        '.md',
        '.yaml',
        '.yml',
        '.sql',
        '.txt',
        '.png',
        '.svg',
        '.html',
        '.h',
        '.c',
        '.sh',
      ].includes(extname(file)),
  )
  if (unknown.length) throw new Error(`Unclassified production suffix: ${unknown.join(', ')}`)
  const sources = files.filter((file) => CODE_EXTENSIONS.includes(extname(file)))
  if (!sources.length) throw new Error(`Empty production source scan: ${root}`)
  return sources
}

export function withSourceTrees<T>(files: readonly string[], inspect: (trees: ts.SourceFile[]) => T): T {
  if (!files.length) throw new Error('Empty AST scan')
  for (const file of files)
    if (!CODE_EXTENSIONS.includes(extname(file))) throw new Error(`Unknown source suffix: ${file}`)
  const dir = mkdtempSync(join(tmpdir(), 'agh-guard-ast-'))
  const config = join(dir, 'tsconfig.json')
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        noResolve: true,
        noEmit: true,
        target: 'ESNext',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        jsx: 'preserve',
      },
      files,
    }),
  )
  const api = new API()
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] })
    try {
      const program = snapshot.getProject(config)?.program
      if (!program) throw new Error('AST project missing')
      const trees = files.map((file) => {
        const errors = program.getSyntacticDiagnostics(file)
        if (errors.length) throw new Error(`Parse error in ${file}: ${JSON.stringify(errors)}`)
        const tree = program.getSourceFile(file)
        if (!tree) throw new Error(`Missing AST: ${file}`)
        return tree
      })
      return inspect(trees)
    } finally {
      snapshot.dispose()
    }
  } finally {
    api.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Named containers plus structural paths distinguish repeated anonymous callbacks without lines. */
export function astPath(node: ts.Node, tree: ts.SourceFile): string {
  if (ts.isSourceFile(node)) return '<module>'
  const parent = node.parent
  if (!parent) throw new Error('AST parent missing')
  const name =
    'name' in node && node.name && typeof node.name === 'object' && 'getText' in node.name
      ? (node.name as ts.Node).getText(tree)
      : undefined
  const siblings: ts.Node[] = []
  parent.forEachChild((child) => {
    if (child.kind === node.kind) siblings.push(child)
  })
  const segment = `${ts.SyntaxKind[node.kind]}:${name ?? siblings.indexOf(node)}`
  let container = parent
  // The declaration's name anchors it within its lexical block. VariableStatement's ordinal
  // would make insertion of an unrelated preceding local rename the declaration.
  if (ts.isVariableDeclaration(node)) {
    if (ts.isVariableDeclarationList(container)) container = container.parent
    if (ts.isVariableStatement(container)) container = container.parent
  }
  return `${astPath(container, tree)}/${segment}`
}

export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
