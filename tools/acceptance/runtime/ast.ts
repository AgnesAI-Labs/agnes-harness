import {
  type BinaryExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isElementAccessExpression,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isExpression,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isNamedExports,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedTypeNode,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type NoSubstitutionTemplateLiteral,
  type ObjectLiteralExpression,
  type PropertyName,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
  skipOuterExpressions,
} from 'typescript/unstable/ast'

export type ObjectMember =
  | { kind: 'property'; name: string; node: Node; initializer: Expression | undefined }
  | { kind: 'spread'; name: string; node: Node }

export function nodeText(node: Node): string {
  return node.getText()
}

export function unwrap(expression: Expression): Expression {
  const skipped = skipOuterExpressions(expression)
  if (isCallExpression(skipped) && isPropertyAccessExpression(skipped.expression)) {
    const name = skipped.expression.name.text
    const argument = name === 'assign' ? skipped.arguments.at(-1) : skipped.arguments[0]
    if ((name === 'freeze' || name === 'assign') && argument && isExpression(argument))
      return unwrap(argument)
  }
  if (isNewExpression(skipped)) {
    const argument = skipped.arguments?.[0]
    if (argument && isExpression(argument)) return unwrap(argument)
  }
  return skipped
}

export function stringLiterals(expression: Expression): string[] | undefined {
  const value = unwrap(expression)
  if (!isArrayLiteralExpression(value)) return undefined
  const items: string[] = []
  for (const element of value.elements) {
    const text = literalText(element)
    if (text === undefined) return undefined
    items.push(text)
  }
  return items
}

export function variableInitializer(sf: SourceFile, name: string): Expression {
  let found: Expression | undefined
  walk(sf, (node) => {
    if (
      !isVariableDeclaration(node) ||
      !isIdentifier(node.name) ||
      node.name.text !== name ||
      !node.initializer
    )
      return
    found = node.initializer
  })
  if (!found) throw new Error(`${sf.fileName} has no ${name} initializer`)
  return found
}

export function stringUnion(type: Node | undefined): string[] {
  if (!type) return []
  if (isParenthesizedTypeNode(type)) return stringUnion(type.type)
  const literal = literalString(type)
  if (literal !== undefined) return [literal]
  if (type.kind !== SyntaxKind.UnionType) return []
  const parts = 'types' in type ? (type as { types?: readonly Node[] }).types : undefined
  return (parts ?? []).flatMap((part) => stringUnion(part))
}

export function typeAliasUnion(sf: SourceFile, name: string): string[] {
  for (const statement of sf.statements) {
    if (!isTypeAliasDeclaration(statement) || statement.name.text !== name) continue
    return stringUnion(statement.type)
  }
  return []
}

export function objectMembers(expression: Expression): ObjectMember[] {
  const value = unwrap(expression)
  if (!isObjectLiteralExpression(value)) throw new Error('expected an object literal')
  return membersOf(value)
}

export function propertyName(name: PropertyName): string | undefined {
  if (isIdentifier(name) || isStringLiteral(name) || isNumericLiteral(name)) return name.text
  return undefined
}

export function importedFrom(
  sf: SourceFile,
  localName: string,
): { specifier: string; exported: string } | undefined {
  for (const statement of sf.statements) {
    if (statement.kind !== SyntaxKind.ImportDeclaration) continue
    const specifier = moduleSpecifierOf(statement)
    const clause =
      'importClause' in statement ? (statement as { importClause?: Node }).importClause : undefined
    const named =
      clause && 'namedBindings' in clause ? (clause as { namedBindings?: Node }).namedBindings : undefined
    if (!specifier || !named || named.kind !== SyntaxKind.NamedImports) continue
    for (const element of (named as unknown as { elements: readonly ImportLike[] }).elements) {
      if (element.name.text !== localName) continue
      return { specifier, exported: element.propertyName?.text ?? element.name.text }
    }
  }
  return undefined
}

export function reexportedFrom(
  sf: SourceFile,
  exportedName: string,
): { specifier: string; local: string } | undefined {
  for (const statement of sf.statements) {
    if (!isExportDeclaration(statement) || !statement.moduleSpecifier || !statement.exportClause) continue
    if (!isNamedExports(statement.exportClause)) continue
    const specifier = moduleSpecifierOf(statement)
    if (!specifier) continue
    for (const element of statement.exportClause.elements) {
      if (element.name.text !== exportedName) continue
      return { specifier, local: element.propertyName?.text ?? element.name.text }
    }
  }
  return undefined
}

export function resolveRelative(from: string, specifier: string): string {
  if (!specifier.startsWith('.')) throw new Error(`${from} imports ${specifier} by package name`)
  const parts = from.split('/')
  parts.pop()
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const path = parts.join('/')
  if (path.endsWith('.js')) return `${path.slice(0, -3)}.ts`
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return path
  return `${path}.ts`
}

export function comparedStrings(
  sf: SourceFile,
  accept: (other: Expression) => boolean,
): { text: string; node: Node }[] {
  const found: { text: string; node: Node }[] = []
  walk(sf, (node) => {
    if (!isComparison(node)) return
    const literal = literalNode(node.left) ?? literalNode(node.right)
    const other = literal === node.left ? node.right : literal === node.right ? node.left : undefined
    if (literal && other && accept(other)) found.push({ text: literal.text, node })
  })
  return found
}

export function includesArrays(root: Node): Node[] {
  const found: Node[] = []
  walk(root, (node) => {
    if (
      !isCallExpression(node) ||
      !isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== 'includes'
    )
      return
    const receiver = unwrap(node.expression.expression)
    if (isArrayLiteralExpression(receiver)) found.push(receiver)
  })
  return found
}

export function arrayElements(node: Node): readonly Node[] {
  return isArrayLiteralExpression(node) ? node.elements : []
}

export function functionsNamed(sf: SourceFile, prefix: string): Node[] {
  const found: Node[] = []
  walk(sf, (node) => {
    if (isFunctionDeclaration(node) && node.name?.text.startsWith(prefix)) found.push(node)
  })
  return found
}

export function walk(node: Node, visit: (node: Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

export function isExported(node: Node): boolean {
  const modifiers = 'modifiers' in node ? (node as { modifiers?: readonly Node[] }).modifiers : undefined
  return modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) ?? false
}

export function moduleSpecifierOf(node: Node): string | undefined {
  const specifier =
    'moduleSpecifier' in node ? (node as { moduleSpecifier?: Expression }).moduleSpecifier : undefined
  return specifier && isStringLiteral(specifier) ? specifier.text : undefined
}

export function identifierText(node: Node): string | undefined {
  return isIdentifier(node) ? node.text : undefined
}

export function isStringLike(node: Node): node is StringLiteral | NoSubstitutionTemplateLiteral {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)
}

function literalNode(node: Node): (StringLiteral | NoSubstitutionTemplateLiteral) | undefined {
  return isStringLike(node) ? node : undefined
}

function literalText(node: Node): string | undefined {
  return literalNode(node)?.text
}

export function isNamed(expression: Expression, name: string): boolean {
  return isIdentifier(expression) && expression.text === name
}

export function isAccessNamed(expression: Expression, name: string): boolean {
  return isPropertyAccessExpression(expression) && expression.name.text === name
}

export function isPositional(expression: Expression): boolean {
  return (
    isElementAccessExpression(expression) &&
    isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'positional'
  )
}

export function topLevelStringConstants(sf: SourceFile): { name: string; text: string; node: Node }[] {
  const found: { name: string; text: string; node: Node }[] = []
  for (const statement of sf.statements) {
    if (!isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!isIdentifier(declaration.name) || !declaration.initializer) continue
      const value = unwrap(declaration.initializer)
      if (!isStringLike(value)) continue
      found.push({ name: declaration.name.text, text: value.text, node: declaration })
    }
  }
  return found
}

export function localExportNodes(sf: SourceFile): { name: string; node: Node }[] {
  const found: { name: string; node: Node }[] = []
  for (const statement of sf.statements) {
    if (
      isFunctionDeclaration(statement) ||
      isClassDeclaration(statement) ||
      isInterfaceDeclaration(statement) ||
      isTypeAliasDeclaration(statement) ||
      isEnumDeclaration(statement)
    ) {
      if (!isExported(statement) || !statement.name) continue
      found.push({ name: statement.name.text, node: statement })
      continue
    }
    if (isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!isIdentifier(declaration.name)) throw new Error(`${sf.fileName} exports a binding pattern`)
        found.push({ name: declaration.name.text, node: declaration })
      }
    }
    if (isExportAssignment(statement)) found.push({ name: 'default', node: statement })
  }
  return found
}

export function exportStars(sf: SourceFile): string[] {
  const found: string[] = []
  for (const statement of sf.statements) {
    if (!isExportDeclaration(statement) || statement.exportClause) continue
    const specifier = moduleSpecifierOf(statement)
    if (!specifier) throw new Error(`${sf.fileName} has an export star without a module`)
    found.push(specifier)
  }
  return found
}

export function namedReexports(
  sf: SourceFile,
): { specifier?: string; local: string; exported: string; node: Node }[] {
  const found: { specifier?: string; local: string; exported: string; node: Node }[] = []
  for (const statement of sf.statements) {
    if (!isExportDeclaration(statement) || !statement.exportClause) continue
    if (!isNamedExports(statement.exportClause)) throw new Error(`${sf.fileName} has a namespace export`)
    const specifier = moduleSpecifierOf(statement)
    for (const element of statement.exportClause.elements) {
      found.push({
        ...(specifier ? { specifier } : {}),
        local: element.propertyName?.text ?? element.name.text,
        exported: element.name.text,
        node: element,
      })
    }
  }
  return found
}

type ImportLike = { name: Identifier; propertyName?: Identifier }

function membersOf(value: ObjectLiteralExpression): ObjectMember[] {
  const members: ObjectMember[] = []
  for (const member of value.properties) {
    if (isSpreadAssignment(member)) {
      if (!isIdentifier(member.expression)) throw new Error('object spread is not an identifier')
      members.push({ kind: 'spread', name: member.expression.text, node: member })
      continue
    }
    if (!isPropertyAssignment(member) && !isShorthandPropertyAssignment(member)) {
      throw new Error('object has an unsupported property')
    }
    const name = propertyName(member.name)
    if (name === undefined) throw new Error('object has a computed property')
    const initializer = isPropertyAssignment(member) ? member.initializer : undefined
    members.push({ kind: 'property', name, node: member, initializer })
  }
  return members
}

function literalString(node: Node): string | undefined {
  if (node.kind !== SyntaxKind.LiteralType || !('literal' in node)) return undefined
  const literal = (node as { literal: Node }).literal
  return isStringLiteral(literal) ? literal.text : undefined
}

function isComparison(node: Node): node is BinaryExpression {
  if (!isBinaryExpression(node)) return false
  return (
    node.operatorToken.kind === SyntaxKind.EqualsEqualsEqualsToken ||
    node.operatorToken.kind === SyntaxKind.ExclamationEqualsEqualsToken
  )
}
