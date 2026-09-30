import { createHash } from 'node:crypto'
import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isCallExpression,
  isClassDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isParenthesizedTypeNode,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadElement,
  isTemplateExpression,
  isTypeAliasDeclaration,
  isUnionTypeNode,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/unstable/ast'
import {
  arrayElements,
  comparedStrings,
  exportStars,
  functionsNamed,
  importedFrom,
  includesArrays,
  isAccessNamed,
  isNamed,
  isPositional,
  isStringLike,
  localExportNodes,
  namedReexports,
  nodeText,
  objectMembers,
  propertyName,
  reexportedFrom,
  resolveRelative,
  stringLiterals,
  stringUnion,
  topLevelStringConstants,
  unwrap,
  variableInitializer,
  walk,
} from './ast.js'
import { GitTree } from './git-at.js'
import { SourceFiles } from './sources.js'

export const IMPLEMENTATION_BASELINE = '5da40731214976ad8aff982cd5626d3a676fdd88'

export const INVENTORY_CLASSES = [
  'test',
  'daemon-rpc',
  'cli',
  'acp',
  'web',
  'tui',
  'channel',
  'computer-use',
  'resource-control',
  'session-metadata',
  'extension',
] as const

export type InventoryClass = (typeof INVENTORY_CLASSES)[number]
export type Disposition = 'preserve' | 'map'

export type InventoryEntry = {
  id: string
  class: InventoryClass
  path: string
  symbol: string
  origin: string
  digest: string
  disposition: Disposition
  responsibility: string
}

export type DiscoveryNote = {
  method: string
  limitations: string
  digest: string
  sources: string[]
}

export type Inventory = {
  baseline: string
  counts: Record<InventoryClass, number>
  discovery: Record<InventoryClass, DiscoveryNote>
  entries: InventoryEntry[]
}

type Draft = {
  class: InventoryClass
  path: string
  symbol: string
  origin: string
  bytes: Buffer | string
  responsibility: string
}

const CODE_DIGEST = 'sha256 of the source text of the extracted definition node.'
const JSON_DIGEST = 'sha256 of the RFC 8785 canonical JSON of that definition.'
const BLOB_DIGEST = 'sha256 of the git blob.'

const DISCOVERY: Record<InventoryClass, Omit<DiscoveryNote, 'sources'>> = {
  test: {
    method:
      'Test files are the paths in the baseline tree that match include globs written in vitest.shared.ts. Exclude globs written in that same file are removed. The file list comes from git ls-tree.',
    limitations:
      'A test outside those include globs is not listed. An exclude value that is an identifier is not expanded. Vitest defaultExclude is a library constant and is not re-implemented; the exclude globs written as string literals are applied on top of the tracked tree.',
    digest: `Each test file is ${BLOB_DIGEST}`,
  },
  'daemon-rpc': {
    method:
      'Daemon RPC names are the keys of the METHODS object in packages/protocol/src/methods.ts after the objects it spreads are followed through relative imports and re-exports to their object literals. endpoint.register calls under packages/daemon/src/local/methods are read from the compiler AST and included when their string is not already a key.',
    limitations:
      'A registration whose first argument is not a string literal is listed as non-literal. Methods registered outside packages/daemon/src/local/methods stay listed from the method table. Computer Use, resource control, ACP, and session rename/archive names are partitioned into those classes. The responsibility label lowercases the method-name segment and inserts a hyphen before each capital, so approvalGrants is daemon-rpc:approval-grants. The entry symbol keeps the method name as written.',
    digest: `Each method or registration is ${CODE_DIGEST}`,
  },
  cli: {
    method:
      'CLI commands, value flags, boolean flags, and enum values come from the COMMANDS, FORWARDED, VALUE_FLAGS, BOOL_FLAGS, and ENUMS tables in packages/cli/src/args.ts. Doctor sections come from DOCTOR_SECTIONS. Daemon subcommands come from the DaemonCommand union in packages/cli/src/bin.ts.',
    limitations:
      'The acp, computer-use, resources, skills, and mcp commands are partitioned into those classes. Command words that are not in these tables or unions are not inferred from help text.',
    digest: `Each command, flag, enum value, doctor section, and daemon subcommand is ${CODE_DIGEST}`,
  },
  acp: {
    method:
      'ACP methods are METHODS keys that do not start with _agnes/. The CLI acp command is the matching COMMANDS entry. The mode function is the exported runAcp declaration in packages/cli/src/modes/acp.ts.',
    limitations:
      'An ACP method moved under the _agnes/ prefix would be classified with daemon RPC. Screens that only call these methods are listed with web, TUI, or channels when those registries name them.',
    digest: `Each ACP method, command, and runAcp declaration is ${CODE_DIGEST}`,
  },
  web: {
    method:
      'Web entries are the FILES allowlist and top-level string constants that start with / in packages/web-server/src/server.ts, plus pathname comparisons against string literals in that file.',
    limitations:
      'Controls inside a page are not separate entries. Page behavior that only calls an RPC method stays on that RPC entry.',
    digest: `Each allowlist literal, path constant, and pathname comparison is ${CODE_DIGEST}`,
  },
  tui: {
    method:
      'TUI commands are the name fields of the SLASH_COMMANDS array in packages/cli-tui/src/commands.ts.',
    limitations:
      'A slash command implemented only in a switch, without a SLASH_COMMANDS name, is not listed. A re-export of the array is not a second registry.',
    digest: `Each slash command is ${CODE_DIGEST} The hashed node is the object in the array.`,
  },
  channel: {
    method:
      'Channel adapters are channel.json manifests under packages/channels/src/adapters. An adapter directory with no manifest is still listed. Channel command names are the CommandName union in packages/channels/src/runner/commands.ts.',
    limitations:
      'Adapter behavior that is not declared in channel.json or CommandName is not a separate entry. The manifest id is the adapter symbol.',
    digest: `Each manifest is ${JSON_DIGEST} A missing manifest is sha256 of the adapter directory name. Each command name is ${CODE_DIGEST}`,
  },
  'computer-use': {
    method:
      'Computer Use entries are METHODS keys beginning with _agnes/v1/computerUse., the computer-use CLI command, verb/action/positional comparisons and validate* includes-arrays in packages/cli/src/commands/computer-use.ts, *-driver-backend.ts files and computer-use-driver-lock.json under packages/host/src/computer-use/ (not under fake/), and profile schema properties named computerUse.',
    limitations:
      'Fake drivers are not host driver entries. Comparisons against status or state fields are not command entries. UI panes that call these methods stay with web or TUI when their own registry names them.',
    digest: `Method keys, command literals, and comparisons are ${CODE_DIGEST} Each driver file is ${BLOB_DIGEST} The driver lock and each profile computerUse value are ${JSON_DIGEST}`,
  },
  'resource-control': {
    method:
      'Resource control entries are keys of RESOURCE_CONTROL_METHODS, the resources/skills/mcp CLI commands, action comparisons and the VALUE_FLAGS and FORBIDDEN_SECRET_FLAGS sets in packages/resource-control-cli/src/resources.ts, exports of packages named resource-control-*, and the service worker kind compared in packages/worker-runtime/src/main.ts.',
    limitations:
      'A file inside a resource-control package is not a separate entry unless it is an export, a method key, a CLI action, or a flag. The session worker kind is listed with daemon RPC.',
    digest: `Method keys, flags, actions, and the worker-kind comparison are ${CODE_DIGEST} Each package export target is ${JSON_DIGEST}`,
  },
  'session-metadata': {
    method:
      'Session title and archive fields are properties named title, archived, or titleSource on protocol schema definitions whose names contain Session. Rename and archive RPC methods are the METHODS keys _agnes/v1/session.rename and _agnes/v1/session.archive. Persistence columns are title, archived, titleSource, and title_source on session tables in CREATE TABLE statements in packages/host/src/adapters and packages/daemon/src/storage. Ledger event types are members of the session-v1 event enum, plus literal alternatives in its extension pattern, whose names are rename, archive, or session-title.',
    limitations:
      'A JSON Schema title keyword is not a session field. The host sessions table is read from its CREATE TABLE; columns other than title, archived, and titleSource are not session-metadata entries. An extension pattern alternative that is only a character class is not turned into an event name.',
    digest: `Schema properties and ledger event definitions are ${JSON_DIGEST} Rename and archive methods are ${CODE_DIGEST} A table column is sha256 of its column clause, because the column is text inside a CREATE TABLE template rather than its own TypeScript node.`,
  },
  extension: {
    method:
      'Plugin and extension entries are the public exports of packages/extension-api (each package.json exports target, and the symbols exported by that entry file after export declarations and export stars are followed with the compiler AST) and the keys of x-agnes-hook-table in packages/protocol/schema/hooks.json.',
    limitations:
      'A symbol that is not reachable from an exports entry is not listed. Export stars are followed only through relative specifiers inside the package; a star that names another package fails closed. A named re-export from another package is digested as that re-export declaration, because the original declaration is outside this package. The hook table is the event registry; payload schemas under other keywords are not separate entries.',
    digest: `Each package export target and each hook event object is ${JSON_DIGEST} Each exported symbol is ${CODE_DIGEST}`,
  },
}

const SESSION_COLUMNS = new Set(['title', 'archived', 'titleSource', 'title_source'])

export function buildInventory(root: string, rev: string): Inventory {
  const tree = GitTree.open(root, rev)
  const files = tree.files()
  const sources = SourceFiles.open(tree, parsePaths(files))
  try {
    const drafts: Draft[] = [
      ...testDrafts(tree, sources, files),
      ...rpcDrafts(sources, files),
      ...cliDrafts(sources),
      ...acpModeDraft(sources),
      ...webDrafts(sources),
      ...tuiDrafts(sources),
      ...channelDrafts(tree, sources, files),
      ...computerUseFileDrafts(tree, files),
      ...profileComputerUseDrafts(tree),
      ...resourcePackageDrafts(tree, files),
      ...workerKindDrafts(sources),
      ...sessionFieldDrafts(tree, files),
      ...sessionColumnDrafts(sources, files),
      ...sessionLedgerDrafts(tree),
      ...extensionDrafts(tree, sources),
    ]
    return finish(tree.rev, drafts)
  } finally {
    sources.close()
  }
}

export function serializeInventory(inventory: Inventory): string {
  return `${JSON.stringify(inventory, null, 2)}\n`
}

export function entryProblems(entry: InventoryEntry): string[] {
  const problems: string[] = []
  if (entry.disposition !== 'preserve' && entry.disposition !== 'map') {
    problems.push(`${entry.id} is missing a preserve or map disposition`)
  }
  if (!/^[a-f0-9]{64}$/.test(entry.digest)) problems.push(`${entry.id} digest is not sha256`)
  if (!entry.path || entry.path.startsWith('/') || entry.path.includes('\\')) {
    problems.push(`${entry.id} path is not a repository path`)
  }
  if (!entry.symbol) problems.push(`${entry.id} symbol is empty`)
  if (!/^[a-z0-9][a-z0-9.:_-]*$/.test(entry.responsibility)) {
    problems.push(`${entry.id} responsibility is not a public name`)
  }
  return problems
}

export function inventoryDifferences(actual: Inventory, expected: Inventory): string[] {
  const problems = [...countProblems(actual), ...countProblems(expected)]
  if (actual.baseline !== expected.baseline) problems.push('baseline differs')
  const expectedById = new Map(expected.entries.map((entry) => [entry.id, entry]))
  const actualIds = new Set<string>()
  for (const entry of actual.entries) {
    problems.push(...entryProblems(entry))
    if (actualIds.has(entry.id)) problems.push(`duplicate entry ${entry.id}`)
    actualIds.add(entry.id)
    const match = expectedById.get(entry.id)
    if (!match) {
      problems.push(`forged entry ${entry.id}`)
      continue
    }
    if (match.digest !== entry.digest) problems.push(`digest mismatch for ${entry.id}`)
    if (match.path !== entry.path || match.symbol !== entry.symbol || match.class !== entry.class) {
      problems.push(`identity mismatch for ${entry.id}`)
    }
  }
  for (const entry of expected.entries) {
    if (!actualIds.has(entry.id)) problems.push(`missing entry ${entry.id}`)
  }
  return problems
}

function countProblems(inventory: Inventory): string[] {
  const problems: string[] = []
  for (const name of INVENTORY_CLASSES) {
    const derived = inventory.entries.filter((entry) => entry.class === name).length
    if (inventory.counts[name] !== derived) {
      problems.push(`${name} count is ${inventory.counts[name]} but ${derived} entries were read`)
    }
  }
  return problems
}

function finish(baseline: string, drafts: readonly Draft[]): Inventory {
  const merged = new Map<string, Draft & { parts: (Buffer | string)[] }>()
  for (const draft of drafts) {
    const id = `${draft.class}|${draft.path}|${draft.symbol}`
    const existing = merged.get(id)
    if (existing) existing.parts.push(draft.bytes)
    else merged.set(id, { ...draft, parts: [draft.bytes] })
  }
  const entries: InventoryEntry[] = [...merged.entries()]
    .map(([id, draft]) => ({
      id,
      class: draft.class,
      path: draft.path,
      symbol: draft.symbol,
      origin: draft.origin,
      digest: sha256Parts(draft.parts),
      disposition: 'preserve' as const,
      responsibility: draft.responsibility,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  for (const entry of entries) {
    const problems = entryProblems(entry)
    if (problems.length > 0) throw new Error(problems.join('; '))
  }
  const counts = Object.fromEntries(
    INVENTORY_CLASSES.map((name) => [name, entries.filter((entry) => entry.class === name).length]),
  ) as Record<InventoryClass, number>
  const discovery = Object.fromEntries(
    INVENTORY_CLASSES.map((name) => [
      name,
      {
        ...DISCOVERY[name],
        sources: [
          ...new Set(entries.filter((entry) => entry.class === name).map((entry) => entry.path)),
        ].sort(),
      },
    ]),
  ) as Record<InventoryClass, DiscoveryNote>
  return { baseline, counts, discovery, entries }
}

function testDrafts(tree: GitTree, sources: SourceFiles, files: readonly string[]): Draft[] {
  const source = sources.file('vitest.shared.ts')
  const include = globsIn(source, 'include')
  const exclude = globsIn(source, 'exclude')
  if (include.length === 0) throw new Error('vitest.shared.ts has no include globs')
  return files
    .filter((path) => include.some((glob) => glob.test(path)) && !exclude.some((glob) => glob.test(path)))
    .map((path) => ({
      class: 'test' as const,
      path,
      symbol: path,
      origin: 'vitest-include',
      bytes: tree.read(path),
      responsibility: testResponsibility(path),
    }))
}

function rpcDrafts(sources: SourceFiles, files: readonly string[]): Draft[] {
  const path = 'packages/protocol/src/methods.ts'
  const sf = sources.file(path)
  const drafts: Draft[] = []
  const names = new Set<string>()
  for (const member of objectMembers(variableInitializer(sf, 'METHODS'))) {
    if (member.kind === 'spread') {
      for (const property of exportedObject(sources, path, member.name)) {
        names.add(property.name)
        drafts.push(rpcDraft(property.path, property.name, property.bytes, 'method-table'))
      }
      continue
    }
    names.add(member.name)
    drafts.push(rpcDraft(path, member.name, nodeText(member.node), 'method-table'))
  }
  const declared = new Set<string>()
  for (const statement of sf.statements) {
    if (!isTypeAliasDeclaration(statement) || statement.name.text !== 'MethodName') continue
    for (const name of stringUnion(statement.type)) declared.add(name)
  }
  for (const name of declared) {
    if (!names.has(name)) throw new Error(`method union names ${name} but the method table has no such key`)
  }
  for (const file of files.filter(
    (item) => item.startsWith('packages/daemon/src/local/methods/') && item.endsWith('.ts'),
  )) {
    const local = sources.file(file)
    for (const call of registerCalls(local)) {
      const argument = call.arguments[0]
      if (!argument || !isStringLike(argument)) {
        drafts.push({
          class: 'daemon-rpc',
          path: file,
          symbol: 'non-literal',
          origin: 'daemon-register',
          bytes: nodeText(call),
          responsibility: 'daemon-rpc:unparsed',
        })
        continue
      }
      if (names.has(argument.text)) continue
      names.add(argument.text)
      drafts.push(rpcDraft(file, argument.text, nodeText(call), 'daemon-register'))
    }
  }
  return drafts
}

function rpcDraft(path: string, symbol: string, bytes: string, origin: string): Draft {
  const kind = rpcClass(symbol)
  return { class: kind.className, path, symbol, origin, bytes, responsibility: kind.responsibility }
}

function rpcClass(symbol: string): { className: InventoryClass; responsibility: string } {
  if (symbol.startsWith('_agnes/v1/computerUse.'))
    return { className: 'computer-use', responsibility: 'computer-use' }
  if (
    symbol.startsWith('_agnes/v1/resources.') ||
    symbol.startsWith('_agnes/v1/skills.') ||
    symbol.startsWith('_agnes/v1/mcp.')
  ) {
    return { className: 'resource-control', responsibility: 'resource-control' }
  }
  if (symbol === '_agnes/v1/session.rename' || symbol === '_agnes/v1/session.archive') {
    return { className: 'session-metadata', responsibility: 'session-metadata' }
  }
  if (!symbol.startsWith('_agnes/')) return { className: 'acp', responsibility: 'acp' }
  const family = publicSegment(symbol.slice('_agnes/v1/'.length).split('.')[0] || 'method')
  return { className: 'daemon-rpc', responsibility: `daemon-rpc:${family}` }
}

function publicSegment(segment: string): string {
  const name = segment.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace(/^-/, '')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`method family ${segment} is not a public name`)
  return name
}

function cliDrafts(sources: SourceFiles): Draft[] {
  const path = 'packages/cli/src/args.ts'
  const sf = sources.file(path)
  const drafts: Draft[] = []
  for (const name of ['COMMANDS', 'FORWARDED']) {
    const items = literalNodes(variableInitializer(sf, name))
    if (!items) throw new Error(`${path} ${name} is not a string set`)
    for (const item of items) {
      const partitioned = commandClass(item.text)
      drafts.push({
        class: partitioned,
        path,
        symbol: item.text,
        origin: 'cli-table',
        bytes: nodeText(item.node),
        responsibility: partitioned === 'cli' ? 'cli' : partitioned,
      })
    }
  }
  for (const name of ['VALUE_FLAGS', 'BOOL_FLAGS']) {
    for (const member of objectMembers(variableInitializer(sf, name))) {
      if (member.kind !== 'property') continue
      drafts.push({
        class: 'cli',
        path,
        symbol: member.name,
        origin: 'cli-table',
        bytes: nodeText(member.node),
        responsibility: 'cli',
      })
    }
  }
  for (const member of objectMembers(variableInitializer(sf, 'ENUMS'))) {
    if (member.kind !== 'property' || !member.initializer) continue
    const values = literalNodes(member.initializer)
    if (!values) throw new Error(`${path} enum ${member.name} is not a string list`)
    for (const value of values) {
      drafts.push({
        class: 'cli',
        path,
        symbol: `${member.name}=${value.text}`,
        origin: 'cli-table',
        bytes: nodeText(value.node),
        responsibility: 'cli',
      })
    }
  }
  const doctor = 'packages/cli/src/commands/doctor.ts'
  const doctorSource = sources.file(doctor)
  const sections = literalNodes(variableInitializer(doctorSource, 'DOCTOR_SECTIONS'))
  if (!sections) throw new Error('DOCTOR_SECTIONS is not a string list')
  for (const section of sections) {
    drafts.push({
      class: 'cli',
      path: doctor,
      symbol: `doctor ${section.text}`,
      origin: 'cli-table',
      bytes: nodeText(section.node),
      responsibility: 'cli',
    })
  }
  const bin = 'packages/cli/src/bin.ts'
  const binSource = sources.file(bin)
  for (const command of unionMembers(binSource, 'DaemonCommand')) {
    drafts.push({
      class: 'cli',
      path: bin,
      symbol: `daemon ${command.text}`,
      origin: 'cli-table',
      bytes: nodeText(command.node),
      responsibility: 'cli',
    })
  }
  const computerUse = 'packages/cli/src/commands/computer-use.ts'
  const computerSource = sources.file(computerUse)
  for (const match of comparedStrings(
    computerSource,
    (other) => isNamed(other, 'verb') || isNamed(other, 'action') || isPositional(other),
  )) {
    drafts.push({
      class: 'computer-use',
      path: computerUse,
      symbol: match.text,
      origin: 'cli-comparison',
      bytes: nodeText(match.node),
      responsibility: 'computer-use',
    })
  }
  for (const fn of functionsNamed(computerSource, 'validate')) {
    for (const array of includesArrays(fn)) {
      for (const element of arrayElements(array)) {
        if (!isStringLike(element)) continue
        drafts.push({
          class: 'computer-use',
          path: computerUse,
          symbol: element.text,
          origin: 'cli-comparison',
          bytes: nodeText(element),
          responsibility: 'computer-use',
        })
      }
    }
  }
  const resources = 'packages/resource-control-cli/src/resources.ts'
  const resourceSource = sources.file(resources)
  for (const name of ['VALUE_FLAGS', 'FORBIDDEN_SECRET_FLAGS']) {
    const flags = literalNodes(variableInitializer(resourceSource, name))
    if (!flags) throw new Error(`${resources} ${name} is not a string set`)
    for (const flag of flags) {
      drafts.push({
        class: 'resource-control',
        path: resources,
        symbol: flag.text,
        origin: 'cli-table',
        bytes: nodeText(flag.node),
        responsibility: 'resource-control',
      })
    }
  }
  for (const match of comparedStrings(
    resourceSource,
    (other) => isNamed(other, 'action') || isAccessNamed(other, 'action'),
  )) {
    drafts.push({
      class: 'resource-control',
      path: resources,
      symbol: match.text,
      origin: 'cli-comparison',
      bytes: nodeText(match.node),
      responsibility: 'resource-control',
    })
  }
  return drafts
}

function acpModeDraft(sources: SourceFiles): Draft[] {
  const path = 'packages/cli/src/modes/acp.ts'
  const sf = sources.file(path)
  const fn = localExportNodes(sf).find((item) => item.name === 'runAcp')
  if (!fn) throw new Error('packages/cli/src/modes/acp.ts does not export runAcp')
  return [
    {
      class: 'acp',
      path,
      symbol: 'runAcp',
      origin: 'mode-function',
      bytes: nodeText(fn.node),
      responsibility: 'acp',
    },
  ]
}

function webDrafts(sources: SourceFiles): Draft[] {
  const path = 'packages/web-server/src/server.ts'
  const sf = sources.file(path)
  const drafts: Draft[] = []
  const files = literalNodes(variableInitializer(sf, 'FILES'))
  if (!files) throw new Error('web server FILES allowlist is not a string set')
  for (const file of files) {
    drafts.push({
      class: 'web',
      path,
      symbol: file.text,
      origin: 'web-allowlist',
      bytes: nodeText(file.node),
      responsibility: 'web',
    })
  }
  for (const constant of topLevelStringConstants(sf)) {
    if (!constant.text.startsWith('/')) continue
    drafts.push({
      class: 'web',
      path,
      symbol: constant.text,
      origin: 'web-route',
      bytes: nodeText(constant.node),
      responsibility: 'web',
    })
  }
  for (const match of comparedStrings(sf, isPathname)) {
    if (!match.text.startsWith('/')) continue
    drafts.push({
      class: 'web',
      path,
      symbol: match.text,
      origin: 'web-route',
      bytes: nodeText(match.node),
      responsibility: 'web',
    })
  }
  return drafts
}

function tuiDrafts(sources: SourceFiles): Draft[] {
  const path = 'packages/cli-tui/src/commands.ts'
  const sf = sources.file(path)
  const value = unwrap(variableInitializer(sf, 'SLASH_COMMANDS'))
  const elements = arrayElements(value)
  if (elements.length === 0) throw new Error('SLASH_COMMANDS is not an array')
  const drafts: Draft[] = []
  for (const element of elements) {
    const literal = unwrap(element as Expression)
    const members = objectMembers(literal)
    const nameProperty = members.find((member) => member.kind === 'property' && member.name === 'name')
    const nameValue =
      nameProperty?.kind === 'property' && nameProperty.initializer
        ? unwrap(nameProperty.initializer)
        : undefined
    if (!nameValue || !isStringLike(nameValue)) throw new Error('SLASH_COMMANDS entry has no string name')
    drafts.push({
      class: 'tui',
      path,
      symbol: nameValue.text,
      origin: 'tui-table',
      bytes: nodeText(element),
      responsibility: 'tui',
    })
  }
  return drafts
}

function channelDrafts(tree: GitTree, sources: SourceFiles, files: readonly string[]): Draft[] {
  const drafts: Draft[] = []
  const manifests = files.filter((path) =>
    /^packages\/channels\/src\/adapters\/[^/]+\/channel\.json$/.test(path),
  )
  const adapters = new Set(
    files.flatMap((path) => {
      const match = /^packages\/channels\/src\/adapters\/([^/]+)\//.exec(path)
      return match?.[1] ? [match[1]] : []
    }),
  )
  for (const id of [...adapters].sort()) {
    const path = `packages/channels/src/adapters/${id}/channel.json`
    if (!manifests.includes(path)) {
      drafts.push({
        class: 'channel',
        path: `packages/channels/src/adapters/${id}`,
        symbol: 'missing-manifest',
        origin: 'channel-manifest',
        bytes: id,
        responsibility: 'channel',
      })
      continue
    }
    const parsed = JSON.parse(tree.text(path)) as { id?: unknown }
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) throw new Error(`${path} has no string id`)
    drafts.push({
      class: 'channel',
      path,
      symbol: parsed.id,
      origin: 'channel-manifest',
      bytes: jcs(parsed),
      responsibility: 'channel',
    })
  }
  const commands = 'packages/channels/src/runner/commands.ts'
  const names = unionMembers(sources.file(commands), 'CommandName')
  if (names.length === 0) throw new Error('CommandName has no string names')
  for (const name of names) {
    drafts.push({
      class: 'channel',
      path: commands,
      symbol: name.text,
      origin: 'channel-command',
      bytes: nodeText(name.node),
      responsibility: 'channel',
    })
  }
  return drafts
}

function computerUseFileDrafts(tree: GitTree, files: readonly string[]): Draft[] {
  const drivers = files.filter((path) =>
    /^packages\/host\/src\/computer-use\/[^/]*-driver-backend\.ts$/.test(path),
  )
  if (drivers.length === 0) throw new Error('no computer-use driver backend files at this baseline')
  const lock = 'packages/host/src/computer-use/computer-use-driver-lock.json'
  if (!files.includes(lock)) throw new Error('computer-use driver lock is not in the baseline tree')
  const driverDrafts = drivers.map((path) => ({
    class: 'computer-use' as const,
    path,
    symbol: path.split('/').at(-1) ?? path,
    origin: 'driver-file',
    bytes: tree.read(path),
    responsibility: 'computer-use',
  }))
  return [
    ...driverDrafts,
    {
      class: 'computer-use',
      path: lock,
      symbol: 'computer-use-driver-lock.json',
      origin: 'driver-lock',
      bytes: jcs(JSON.parse(tree.text(lock)) as unknown),
      responsibility: 'computer-use',
    },
  ]
}

function profileComputerUseDrafts(tree: GitTree): Draft[] {
  const path = 'packages/protocol/schema/profile.json'
  const parsed = JSON.parse(requireText(tree, path)) as unknown
  const drafts: Draft[] = []
  walkSchema(parsed, '', (_pointer, key, value) => {
    if (key !== 'computerUse') return
    drafts.push({
      class: 'computer-use',
      path,
      symbol: _pointer,
      origin: 'profile-schema',
      bytes: jcs(value),
      responsibility: 'computer-use',
    })
  })
  if (drafts.length === 0) throw new Error('profile schema has no computerUse property')
  return drafts
}

function resourcePackageDrafts(tree: GitTree, files: readonly string[]): Draft[] {
  const drafts: Draft[] = []
  for (const path of files.filter((item) => /^packages\/resource-control-[^/]+\/package\.json$/.test(item))) {
    const parsed = JSON.parse(tree.text(path)) as { name?: unknown; exports?: unknown }
    if (typeof parsed.name !== 'string' || !parsed.name.startsWith('@agnes/resource-control')) {
      throw new Error(`${path} is not a resource-control package`)
    }
    if (!parsed.exports || typeof parsed.exports !== 'object' || Array.isArray(parsed.exports)) {
      throw new Error(`${path} has no exports object`)
    }
    for (const [symbol, value] of Object.entries(parsed.exports).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      drafts.push({
        class: 'resource-control',
        path,
        symbol,
        origin: 'package-export',
        bytes: jcs(value),
        responsibility: 'resource-control',
      })
    }
  }
  if (drafts.length === 0) throw new Error('no resource-control package exports at this baseline')
  return drafts
}

function workerKindDrafts(sources: SourceFiles): Draft[] {
  const path = 'packages/worker-runtime/src/main.ts'
  const sf = sources.file(path)
  return comparedStrings(sf, (other) => isNamed(other, 'workerKind')).map((match) => ({
    class: match.text === 'service' ? 'resource-control' : 'daemon-rpc',
    path,
    symbol: `worker-kind:${match.text}`,
    origin: 'worker-kind',
    bytes: nodeText(match.node),
    responsibility: match.text === 'service' ? 'resource-control' : 'daemon-rpc:worker',
  }))
}

function sessionFieldDrafts(tree: GitTree, files: readonly string[]): Draft[] {
  const drafts: Draft[] = []
  for (const path of files.filter(
    (item) => item.startsWith('packages/protocol/schema/') && item.endsWith('.json'),
  )) {
    const parsed = parsedJson(tree, path)
    for (const [name, definition] of Object.entries(defsOf(parsed)).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!name.includes('Session') || !definition || typeof definition !== 'object') continue
      const properties = (definition as { properties?: unknown }).properties
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) continue
      for (const key of ['archived', 'title', 'titleSource'] as const) {
        if (!Object.hasOwn(properties, key)) continue
        drafts.push({
          class: 'session-metadata',
          path,
          symbol: `${name}.${key}`,
          origin: 'session-schema',
          bytes: jcs((properties as Record<string, unknown>)[key]),
          responsibility: 'session-metadata',
        })
      }
    }
  }
  if (drafts.length === 0) throw new Error('no session title or archive fields at this baseline')
  return drafts
}

function sessionColumnDrafts(sources: SourceFiles, files: readonly string[]): Draft[] {
  if (!files.includes('packages/host/src/adapters/ddl.ts'))
    throw new Error('host session DDL is not in the baseline tree')
  const drafts: Draft[] = []
  for (const path of files.filter(isStorageAdapter)) {
    for (const sql of sqlTexts(sources.file(path))) {
      for (const column of sessionColumns(sql)) {
        drafts.push({
          class: 'session-metadata',
          path,
          symbol: `${column.table}.${column.name}`,
          origin: 'session-table',
          bytes: column.clause,
          responsibility: 'session-metadata',
        })
      }
    }
  }
  return drafts
}

function sessionLedgerDrafts(tree: GitTree): Draft[] {
  const path = 'packages/protocol/schema/session-v1.json'
  const envelope = defsOf(parsedJson(tree, path)).EventEnvelope
  const type =
    envelope && typeof envelope === 'object'
      ? (envelope as { properties?: { type?: unknown } }).properties?.type
      : undefined
  if (!type || typeof type !== 'object') throw new Error('session ledger schema has no event type')
  const drafts: Draft[] = []
  for (const branch of schemaBranches(type)) {
    if (!branch || typeof branch !== 'object') continue
    const record = branch as { enum?: unknown; pattern?: unknown }
    if (Array.isArray(record.enum)) {
      for (const item of record.enum) {
        if (typeof item !== 'string' || !isSessionLedgerName(item)) continue
        drafts.push(ledgerDraft(path, item, jcs(item)))
      }
    }
    if (typeof record.pattern === 'string' && patternNamesSessionTitle(record.pattern)) {
      drafts.push(ledgerDraft(path, 'x/host/session-title', jcs(branch)))
    }
  }
  return drafts
}

function extensionDrafts(tree: GitTree, sources: SourceFiles): Draft[] {
  const manifest = 'packages/extension-api/package.json'
  const parsed = parsedJson(tree, manifest) as { exports?: unknown }
  if (!parsed.exports || typeof parsed.exports !== 'object' || Array.isArray(parsed.exports)) {
    throw new Error('extension package has no exports object')
  }
  const drafts: Draft[] = []
  const seen = new Set<string>()
  for (const [symbol, value] of Object.entries(parsed.exports).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    drafts.push({
      class: 'extension',
      path: manifest,
      symbol,
      origin: 'package-export',
      bytes: jcs(value),
      responsibility: 'extension',
    })
    const entry = packageEntry(symbol, value)
    if (seen.has(entry)) continue
    seen.add(entry)
    for (const item of [...exportsOf(sources, entry, new Set(), new Map()).entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      drafts.push({
        class: 'extension',
        path: item[1].path,
        symbol: item[0],
        origin: 'export-symbol',
        bytes: nodeText(item[1].node),
        responsibility: 'extension',
      })
    }
  }
  if (!drafts.some((draft) => draft.origin === 'export-symbol'))
    throw new Error('extension entries export no symbols')
  const hooks = 'packages/protocol/schema/hooks.json'
  const table = (parsedJson(tree, hooks) as { 'x-agnes-hook-table'?: unknown })['x-agnes-hook-table']
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('hook table is missing')
  const events = Object.entries(table).sort(([left], [right]) => left.localeCompare(right))
  if (events.length === 0) throw new Error('hook table has no events')
  for (const [symbol, value] of events) {
    drafts.push({
      class: 'extension',
      path: hooks,
      symbol,
      origin: 'hook-table',
      bytes: jcs(value),
      responsibility: 'extension',
    })
  }
  return drafts
}

function parsePaths(files: readonly string[]): string[] {
  const prefixes = [
    'packages/protocol/src/',
    'packages/resource-control-contracts/src/',
    'packages/daemon/src/local/methods/',
    'packages/extension-api/src/',
    'packages/extension-api/testkit/',
    'packages/host/src/adapters/',
    'packages/daemon/src/storage/',
  ]
  const exact = new Set([
    'vitest.shared.ts',
    'packages/cli/src/args.ts',
    'packages/cli/src/bin.ts',
    'packages/cli/src/commands/doctor.ts',
    'packages/cli/src/commands/computer-use.ts',
    'packages/cli/src/modes/acp.ts',
    'packages/resource-control-cli/src/resources.ts',
    'packages/web-server/src/server.ts',
    'packages/cli-tui/src/commands.ts',
    'packages/channels/src/runner/commands.ts',
    'packages/worker-runtime/src/main.ts',
  ])
  return files.filter(
    (path) =>
      path.endsWith('.ts') &&
      !path.endsWith('.d.ts') &&
      (exact.has(path) || prefixes.some((prefix) => path.startsWith(prefix))),
  )
}

function exportedObject(
  sources: SourceFiles,
  from: string,
  localName: string,
): { path: string; name: string; bytes: string }[] {
  const seen = new Set<string>()
  const load = (path: string, name: string): { path: string; name: string; bytes: string }[] => {
    const key = `${path}#${name}`
    if (seen.has(key)) throw new Error(`cyclic export while resolving ${name}`)
    seen.add(key)
    const sf = sources.file(path)
    const initializer = initializerNamed(sf, name)
    if (initializer) {
      return objectMembers(initializer).map((member) => {
        if (member.kind === 'spread') throw new Error(`${path} ${name} spreads another table`)
        return { path, name: member.name, bytes: nodeText(member.node) }
      })
    }
    const exported = reexportedFrom(sf, name)
    if (exported) return load(resolveRelative(path, exported.specifier), exported.local)
    const imported = importedFrom(sf, name)
    if (imported) return load(resolveRelative(path, imported.specifier), imported.exported)
    throw new Error(`${path} does not define ${name}`)
  }
  const imported = importedFrom(sources.file(from), localName)
  if (!imported) throw new Error(`${from} does not import ${localName}`)
  return load(resolveRelative(from, imported.specifier), imported.exported)
}

type Defined = { path: string; node: Node }

function exportsOf(
  sources: SourceFiles,
  path: string,
  stack: Set<string>,
  cache: Map<string, Map<string, Defined>>,
): Map<string, Defined> {
  const cached = cache.get(path)
  if (cached) return cached
  if (stack.has(path)) throw new Error(`cyclic export while reading ${path}`)
  stack.add(path)
  const sf = sources.file(path)
  const map = new Map<string, Defined>()
  for (const specifier of exportStars(sf)) {
    if (!specifier.startsWith('.'))
      throw new Error(`${path} export star imports ${specifier} by package name`)
    for (const [name, defined] of exportsOf(sources, resolveRelative(path, specifier), stack, cache)) {
      const existing = map.get(name)
      if (
        existing &&
        (existing.path !== defined.path || nodeText(existing.node) !== nodeText(defined.node))
      ) {
        throw new Error(`${path} export star conflicts on ${name}`)
      }
      map.set(name, defined)
    }
  }
  for (const item of namedReexports(sf)) {
    if (item.specifier && !item.specifier.startsWith('.')) {
      map.set(item.exported, { path, node: item.node })
      continue
    }
    if (item.specifier) {
      const defined = exportsOf(sources, resolveRelative(path, item.specifier), stack, cache).get(item.local)
      if (!defined) throw new Error(`${item.specifier} does not export ${item.local}`)
      map.set(item.exported, defined)
      continue
    }
    const local = declarationNamed(sf, item.local)
    if (!local) throw new Error(`${path} does not declare ${item.local}`)
    map.set(item.exported, { path, node: local })
  }
  for (const item of localExportNodes(sf)) map.set(item.name, { path, node: item.node })
  stack.delete(path)
  cache.set(path, map)
  return map
}

function declarationNamed(sf: SourceFile, name: string): Node | undefined {
  for (const statement of sf.statements) {
    if (
      (isFunctionDeclaration(statement) ||
        isClassDeclaration(statement) ||
        isInterfaceDeclaration(statement) ||
        isTypeAliasDeclaration(statement) ||
        isEnumDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return statement
    }
    if (!isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (isIdentifier(declaration.name) && declaration.name.text === name) return declaration
    }
  }
  return undefined
}

function packageEntry(symbol: string, value: unknown): string {
  const spec = exportSpecifier(value)
  if (!spec.startsWith('./')) throw new Error(`extension export ${symbol} is not a relative path`)
  let path = `packages/extension-api/${spec.slice(2)}`
  if (path.endsWith('.js')) path = `${path.slice(0, -3)}.ts`
  if (path.endsWith('.d.ts')) path = `${path.slice(0, -5)}.ts`
  return path
}

function exportSpecifier(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('extension export target is not a path')
  const record = value as Record<string, unknown>
  const preferred = record.import ?? record.default ?? record.types ?? record.require
  if (typeof preferred !== 'string') throw new Error('extension export target has no path')
  return preferred
}

function registerCalls(sf: SourceFile): CallExpression[] {
  const found: CallExpression[] = []
  walk(sf, (node) => {
    if (
      !isCallExpression(node) ||
      !isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== 'register'
    )
      return
    found.push(node)
  })
  return found
}

function globsIn(sf: SourceFile, property: 'include' | 'exclude'): RegExp[] {
  const patterns: string[] = []
  walk(sf, (node) => {
    if (isPropertyAssignment(node) && propertyName(node.name) === property && node.initializer) {
      const items = stringLiterals(node.initializer)
      if (items) patterns.push(...items)
    }
    if (
      property === 'exclude' &&
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === 'exclude' &&
      node.initializer
    ) {
      collectStrings(node.initializer, patterns)
    }
  })
  return [...new Set(patterns.flatMap(expandBraces))].map(globToRegExp)
}

function collectStrings(expression: Expression, into: string[]): void {
  const value = unwrap(expression)
  const elements = arrayElements(value)
  for (const element of elements) {
    if (isStringLike(element)) into.push(element.text)
    else if (isSpreadElement(element)) collectStrings(element.expression, into)
  }
}

function literalNodes(expression: Expression): { text: string; node: Node }[] | undefined {
  const value = unwrap(expression)
  const elements = arrayElements(value)
  if (!isArrayLiteralExpression(value)) return undefined
  const items: { text: string; node: Node }[] = []
  for (const element of elements) {
    if (!isStringLike(element)) return undefined
    items.push({ text: element.text, node: element })
  }
  return items
}

function unionMembers(sf: SourceFile, name: string): { text: string; node: Node }[] {
  const alias = sf.statements.find(
    (statement) => isTypeAliasDeclaration(statement) && statement.name.text === name,
  )
  if (!alias || !isTypeAliasDeclaration(alias)) return []
  return literalTypeNodes(alias.type)
}

function literalTypeNodes(type: Node | undefined): { text: string; node: Node }[] {
  if (!type) return []
  if (isParenthesizedTypeNode(type)) return literalTypeNodes(type.type)
  if (isLiteralTypeNode(type))
    return isStringLike(type.literal) ? [{ text: type.literal.text, node: type.literal }] : []
  if (!isUnionTypeNode(type)) return []
  return type.types.flatMap((part) => literalTypeNodes(part))
}

function initializerNamed(sf: SourceFile, name: string): Expression | undefined {
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
  return found
}

function sqlTexts(sf: SourceFile): string[] {
  const found: string[] = []
  walk(sf, (node) => {
    if (
      (node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral) &&
      'text' in node
    ) {
      const text = (node as { text: string }).text
      if (text.toUpperCase().includes('CREATE TABLE')) found.push(text)
    }
    if (isTemplateExpression(node) && node.getText().toUpperCase().includes('CREATE TABLE')) {
      throw new Error(`${repositoryPath(sf)} interpolates a CREATE TABLE`)
    }
  })
  return found
}

function sessionColumns(sql: string): { table: string; name: string; clause: string }[] {
  const found: { table: string; name: string; clause: string }[] = []
  const upper = sql.toUpperCase()
  let index = 0
  while (index < sql.length) {
    const at = upper.indexOf('CREATE TABLE', index)
    if (at < 0) break
    let cursor = skipSpace(sql, at + 'CREATE TABLE'.length)
    if (upper.startsWith('IF NOT EXISTS', cursor)) cursor = skipSpace(sql, cursor + 'IF NOT EXISTS'.length)
    const table = readIdentifier(sql, cursor)
    if (!table) break
    cursor = skipSpace(sql, table.next)
    if (sql[cursor] !== '(') {
      index = cursor + 1
      continue
    }
    const body = readBalanced(sql, cursor)
    if (table.text.toLowerCase().includes('session')) {
      for (const clause of splitColumns(body.inner)) {
        const name = clause.trim().split(/\s+/)[0] ?? ''
        if (SESSION_COLUMNS.has(name)) found.push({ table: table.text, name, clause: clause.trim() })
      }
    }
    index = body.next
  }
  return found
}

function schemaBranches(type: object): unknown[] {
  const record = type as { anyOf?: unknown; oneOf?: unknown }
  const list = record.anyOf ?? record.oneOf
  return Array.isArray(list) ? list : [type]
}

function isSessionLedgerName(name: string): boolean {
  const text = name.toLowerCase()
  return text.includes('rename') || text.includes('archiv') || text.includes('session-title')
}

function patternNamesSessionTitle(pattern: string): boolean {
  if (!pattern.includes('x\\/') && !pattern.includes('x/')) return false
  let inClass = false
  let escaped = false
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? ''
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    if (
      !inClass &&
      (pattern.startsWith('host/session-title', index) || pattern.startsWith('host\\/session-title', index))
    ) {
      return true
    }
  }
  return false
}

function ledgerDraft(path: string, symbol: string, bytes: string): Draft {
  return {
    class: 'session-metadata',
    path,
    symbol,
    origin: 'ledger-event',
    bytes,
    responsibility: 'session-metadata',
  }
}

function isStorageAdapter(path: string): boolean {
  return (
    (path.startsWith('packages/host/src/adapters/') || path.startsWith('packages/daemon/src/storage/')) &&
    path.endsWith('.ts')
  )
}

function isPathname(expression: Expression): boolean {
  if (isNamed(expression, 'pathname')) return true
  return isAccessNamed(expression, 'pathname')
}

function commandClass(symbol: string): InventoryClass {
  if (symbol === 'acp') return 'acp'
  if (symbol === 'computer-use') return 'computer-use'
  if (symbol === 'resources' || symbol === 'skills' || symbol === 'mcp') return 'resource-control'
  return 'cli'
}

function testResponsibility(path: string): string {
  const [top, second] = path.split('/')
  if (top === 'packages' && second) return `test:${second}`
  if (top === 'tools' && second) return `test:${second}`
  if (top === 'examples') return 'test:examples'
  return `test:${top ?? 'root'}`
}

function walkSchema(
  value: unknown,
  pointer: string,
  visit: (pointer: string, key: string, value: unknown) => void,
): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1)
      walkSchema(value[index], `${pointer}/${index}`, visit)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    const next = `${pointer}/${key}`
    visit(next, key, child)
    walkSchema(child, next, visit)
  }
}

function defsOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as { $defs?: unknown; definitions?: unknown }
  const defs = record.$defs ?? record.definitions
  if (!defs || typeof defs !== 'object' || Array.isArray(defs)) return {}
  return defs as Record<string, unknown>
}

function parsedJson(tree: GitTree, path: string): unknown {
  try {
    return JSON.parse(tree.text(path)) as unknown
  } catch {
    throw new Error(`${path} is not JSON`)
  }
}

function requireText(tree: GitTree, path: string): string {
  return tree.text(path)
}

function repositoryPath(sf: SourceFile): string {
  const marker = 'packages/'
  const index = sf.fileName.lastIndexOf(marker)
  return index >= 0 ? sf.fileName.slice(index) : sf.fileName
}

function sha256Parts(parts: readonly (Buffer | string)[]): string {
  const hash = createHash('sha256')
  parts.forEach((part, index) => {
    if (index > 0) hash.update('\n')
    hash.update(part)
  })
  return hash.digest('hex')
}

function jcs(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      if (Object.is(value, -0)) return '0'
      throw new Error('JSON canonicalization cannot encode a non-finite number')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => jcs(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${keys.map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`).join(',')}}`
  }
  throw new Error('JSON canonicalization cannot encode this value')
}

function expandBraces(glob: string): string[] {
  const match = /\{([^{}]+)\}/.exec(glob)
  if (!match || match.index === undefined) return [glob]
  const options = match[1]?.split(',') ?? []
  return options.flatMap((option) =>
    expandBraces(`${glob.slice(0, match.index)}${option}${glob.slice(match.index + match[0].length)}`),
  )
}

function globToRegExp(glob: string): RegExp {
  let body = ''
  for (let index = 0; index < glob.length; ) {
    if (glob.startsWith('**/', index)) {
      body += '(?:.*/)?'
      index += 3
      continue
    }
    if (glob.startsWith('**', index)) {
      body += '.*'
      index += 2
      continue
    }
    const char = glob[index] ?? ''
    if (char === '*') body += '[^/]*'
    else if (char === '?') body += '[^/]'
    else body += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    index += 1
  }
  return new RegExp(`^${body}$`)
}

function skipSpace(text: string, index: number): number {
  let cursor = index
  while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor += 1
  return cursor
}

function readIdentifier(text: string, index: number): { text: string; next: number } | undefined {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index))
  if (!match) return undefined
  return { text: match[0], next: index + match[0].length }
}

function readBalanced(text: string, open: number): { inner: string; next: number } {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return { inner: text.slice(open + 1, index), next: index + 1 }
    }
  }
  throw new Error('CREATE TABLE is missing its closing parenthesis')
}

function splitColumns(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(body.slice(start, index))
      start = index + 1
    }
  }
  parts.push(body.slice(start))
  return parts.filter((part) => part.trim().length > 0)
}
