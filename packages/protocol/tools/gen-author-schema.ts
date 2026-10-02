import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boundedCanonicalJson } from '../../protocol-validation/src/byte-budget.js'
import {
  validateAuthorSchemaIdentity,
  validateOwnedAuthorSchemaSource,
} from '../src/runtime/author-schema-source.js'
import { AUTHOR_SCHEMA_LIMITS, SCHEMA_NAME, schemaObject } from '../src/runtime/author-schema-subset.js'
import type { PluginAuthorMetadata } from '../src/runtime/public.js'
import { validateRuntime } from '../src/runtime/public.js'
import { runtimeSchemaDocument, type SchemaDefinition } from '../src/runtime/schema-document.js'
import { mapAuthorSchemaPositions, normalizeAuthorSchemaDocument } from './author-schema-document.js'
import { parseAuthorSchemaJson } from './author-schema-json.js'
import { generateAuthorSchemaModule } from './gen-author-schema-types.js'

type SourceEntry = NonNullable<PluginAuthorMetadata['schemaSources']>[number]
export type LockedSchemaPackage = {
  packageId: string
  version: string
  packageDigest: string
  manifestDigest: string
  packageRoot: string
  sources: readonly { name: string; typeId: string; revision: number; path: string; fileDigest: string }[]
}
export type AuthorSchemaGenerateOptions = {
  packageRoot: string
  sources: readonly SourceEntry[]
  lockedSchemas: readonly LockedSchemaPackage[]
}
type SourceFile = { owner: string; root: string; entry: SourceEntry; expectedDigest?: string }
function fail(message: string): never {
  throw new TypeError(`Author schema generation failed: ${message}`)
}
function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function readBounded(path: string, maxBytes: number): Uint8Array {
  if (!statSync(path).isFile()) fail('source must be a file')
  const file = openSync(path, 'r'),
    buffer = Buffer.alloc(maxBytes + 1)
  let size = 0
  try {
    while (size < buffer.length) {
      const read = readSync(file, buffer, size, buffer.length - size, null)
      if (!read) break
      size += read
    }
  } finally {
    closeSync(file)
  }
  if (size > maxBytes) fail('source byte quota')
  return buffer.subarray(0, size)
}
function jsonFile(path: string, maxBytes = 1048576): unknown {
  return parseAuthorSchemaJson(new TextDecoder('utf-8', { fatal: true }).decode(readBounded(path, maxBytes)))
}
function inside(root: string, path: string): boolean {
  const distance = relative(root, path)
  return distance === '' || (!isAbsolute(distance) && distance !== '..' && !distance.startsWith(`..${sep}`))
}
function sourcePath(root: string, path: string): string {
  if (
    !/^\.\//.test(path) ||
    path.includes('\\') ||
    [...path].some(
      (character) =>
        character.charCodeAt(0) < 32 || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
    ) ||
    path
      .slice(2)
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    !path.endsWith('.json')
  )
    fail('invalid source path')
  const actual = realpathSync(resolve(root, path))
  if (!inside(root, actual)) fail('source escapes its package')
  return actual
}
function owner(root: string): string {
  const metadata = jsonFile(join(root, 'package.json'))
  if (!schemaObject(metadata) || typeof metadata.name !== 'string' || metadata.name.length === 0)
    fail('package name is required')
  return metadata.name
}
function key(owner: string, name: string): string {
  return `${owner}\0${name}`
}
function graphName(owner: string, source: string, name: string): string {
  return `D_${Buffer.from(owner, 'utf8').toString('hex')}_${Buffer.from(source, 'utf8').toString('hex')}_${Buffer.from(name, 'utf8').toString('hex')}`
}
function sourceArray(value: unknown): readonly SourceEntry[] {
  if (!Array.isArray(value)) fail('sources must be an array')
  const result = validateRuntime('PluginAuthorMetadata', { schemaSources: value })
  if (!result.ok) fail('invalid schemaSources')
  return result.value.schemaSources ?? []
}
function lockedArray(value: unknown): readonly LockedSchemaPackage[] {
  const checked = boundedCanonicalJson(value, { maxBytes: 1048576, maxDepth: 16, maxMembers: 10000 })
  if (!checked.ok || !Array.isArray(checked.value.json)) fail('invalid locked schemas')
  for (const item of checked.value.json) {
    if (
      !schemaObject(item) ||
      Object.keys(item).sort().join(',') !==
        'manifestDigest,packageDigest,packageId,packageRoot,sources,version' ||
      !['packageId', 'packageRoot', 'version'].every((field) => typeof item[field] === 'string') ||
      !['packageDigest', 'manifestDigest'].every(
        (field) => typeof item[field] === 'string' && /^[0-9a-f]{64}$/.test(item[field] as string),
      ) ||
      !Array.isArray(item.sources)
    )
      fail('invalid locked package')
    for (const source of item.sources)
      if (
        !schemaObject(source) ||
        Object.keys(source).sort().join(',') !== 'fileDigest,name,path,revision,typeId' ||
        typeof source.fileDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(source.fileDigest)
      )
        fail('invalid locked source')
  }
  return checked.value.json as unknown as LockedSchemaPackage[]
}

/** Generates files without importing a plugin entry or executing a business handler. */
export function generateOwnedAuthorSchemas(options: AuthorSchemaGenerateOptions): Record<string, string> {
  const root = realpathSync(options.packageRoot),
    packageId = owner(root),
    sources = sourceArray(options.sources),
    locked = lockedArray(options.lockedSchemas)
  const registry = new Map<string, SourceFile>(),
    modules: Record<string, string> = {}
  const names = new Set<string>(),
    identities = new Set<string>()
  const add = (file: SourceFile): void => {
    validateAuthorSchemaIdentity({ ownerPackageId: file.owner, ...file.entry })
    const identity = key(file.owner, file.entry.name)
    const schemaIdentity = `${file.entry.typeId}\0${file.entry.revision}`
    if (registry.has(identity) || identities.has(schemaIdentity)) fail('duplicate source identity')
    identities.add(schemaIdentity)
    registry.set(identity, file)
  }
  for (const entry of sources) {
    const folded = entry.name.toLowerCase()
    if (names.has(folded)) fail('duplicate source name or schema identity')
    names.add(folded)
    add({ owner: packageId, root, entry })
  }
  const dependencyMetadata = jsonFile(join(root, 'package.json')) as Record<string, unknown>
  const dependencies = {
    ...(schemaObject(dependencyMetadata.dependencies) ? dependencyMetadata.dependencies : {}),
    ...(schemaObject(dependencyMetadata.peerDependencies) ? dependencyMetadata.peerDependencies : {}),
  }
  const packages = new Set<string>()
  for (const dependency of locked) {
    if (
      !isAbsolute(dependency.packageRoot) ||
      packages.has(dependency.packageId) ||
      !Object.hasOwn(dependencies, dependency.packageId)
    )
      fail('unlocked or duplicate dependency')
    packages.add(dependency.packageId)
    const packageRoot = realpathSync(dependency.packageRoot),
      metadata = jsonFile(join(packageRoot, 'package.json'))
    if (
      !schemaObject(metadata) ||
      metadata.name !== dependency.packageId ||
      metadata.version !== dependency.version ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
        dependency.version,
      )
    )
      fail('dependency identity mismatch')
    for (const source of dependency.sources) {
      const entries = sourceArray([
        { name: source.name, typeId: source.typeId, revision: source.revision, source: source.path },
      ])
      add({
        owner: dependency.packageId,
        root: packageRoot,
        entry: entries[0] as SourceEntry,
        expectedDigest: source.fileDigest,
      })
    }
  }
  const evidence: unknown[] = []
  for (const entry of sources) {
    const definitions: Record<string, SchemaDefinition> = {},
      files = new Map<string, { document: Record<string, unknown>; digest: string; path: string }>()
    const load = (file: SourceFile): Record<string, unknown> => {
      const identity = key(file.owner, file.entry.name),
        cached = files.get(identity)
      if (cached) return cached.document
      const path = sourcePath(file.root, file.entry.source),
        bytes = readBounded(path, AUTHOR_SCHEMA_LIMITS.documentBytes),
        digest = hash(bytes)
      if (file.expectedDigest !== undefined && digest !== file.expectedDigest)
        fail('locked source bytes mismatch')
      const raw = parseAuthorSchemaJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      const doc = normalizeAuthorSchemaDocument(raw, file.entry.name)
      files.set(identity, { document: doc, digest, path: file.entry.source })
      return doc
    }
    const select = (file: SourceFile, name: string): string => {
      if (!SCHEMA_NAME.test(name)) fail('invalid definition name')
      const mapped = graphName(file.owner, file.entry.name, name)
      if (Object.hasOwn(definitions, mapped)) return mapped
      if (Object.keys(definitions).length >= AUTHOR_SCHEMA_LIMITS.definitions) fail('definition quota')
      const document = load(file),
        defs = document.$defs as Record<string, unknown>,
        definition = defs[name]
      if (!schemaObject(definition)) fail('missing definition')
      definitions[mapped] = {}
      definitions[mapped] = mapAuthorSchemaPositions(definition, (node) => {
        if (typeof node.$ref !== 'string') return node
        const local = /^#\/\$defs\/([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(node.$ref)
        if (local) return { ...node, $ref: `#/$defs/${select(file, local[1] as string)}` }
        const external = /^pkg:(.+)\/([A-Za-z_$][A-Za-z0-9_$]*)#\/\$defs\/([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(
          node.$ref,
        )
        const target = external ? registry.get(key(external[1] as string, external[2] as string)) : undefined
        if (!target) fail('unlocked schema reference')
        return { ...node, $ref: `#/$defs/${select(target, external?.[3] as string)}` }
      })
      return mapped
    }
    const file = registry.get(key(packageId, entry.name)) as SourceFile,
      raw = load(file)
    const rootName = select(file, (raw.$ref as string).slice(8)),
      document = runtimeSchemaDocument({ $defs: definitions }, rootName)
    const checked = validateOwnedAuthorSchemaSource({
      ownerPackageId: packageId,
      name: entry.name,
      typeId: entry.typeId,
      revision: entry.revision,
      document,
    })
    modules[`${entry.name}.ts`] = generateAuthorSchemaModule(entry.name, checked.source, checked.document)
    evidence.push({
      name: entry.name,
      source: entry.source,
      ref: checked.ref,
      files: [...files]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([identity, value]) => ({ identity, path: value.path, fileDigest: value.digest })),
    })
  }
  modules['schema-sources.generated.json'] =
    `${JSON.stringify({ generatorVersion: 1, ownerPackageId: packageId, schemas: evidence, dependencies: locked.map(({ packageRoot: _, sources: __, ...identity }) => identity) })}\n`
  return modules
}

export function runAuthorSchemaCli(args: readonly string[]): void {
  if (args[0] !== 'generate') fail('expected generate command')
  const values = new Map<string, string>(),
    flags = new Set<string>()
  for (let index = 1; index < args.length; index++) {
    const argument = args[index] as string
    if (argument === '--check') {
      if (flags.has(argument)) fail('duplicate flag')
      flags.add(argument)
      continue
    }
    if (
      !['--package', '--sources', '--out', '--locked-schemas'].includes(argument) ||
      values.has(argument) ||
      !args[index + 1] ||
      args[index + 1]?.startsWith('--')
    )
      fail('invalid argument')
    values.set(argument, args[++index] as string)
  }
  for (const name of ['--package', '--sources', '--out', '--locked-schemas'])
    if (!values.has(name)) fail('missing argument')
  const root = realpathSync(resolve(values.get('--package') as string)),
    output = resolve(root, values.get('--out') as string)
  let parent = output
  while (!existsSync(parent)) parent = dirname(parent)
  if (!inside(root, realpathSync(parent)) || !inside(root, output) || root === output)
    fail('output escapes package')
  const modules = generateOwnedAuthorSchemas({
    packageRoot: root,
    sources: sourceArray(jsonFile(resolve(values.get('--sources') as string))),
    lockedSchemas: lockedArray(jsonFile(resolve(values.get('--locked-schemas') as string))),
  })
  if (existsSync(output)) {
    const names = readdirSync(output)
    if (names.length > 0) {
      const marker = join(output, 'schema-sources.generated.json')
      if (!existsSync(marker)) fail('output contains unrelated files')
      const previous = jsonFile(marker)
      if (
        !schemaObject(previous) ||
        previous.generatorVersion !== 1 ||
        previous.ownerPackageId !== (jsonFile(join(root, 'package.json')) as Record<string, unknown>).name ||
        !Array.isArray(previous.schemas)
      )
        fail('output ownership differs')
      const owned = new Set(['schema-sources.generated.json'])
      for (const schema of previous.schemas) {
        if (!schemaObject(schema) || typeof schema.name !== 'string' || !SCHEMA_NAME.test(schema.name))
          fail('output ownership differs')
        owned.add(`${schema.name}.ts`)
      }
      if (names.some((name) => !owned.has(name) || !statSync(join(output, name)).isFile()))
        fail('output contains unrelated files')
    }
  }
  if (flags.has('--check')) {
    for (const [name, content] of Object.entries(modules)) {
      const path = join(output, name)
      if (
        !existsSync(path) ||
        new TextDecoder().decode(readBounded(path, Math.max(1048576, Buffer.byteLength(content)))) !== content
      )
        fail('generated output differs')
    }
    return
  }
  const staging = `${output}.schema-staging-${process.pid}`
  if (existsSync(staging)) fail('staging output already exists')
  const backup = `${output}.schema-backup-${process.pid}`
  if (existsSync(backup)) fail('backup output already exists')
  mkdirSync(dirname(output), { recursive: true })
  mkdirSync(staging)
  try {
    for (const [name, content] of Object.entries(modules))
      writeFileSync(join(staging, name), content, { flag: 'wx' })
    if (existsSync(output)) renameSync(output, backup)
    try {
      renameSync(staging, output)
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, output)
      throw error
    }
    if (existsSync(backup)) rmSync(backup, { recursive: true })
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true })
  }
}
if (
  process.argv[1] &&
  existsSync(resolve(process.argv[1])) &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  try {
    runAuthorSchemaCli(process.argv.slice(2))
  } catch {
    process.stderr.write('Author schema generation failed\n')
    process.exitCode = 1
  }
}
