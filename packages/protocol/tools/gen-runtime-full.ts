import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { generateModule, type JsonSchemaDoc } from './gen-core.js'
import { emitRuntimeReferences } from './gen-runtime-refs.js'

type Json = Record<string, unknown>
const header = '// generated from schema/runtime by tools/gen-runtime.ts — do not edit\n'
const identifier = /^[A-Za-z_$][\w$]*$/

/** Resolve the schema graph without copying or overriding an external authority's definitions. */
export function loadRuntimeSchemaGraph(directory: string): {
  document: JsonSchemaDoc
  publicDocument: JsonSchemaDoc
  configurationNames: string[]
  sourceFiles: string[]
} {
  const definitions: Record<string, Json> = {}
  const loaded = new Map<string, JsonSchemaDoc>()
  const owners = new Map<string, string>()
  const resolving = new Set<string>()
  const ownFiles = new Set(['prototype.json', 'public.json'])
  const load = (file: string): JsonSchemaDoc => {
    let doc = loaded.get(file)
    if (!doc) {
      doc = JSON.parse(readFileSync(file, 'utf8')) as JsonSchemaDoc
      loaded.set(file, doc)
    }
    return doc
  }
  const nameFor = (file: string, name: string): string =>
    dirname(file) === directory && ownFiles.has(basename(file))
      ? name
      : `External${basename(file, '.json').replace(/[^A-Za-z0-9]/g, '_')}_${name}`
  const add = (file: string, name: string): string => {
    const generatedName = nameFor(file, name)
    const owner = owners.get(generatedName)
    if (owner && owner !== file) throw new Error(`duplicate runtime schema authority for ${generatedName}`)
    owners.set(generatedName, file)
    if (definitions[generatedName] || resolving.has(generatedName)) return generatedName
    if (!identifier.test(generatedName)) throw new Error(`invalid schema identifier ${generatedName}`)
    const source = load(file).$defs?.[name] ?? load(file).definitions?.[name]
    if (!source) throw new Error(`unresolved schema definition ${basename(file)}#/$defs/${name}`)
    resolving.add(generatedName)
    definitions[generatedName] = rewrite(source, file) as Json
    resolving.delete(generatedName)
    return generatedName
  }
  const rewrite = (value: unknown, file: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => rewrite(item, file))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value as Json).map(([key, child]) => {
        if (key !== '$ref') return [key, rewrite(child, file)]
        if (typeof child !== 'string') throw new Error('schema reference must be a string')
        const match = /^(.*?)#\/(?:\$defs|definitions)\/([^/]+)$/.exec(child)
        if (!match) throw new Error(`unsupported external runtime reference ${child}`)
        let target = match[1] ? resolve(dirname(file), match[1]) : file
        if (match[1]?.startsWith('https://agnes.ai/schema/')) {
          const runtime = /^https:\/\/agnes\.ai\/schema\/runtime\/v1\/(prototype|public)\.json$/.exec(
            match[1],
          )
          const external = /^https:\/\/agnes\.ai\/schema\/([a-z0-9-]+\.json)$/.exec(match[1])
          if (runtime) target = resolve(directory, `${runtime[1]}.json`)
          else if (external) target = resolve(directory, '..', external[1] as string)
          else throw new Error(`unsupported canonical runtime reference ${child}`)
        }
        return [key, `#/$defs/${add(target, match[2] as string)}`]
      }),
    )
  }
  for (const name of ['prototype.json', 'public.json']) {
    const file = join(directory, name)
    for (const definition of Object.keys(load(file).$defs ?? {})) add(file, definition)
  }
  const publicDocument = load(join(directory, 'public.json'))
  const configurationNames: string[] = []
  for (const [fileName, name] of Object.entries({
    'empty-config.schema.json': 'RuntimeEmptyAuthorConfig',
    'profile.schema.json': 'RuntimeProfile',
    'preset.schema.json': 'RuntimePreset',
    'plugin-manifest.schema.json': 'RuntimePluginManifest',
    'simple-loop.schema.json': 'RuntimeSimpleLoopCheckpoint',
  })) {
    const file = join(directory, fileName)
    const root = load(file)
    const { $schema: _schema, $id: _id, $defs: _defs, ...shape } = root
    definitions[name] = rewrite(shape, file) as Json
    configurationNames.push(name)
  }
  return {
    document: { $defs: definitions },
    publicDocument,
    configurationNames,
    sourceFiles: [...loaded.keys()],
  }
}

type LocalMetadata = {
  'x-local-api': { runtime: Record<string, string>; client: Record<string, string> }
  'x-generic-api'?: Record<string, { parameter: string; base: string; property: string }>
}

/** Local declarations reference generated Wire names; they never declare another wire DTO table. */
export function generateLocalAPI(
  metadata: LocalMetadata,
  wireNames: ReadonlySet<string>,
): {
  runtime: string
  client: string
} {
  const emit = (section: 'runtime' | 'client'): string => {
    let source = `${header}import type * as Wire from '@agnes/protocol/runtime'\n`
    if (section === 'client')
      source += `import type { ReactElement } from 'react'\nimport type { Outcome } from '../runtime/public-api.js'\n`
    for (const [name, declaration] of Object.entries(metadata['x-local-api'][section])) {
      if (!identifier.test(name) || !new RegExp(`^(?:interface|type) ${name}\\b`).test(declaration))
        throw new Error(`invalid Local API declaration ${name}`)
      for (const [, reference] of declaration.matchAll(/\bWire\.(\w+)/g)) {
        if (!wireNames.has(reference as string)) throw new Error(`unknown Local type ${name}: ${reference}`)
      }
      source += `\nexport ${declaration}`
    }
    if (section === 'client') {
      for (const [name, generic] of Object.entries(metadata['x-generic-api'] ?? {})) {
        if (!wireNames.has(generic.base)) throw new Error(`missing generic base ${generic.base}`)
        source += `\nexport type ${name}<${generic.parameter} = Wire.JsonValue> = Omit<Wire.${generic.base}, '${generic.property}'> & { ${generic.property}: ${generic.parameter} }\n`
      }
    }
    return source
  }
  return { runtime: emit('runtime'), client: emit('client') }
}

/** Bound each inferred Type.Module declaration while preserving its complete reference closure. */
export function generateRuntimeWireModules(document: JsonSchemaDoc): Record<string, string> {
  const definitions = document.$defs ?? {}
  const names = Object.keys(definitions)
  const references = (value: unknown, out: Set<string>): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) references(item, out)
      return
    }
    const object = value as Json
    if (typeof object.$ref === 'string') out.add(object.$ref.slice(8))
    for (const item of Object.values(object)) references(item, out)
  }
  const closure = (roots: readonly string[]): Set<string> => {
    const result = new Set(roots)
    for (const name of result) {
      if (!definitions[name]) throw new Error(`unknown wire definition ${name}`)
      references(definitions[name], result)
    }
    return result
  }
  const bytes = (selected: Set<string>): number =>
    [...selected].reduce((total, name) => total + JSON.stringify(definitions[name]).length, 0)
  const groups: string[][] = [[]]
  for (const name of names) {
    let last = groups[groups.length - 1] as string[]
    if (last.length && bytes(closure([...last, name])) > 60_000) {
      groups.push([])
      last = groups[groups.length - 1] as string[]
    }
    last.push(name)
  }
  const artifacts: Record<string, string> = {}
  let barrel = header
  for (const [index, assigned] of groups.entries()) {
    const selected = closure(assigned)
    const subDocument: JsonSchemaDoc = {
      $defs: Object.fromEntries(
        names.filter((name) => selected.has(name)).map((name) => [name, definitions[name] as Json]),
      ),
    }
    const file = `runtime-public-${index + 1}`
    artifacts[`gen/ts/${file}.ts`] = generateModule(
      subDocument,
      `RuntimePublic${index + 1}`,
      'packages/protocol/schema/runtime/public.json',
    )
    barrel += `export { ${assigned.join(', ')} } from './${file}.js'\n`
  }
  artifacts['gen/ts/runtime-public.ts'] = barrel
  return artifacts
}

export function generateFullRuntimeArtifacts(directory: string): Record<string, string> {
  const { document, publicDocument, configurationNames } = loadRuntimeSchemaGraph(directory)
  const names = Object.keys(document.$defs ?? {})
  const localMetadata = JSON.parse(readFileSync(join(directory, 'local-api.json'), 'utf8')) as LocalMetadata
  const local = generateLocalAPI(localMetadata, new Set(names))
  const catalog = publicDocument['x-service-catalog']
  if (!catalog || typeof catalog !== 'object') throw new Error('missing runtime service catalog')
  const metadataTables: Record<string, unknown> = {
    RuntimeServiceCatalog: catalog,
    RuntimeConfigurationSchemas: configurationNames,
  }
  for (const [key, name] of Object.entries({
    'x-author-capabilities': 'RuntimeAuthorCapabilities',
    'x-interceptor-policy': 'RuntimeInterceptorPolicy',
  })) {
    if (publicDocument[key] !== undefined) metadataTables[name] = publicDocument[key]
  }
  const outputs: Record<string, string> = {
    ...generateRuntimeWireModules(document),
    'gen/ts/runtime-schema-refs.ts': emitRuntimeReferences(document, publicDocument),
    'gen/ts/runtime-wire-types.ts': `${header}import type * as Schemas from './runtime-public.js'\nexport interface RuntimeWireTypes {\n${names.map((name) => `  ${name}: Schemas.${name}`).join('\n')}\n}\n`,
    'gen/ts/runtime-catalog.ts':
      header +
      Object.entries(metadataTables)
        .map(([name, value]) => `export const ${name} = ${JSON.stringify(value, null, 2)} as const\n`)
        .join(''),
    'src/runtime/public.ts': `${header}import type { TSchema } from '@sinclair/typebox'\nimport * as RuntimeSchemas from '../../gen/ts/runtime-public.js'\nimport type { RuntimeWireTypes } from '../../gen/ts/runtime-wire-types.js'\nimport { validateRuntimeValue } from './validation.js'\nexport type { ValidationError, ValidationResult } from '../../../protocol-validation/src/validate.js'\nexport type * from '../../gen/ts/runtime-public.js'\nexport { RuntimeSchemas }\nexport type { RuntimeWireTypes } from '../../gen/ts/runtime-wire-types.js'\nexport { RuntimeSchemaRefs, RuntimeMethodSchemaRefs } from '../../gen/ts/runtime-schema-refs.js'\nconst schemas: { [K in keyof RuntimeWireTypes]: TSchema } = RuntimeSchemas\nexport function validateRuntime<K extends keyof RuntimeWireTypes>(name: K, value: unknown) {\n  return validateRuntimeValue<RuntimeWireTypes[K]>(schemas[name], value)\n}\nexport { ${Object.keys(metadataTables).join(', ')} } from '../../gen/ts/runtime-catalog.js'\n`,
    '../extension-api/src/runtime/index.ts': `${header}export type * from '@agnes/protocol/runtime'\nexport type * from './public-api.js'\n`,
  }
  for (const [section, source] of Object.entries(local)) {
    const pieces = source.split('\nexport ')
    const imports = pieces.shift() as string
    const allLocalNames = new Set([
      ...Object.keys(localMetadata['x-local-api'].runtime),
      ...(section === 'client' ? Object.keys(localMetadata['x-local-api'].client) : []),
      ...(section === 'client' ? Object.keys(localMetadata['x-generic-api'] ?? {}) : []),
    ])
    const chunks: string[][] = [[]]
    for (const declaration of pieces) {
      const last = chunks[chunks.length - 1] as string[]
      if (last.join('\n').split('\n').length + declaration.split('\n').length > 150 && last.length)
        chunks.push([])
      ;(chunks[chunks.length - 1] as string[]).push(declaration)
    }
    const moduleDirectory = `../extension-api/src/${section === 'runtime' ? 'runtime' : 'client'}`
    const barrel = section === 'runtime' ? 'public-api' : 'index'
    const exports: string[] = []
    for (const [index, chunk] of chunks.entries()) {
      const body = chunk.map((piece) => `export ${piece}`).join('\n')
      const defined = new Set([...body.matchAll(/export (?:interface|type) (\w+)/g)].map((match) => match[1]))
      const referenced = [...allLocalNames].filter(
        (name) =>
          !defined.has(name) &&
          !(section === 'client' && name === 'Outcome') &&
          new RegExp(`\\b${name}\\b`).test(body),
      )
      const crossImport = referenced.length
        ? `import type { ${referenced.join(', ')} } from './${barrel}.js'\n`
        : ''
      // Client chunks already get Outcome from the Runtime barrel.
      const ownImports = imports
        .split('\n')
        .filter((line) => {
          if (line.includes('import type * as Wire') && !body.includes('Wire.')) return false
          if (line.includes('ReactElement') && !body.includes('ReactElement')) return false
          if (line.includes('{ Outcome }') && !body.includes('Outcome')) return false
          return true
        })
        .join('\n')
      const name = `public-${index + 1}`
      outputs[`${moduleDirectory}/${name}.ts`] = `${ownImports}${crossImport}\n${body}`
      exports.push(`export type * from './${name}.js'`)
    }
    outputs[`${moduleDirectory}/${barrel}.ts`] = `${header}${exports.join('\n')}\n`
    if (section === 'runtime')
      outputs[`${moduleDirectory}/${barrel}.ts`] += "export type * from '@agnes/protocol/runtime'\n"
    if (section === 'client')
      outputs[`${moduleDirectory}/${barrel}.ts`] +=
        `export type * from '@agnes/protocol/runtime'\nexport type { DomainView } from './public-${chunks.length}.js'\n`
  }
  return outputs
}

export function formatRuntimeArtifacts(outputs: Record<string, string>, directory: string): void {
  const require = createRequire(import.meta.url)
  const biome = require.resolve('@biomejs/biome/bin/biome')
  for (const [path, source] of Object.entries(outputs)) {
    if (path.startsWith('gen/')) continue
    outputs[path] = execFileSync(process.execPath, [biome, 'check', '--write', `--stdin-file-path=${path}`], {
      input: source,
      encoding: 'utf8',
      cwd: resolve(directory, '../../../..'),
    })
  }
}
