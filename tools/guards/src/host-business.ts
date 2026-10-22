import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as ts from 'typescript/unstable/ast'
import {
  assertHostPackageCoverage,
  type BusinessCatalogue,
  businessCatalogue,
  CONTRACT_PACKAGES,
  DEFAULT_SYMBOLS,
  HOST_PACKAGES,
  officialTokens,
} from './host-business-catalogue.js'
import { listSourceFiles } from './repo.js'
import { astPath, productionFiles, walk, withSourceTrees } from './source-ast.js'

export type HostFinding = { path: string; symbol: string; literal: string; role: string; line: number }
export type HostAllowance = Omit<HostFinding, 'line'> & { max: number; removal: string }
export const hostKey = (entry: Omit<HostFinding, 'line'>): string =>
  JSON.stringify([entry.path, entry.symbol, entry.literal, entry.role])

/** Evaluate syntax only: no identifiers, coercion, arbitrary calls or user code. */
function constantString(node: ts.Node): string | undefined {
  let remaining = 256
  const read = (node: ts.Node, depth: number): string | undefined => {
    if (--remaining < 0 || depth > 32) return undefined
    const child = (value: ts.Node) => read(value, depth + 1)
    let value: string | undefined
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) value = node.text
    else if (ts.isParenthesizedExpression(node) || ts.isComputedPropertyName(node))
      value = child(node.expression)
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = child(node.left),
        right = child(node.right)
      if (left !== undefined && right !== undefined) value = left + right
    } else if (ts.isTemplateExpression(node)) {
      value = node.head.text
      for (const span of node.templateSpans) {
        const part = child(span.expression)
        if (part === undefined) return undefined
        value += part + span.literal.text
        if (value.length > 4096) return undefined
      }
    } else if (ts.isCallExpression(node)) {
      const access = node.expression
      const array =
        ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)
          ? access.expression
          : undefined
      const method = ts.isPropertyAccessExpression(access)
        ? access.name.text
        : ts.isElementAccessExpression(access)
          ? child(access.argumentExpression)
          : undefined
      if (
        method !== 'join' ||
        !array ||
        !ts.isArrayLiteralExpression(array) ||
        array.elements.length > 128 ||
        node.arguments.length > 1
      )
        return undefined
      const separatorArgument = node.arguments[0]
      const separator = separatorArgument ? child(separatorArgument) : ','
      if (separator === undefined) return undefined
      const parts: string[] = []
      for (const element of array.elements) {
        const part = child(element)
        if (part === undefined) return undefined
        parts.push(part)
      }
      value = parts.join(separator)
    }
    return value !== undefined && value.length <= 4096 ? value : undefined
  }
  return read(node, 0)
}

function enclosing(node: ts.Node, tree: ts.SourceFile): string {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isFunctionLikeDeclaration(current) ||
      ts.isVariableDeclaration(current) ||
      ts.isClassDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current)
    )
      return astPath(current, tree)
  }
  return '<module>'
}
function role(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current) || ts.isImportTypeNode(current))
      return 'import'
    if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword)
      return 'dynamic-import'
    if (
      ts.isBinaryExpression(current) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(current.operatorToken.kind)
    )
      return 'comparison'
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ['includes', 'startsWith', 'endsWith', 'has', 'test'].includes(current.expression.name.text)
    )
      return 'comparison'
    if (ts.isStatement(current)) break
  }
  return ts.isRegularExpressionLiteral(node) ? 'regexp' : 'literal'
}
export function hostFindings(tree: ts.SourceFile, path: string, catalogue: BusinessCatalogue): HostFinding[] {
  const findings: HostFinding[] = []
  const aliases = new Map<string, string>()
  const namespaces = new Set<string>()
  walk(tree, (node) => {
    if (ts.isImportSpecifier(node) && DEFAULT_SYMBOLS.has((node.propertyName ?? node.name).text))
      aliases.set(node.name.text, (node.propertyName ?? node.name).text)
    if (ts.isNamespaceImport(node)) namespaces.add(node.name.text)
    if (ts.isExportSpecifier(node) && DEFAULT_SYMBOLS.has((node.propertyName ?? node.name).text))
      aliases.set(node.name.text, (node.propertyName ?? node.name).text)
  })
  walk(tree, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      namespaces.has(node.initializer.text)
    ) {
      for (const element of node.name.elements) {
        if (!element.name) continue
        const key = element.propertyName ?? element.name
        const original = constantString(key) ?? key.getText(tree)
        if (DEFAULT_SYMBOLS.has(original) && ts.isIdentifier(element.name))
          aliases.set(element.name.text, original)
      }
    }
  })
  const businessAliases = new Map<string, string>()
  walk(tree, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = constantString(node.initializer)
      if (value !== undefined && officialTokens(value, catalogue).length)
        businessAliases.set(node.name.text, value)
    }
  })
  // A renamed or locally forwarded default remains an official selection.
  for (let pass = 0; pass < tree.statements.length + 1; pass++)
    walk(tree, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer)
      ) {
        const identity = aliases.get(node.initializer.text)
        if (identity) aliases.set(node.name.text, identity)
        const business = businessAliases.get(node.initializer.text)
        if (business) businessAliases.set(node.name.text, business)
      }
    })
  walk(tree, (node) => {
    const add = (literal: string, kind: string) =>
      findings.push({
        path,
        symbol: enclosing(node, tree),
        literal,
        role: kind,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      })
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      const text = ts.isRegularExpressionLiteral(node) ? node.getText(tree) : node.text
      const kind = role(node)
      // Daemon assembly composes its own split owners; Host still cannot import these owners.
      const daemonPeer = /^@agnes\/daemon-(?:admin|foundation|rpc|surfaces)(?:\/[\w./-]+)?$/.test(text)
      if (kind === 'import' && path.startsWith('packages/daemon/') && daemonPeer) return
      if (officialTokens(text, catalogue).length) add(text, kind)
    }
    if (ts.isBinaryExpression(node) || ts.isTemplateExpression(node) || ts.isCallExpression(node)) {
      const text = constantString(node)
      if (text !== undefined && officialTokens(text, catalogue).length) add(text, role(node))
    }
    if (ts.isBindingElement(node) && node.name && ts.isObjectBindingPattern(node.parent)) {
      const declaration = node.parent.parent
      const key = node.propertyName ?? node.name
      const original = constantString(key) ?? key.getText(tree)
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        ts.isIdentifier(declaration.initializer) &&
        namespaces.has(declaration.initializer.text) &&
        DEFAULT_SYMBOLS.has(original)
      )
        add(original, 'default-binding')
    }
    if (ts.isExportSpecifier(node) && DEFAULT_SYMBOLS.has((node.propertyName ?? node.name).text))
      add((node.propertyName ?? node.name).text, 'default-export')
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      node.argumentExpression
    ) {
      const key = constantString(node.argumentExpression)
      if (key !== undefined && DEFAULT_SYMBOLS.has(key)) add(key, `default-${role(node)}`)
    }
    if (ts.isIdentifier(node) && businessAliases.has(node.text) && role(node) === 'comparison')
      add(businessAliases.get(node.text) as string, 'alias-comparison')
    if (ts.isImportSpecifier(node) && DEFAULT_SYMBOLS.has((node.propertyName ?? node.name).text))
      add((node.propertyName ?? node.name).text, 'default-import')
    if (
      ts.isIdentifier(node) &&
      aliases.has(node.text) &&
      !ts.isImportSpecifier(node.parent) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !('name' in node.parent && node.parent.name === node)
    )
      add(aliases.get(node.text) as string, `default-${role(node)}`)
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      DEFAULT_SYMBOLS.has(node.name.text)
    )
      add(node.name.text, `default-${role(node)}`)
  })
  return findings
}

export function templateFindings(source: string, path: string, catalogue: BusinessCatalogue): HostFinding[] {
  const findings: HostFinding[] = []
  source.split('\n').forEach((line, index) => {
    if (line.trimStart().startsWith('#')) return
    const add = (literal: string) =>
      findings.push({ path, symbol: '<template>', literal, role: 'template', line: index + 1 })
    const unquoted = line.replace(/["']([^"']+)["']/g, '').split('#')[0] ?? ''
    for (const match of unquoted.matchAll(
      /@agnes\/[\w./-]+|(?:x\/|ext:)?agnes\/[\w./-]+|[A-Za-z][\w.-]*(?::[\w.-]+)?/g,
    )) {
      if (match.index > 0 && /[\w@/]/.test(unquoted[match.index - 1] ?? '')) continue
      if (officialTokens(match[0], catalogue).length) add(match[0])
    }
    for (const match of line.matchAll(/["']([^"']+)["']/g))
      if (officialTokens(match[1] as string, catalogue).length) add(match[1] as string)
  })
  return findings
}

export function hostInventory(root: string): { files: number; findings: HostFinding[]; manifests: number } {
  assertHostPackageCoverage(root)
  const catalogue = businessCatalogue(root)
  const files = [
    ...HOST_PACKAGES.flatMap((name) => productionFiles(join(root, 'packages', name, 'src'))),
    // Core consumes Host attestations at these gates; it must not rediscover official identities.
    join(root, 'packages/core/src/registry/tools.ts'),
    join(root, 'packages/core/src/hooks/dispatch.ts'),
    join(root, 'packages/core-effects/src/effects/tool-providers.ts'),
    join(root, 'packages/daemon/src/supervisor/assembly-runtime.ts'),
    join(root, 'packages/daemon/src/supervisor/model-adapter-lookup.ts'),
    join(root, 'packages/daemon/src/supervisor/model-catalog-read.ts'),
    join(root, 'packages/daemon-admin/src/packages/builtin-client-services.ts'),
  ]
  const findings = withSourceTrees(files, (trees) =>
    trees.flatMap((tree, index) =>
      hostFindings(tree, relative(root, files[index] as string).replaceAll('\\', '/'), catalogue),
    ),
  )
  for (const name of HOST_PACKAGES) {
    const path = `packages/${name}/package.json`
    const json = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, Record<string, string>>
    for (const scope of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(json[scope] ?? {})) {
        if (
          (dependency.startsWith('@agnes/') || catalogue.tokens.has(dependency)) &&
          !CONTRACT_PACKAGES.has(dependency)
        )
          findings.push({ path, symbol: scope, literal: dependency, role: 'dependency', line: 1 })
      }
    }
    const templates = listSourceFiles(join(root, 'packages', name, 'templates'), { extensions: [''] })
    for (const file of templates) {
      if (!/\.ya?ml$/.test(file)) throw new Error(`Unclassified Host template: ${file}`)
      findings.push(
        ...templateFindings(
          readFileSync(file, 'utf8'),
          relative(root, file).replaceAll('\\', '/'),
          catalogue,
        ),
      )
    }
  }
  return { files: files.length, findings, manifests: catalogue.manifests }
}

export function hostViolations(
  findings: HostFinding[],
  allowances: HostAllowance[],
  contracts: Omit<HostAllowance, 'removal'>[],
): string[] {
  const counts = new Map<string, number>()
  for (const finding of findings) counts.set(hostKey(finding), (counts.get(hostKey(finding)) ?? 0) + 1)
  const allowed = new Map([...allowances, ...contracts].map((entry) => [hostKey(entry), entry.max]))
  const errors: string[] = []
  if (allowed.size !== allowances.length + contracts.length) errors.push('Duplicate Host allowance identity')
  for (const entry of [...allowances, ...contracts]) {
    if (!Number.isInteger(entry.max) || entry.max < 1 || /[*?]/.test(entry.path))
      errors.push(`Invalid reviewed allowance: ${hostKey(entry)}`)
    if ((counts.get(hostKey(entry)) ?? 0) < entry.max)
      errors.push(`Tighten/remove Host allowance: ${hostKey(entry)}`)
  }
  for (const entry of allowances)
    if (!/^A[1-5]: .+/.test(entry.removal)) errors.push(`Missing removal step: ${hostKey(entry)}`)
  for (const [key, count] of counts)
    if (count > (allowed.get(key) ?? 0)) errors.push(`${key}: ${count} > ${allowed.get(key) ?? 0}`)
  for (const key of allowed.keys()) if (!counts.has(key)) errors.push(`Stale Host allowance: ${key}`)
  return errors
}
