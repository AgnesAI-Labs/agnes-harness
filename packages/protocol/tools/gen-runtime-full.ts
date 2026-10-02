import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { generateClientTransportArtifacts } from './gen-client-transport.js'
import { generateModule, type JsonSchemaDoc } from './gen-core.js'
import { generateRuntimeArtifactArtifacts } from './gen-runtime-artifacts.js'
import { normalizeRuntimeCatalog } from './gen-runtime-catalog.js'
import { loadRuntimeSchemaGraph } from './gen-runtime-graph.js'
import { emitRuntimeReferences } from './gen-runtime-refs.js'
import { validateStateRuntimeMetadata } from './gen-runtime-state.js'

type Json = Record<string, unknown>
const header = '// generated from schema/runtime by tools/gen-runtime.ts — do not edit\n'
const identifier = /^[A-Za-z_$][\w$]*$/

export { normalizeBrokerCatalog } from './gen-runtime-catalog.js'
export { loadRuntimeSchemaGraph } from './gen-runtime-graph.js'

/** Legacy ingress codecs remain a separate ephemeral, Host-produced family. */
export function validateLegacyIdentityMetadata(
  metadata: JsonSchemaDoc,
  wireNames: ReadonlySet<string>,
): void {
  const expected = {
    credentialEnvelope: 'LegacyIdentityCredentialEnvelope',
    transportEvidence: 'LegacyIdentityTransportEvidence',
    proof: 'TransportEvidenceProof',
    requiredFeature: 'identity-legacy-ingress.v1',
    hostOnlyEvidence: true,
    ephemeralOnly: true,
    method: 'initialize',
  }
  const table = metadata['x-identity-legacy-schemas'] as Json | undefined
  const ids = metadata['x-schema-ids'] as Json | undefined
  const credential = metadata.$defs?.LegacyIdentityCredentialEnvelope as Json | undefined
  if (
    !table ||
    Array.isArray(table) ||
    Object.keys(table).sort().join(',') !== Object.keys(expected).sort().join(',') ||
    Object.entries(expected).some(([key, value]) => table[key] !== value) ||
    ![expected.credentialEnvelope, expected.transportEvidence, expected.proof].every((name) =>
      wireNames.has(name),
    ) ||
    ids?.LegacyIdentityCredentialEnvelope !== 'agh.identity/legacy-credential@1' ||
    ids?.LegacyIdentityTransportEvidence !== 'agh.identity/legacy-transport-evidence@1' ||
    !credential ||
    Object.keys(credential).sort().join(',') !== '$ref,x-secret' ||
    credential.$ref !== 'https://agnes.ai/schema/agnes-v1.json#/$defs/Auth' ||
    credential['x-secret'] !== true
  )
    throw new Error('invalid legacy identity schema metadata')
}

type LocalMetadata = {
  'x-local-api': { runtime: Record<string, string>; client: Record<string, string> }
  'x-generic-api'?: Record<string, { parameter: string; base: string; property: string }>
  'x-client-wire-exports'?: string[]
  'x-control-api'?: Record<string, { contract: string; methods: string[] }>
  'x-page-api'?: { base: string; instances: Record<string, string> }
}

/** Local declarations reference generated Wire names; they never declare another wire DTO table. */
export function generateLocalAPI(
  metadata: LocalMetadata,
  wireNames: ReadonlySet<string>,
  catalog?: Json,
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
    if (section === 'runtime') {
      for (const [name, control] of Object.entries(metadata['x-control-api'] ?? {})) {
        if (!identifier.test(name) || metadata['x-local-api'].runtime[name] || !catalog)
          throw new Error(`invalid generated control API ${name}`)
        const entry = catalog[control.contract] as Json | undefined
        const methods = entry?.methods as Json | undefined
        if (
          !methods ||
          !Array.isArray(control.methods) ||
          !control.methods.length ||
          new Set(control.methods).size !== control.methods.length
        )
          throw new Error(`invalid control method table ${name}`)
        source += `\nexport interface ${name} {\n`
        for (const method of control.methods) {
          const operation = methods[method] as Json | undefined
          if (
            !identifier.test(method) ||
            !operation ||
            operation.kind !== 'control' ||
            typeof operation.input !== 'string' ||
            typeof operation.output !== 'string' ||
            !wireNames.has(operation.input) ||
            !wireNames.has(operation.output)
          )
            throw new Error(`invalid control method ${name}.${method}`)
          source += `  ${method}(request: Wire.${operation.input}, context: CallContext): Promise<Outcome<Wire.${operation.output}>>;\n`
        }
        source += '}\n'
      }
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
export function generateRuntimeWireModules(
  document: JsonSchemaDoc,
  pageAPI?: LocalMetadata['x-page-api'],
): Record<string, string> {
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
  const pageNames = new Set(Object.keys(pageAPI?.instances ?? {}))
  if (pageAPI) {
    const base = definitions[pageAPI.base] as Json | undefined
    if (!base || !pageNames.has(pageAPI.base)) throw new Error('missing Page generic base')
    for (const [name, item] of Object.entries(pageAPI.instances)) {
      const schema = definitions[name] as Json | undefined
      const properties = schema?.properties as Record<string, Json> | undefined
      const { items: _items, ...shape } = properties ?? {}
      const { items: _baseItems, ...baseShape } = base.properties as Record<string, Json>
      if (
        !definitions[item] ||
        schema?.type !== 'object' ||
        JSON.stringify(shape) !== JSON.stringify(baseShape) ||
        JSON.stringify(schema.required) !== JSON.stringify(base.required) ||
        schema.additionalProperties !== false ||
        (properties?.items?.items as Json | undefined)?.$ref !== `#/$defs/${item}`
      )
        throw new Error(`invalid Page instance ${name}`)
    }
  }
  const affected = new Set(pageNames)
  for (;;) {
    const size = affected.size
    for (const name of names) {
      const refs = new Set<string>()
      references(definitions[name], refs)
      if ([...refs].some((ref) => affected.has(ref))) affected.add(name)
    }
    if (affected.size === size) break
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
    let module = generateModule(
      subDocument,
      `RuntimePublic${index + 1}`,
      'packages/protocol/schema/runtime/public.json',
    )
    if ([...selected].some((name) => affected.has(name))) {
      module = `import type { Page } from './runtime-public.js'\n${module}`
      const touchesPage = (schema: Json): boolean => {
        const refs = new Set<string>()
        references(schema, refs)
        return [...refs].some((ref) => affected.has(ref))
      }
      const override = (schema: Json, base: string): string => {
        if (!touchesPage(schema)) return base
        if (typeof schema.$ref === 'string') return schema.$ref.slice(8)
        const branches = schema.anyOf ?? schema.oneOf
        if (Array.isArray(branches)) {
          return branches
            .map((branch: Json) => {
              if (typeof branch.$ref === 'string') return branch.$ref.slice(8)
              if (branch.type === 'null') return `Extract<${base}, null>`
              if (branch.type === 'array') return override(branch, `Extract<${base}, readonly unknown[]>`)
              const discriminators = Object.entries((branch.properties ?? {}) as Record<string, Json>).filter(
                ([, property]) => Object.hasOwn(property, 'const'),
              )
              if (!discriminators.length)
                throw new Error('Page union override requires named branches or const discriminators')
              const narrowed = `Extract<${base}, { ${discriminators.map(([key, property]) => `${JSON.stringify(key)}: ${JSON.stringify(property.const)}`).join('; ')} }>`
              return `(${override(branch, narrowed)})`
            })
            .join(' | ')
        }
        if (schema.type === 'array' && schema.items && !Array.isArray(schema.items))
          return `Array<${override(schema.items as Json, `NonNullable<${base}>[number]`)}>`
        if (schema.type !== 'object' || !schema.properties) throw new Error('unsupported Page type override')
        const fields = Object.entries(schema.properties as Record<string, Json>).filter(([, value]) =>
          touchesPage(value),
        )
        if (!fields.length) return base
        const required = new Set(schema.required as string[] | undefined)
        return `Omit<${base}, ${fields.map(([key]) => JSON.stringify(key)).join(' | ')}> & { ${fields.map(([key, value]) => `${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${override(value, `Exclude<(${base})[${JSON.stringify(key)}], undefined>`)}`).join('; ')} }`
      }
      for (const name of selected) {
        if (!affected.has(name)) continue
        const item = pageAPI?.instances[name]
        const type = item ? `Page<${item}>` : override(definitions[name] as Json, `Static<typeof ${name}>`)
        module = module.replace(
          `export type ${name} = Static<typeof ${name}>`,
          `export type ${name} = ${type}`,
        )
      }
    }
    artifacts[`gen/ts/${file}.ts`] = module
    barrel += `export { ${assigned.join(', ')} } from './${file}.js'\n`
    if (pageAPI && assigned.includes(pageAPI.base))
      barrel += `import type { Static } from '@sinclair/typebox'\nimport type { ${pageAPI.base} as PageSchema } from './${file}.js'\nexport type Page<T> = Omit<Static<typeof PageSchema>, 'items'> & { items: readonly T[] }\n`
  }
  artifacts['gen/ts/runtime-public.ts'] = barrel
  return artifacts
}

function frozenLiteral(value: unknown): string {
  if (Array.isArray(value)) return `Object.freeze([${value.map(frozenLiteral).join(', ')}] as const)`
  if (value && typeof value === 'object')
    return `Object.freeze({${Object.entries(value)
      .map(([key, child]) => `${JSON.stringify(key)}: ${frozenLiteral(child)}`)
      .join(', ')}} as const)`
  return JSON.stringify(value)
}

export function generateFullRuntimeArtifacts(directory: string): Record<string, string> {
  const { document, publicDocument, configurationNames } = loadRuntimeSchemaGraph(directory)
  const names = Object.keys(document.$defs ?? {})
  const localMetadata = JSON.parse(readFileSync(join(directory, 'local-api.json'), 'utf8')) as LocalMetadata
  if (!localMetadata['x-page-api']) throw new Error('missing runtime Page metadata')
  const catalog = normalizeRuntimeCatalog(publicDocument, new Set(names))
  const transfer = publicDocument['x-authority-transfer-api'] as Json | undefined
  if (transfer) {
    const declaration = localMetadata['x-local-api'].runtime.AuthorityTransferControl
    if (typeof declaration !== 'string') throw new Error('missing Local authority transfer API')
    const methods = transfer.methods as Record<string, { input: string; output: string }>
    const signatures = [
      ...declaration.matchAll(
        /(\w+)\(request: Wire\.(\w+), context: CallContext\): Promise<Outcome<Wire\.(\w+)>>;/g,
      ),
    ]
    if (
      signatures.length !== Object.keys(methods).length ||
      signatures.some(
        ([, method, input, output]) =>
          !method ||
          !methods[method] ||
          methods[method]?.input !== input ||
          methods[method]?.output !== output,
      )
    )
      throw new Error('Local authority transfer signature disagrees with template')
  }
  const outbox = publicDocument['x-events-outbox-api'] as Json | undefined
  if (outbox) {
    const declaration = localMetadata['x-local-api'].runtime.EventsOutboxControl
    const methods = outbox.methods as Record<string, { input: string; output: string }>
    const signatures =
      typeof declaration === 'string'
        ? [
            ...declaration.matchAll(
              /(\w+)\(request: Wire\.(\w+), context: CallContext\): Promise<Outcome<Wire\.(\w+)>>;/g,
            ),
          ]
        : []
    if (
      !['BoundService', 'ServiceProvider'].every((name) =>
        /readonly eventsOutbox\?: EventsOutboxControl;/.test(
          localMetadata['x-local-api'].runtime[name] ?? '',
        ),
      ) ||
      signatures.length !== Object.keys(methods).length ||
      signatures.some(
        ([, method, input, output]) =>
          !method || methods[method]?.input !== input || methods[method]?.output !== output,
      )
    )
      throw new Error('Local events outbox signature disagrees with owner template')
  }
  const local = generateLocalAPI(localMetadata, new Set(names), catalog)
  const approval = publicDocument['x-approval-intent-policy'] as Json | undefined
  const approvalFields = [
    'actionRef',
    'inputDigest',
    'policyDecisionRef',
    'scope',
    'allowedResponders',
    'allowedGrantScopes',
    'expiresAt',
    'risk',
  ]
  const approvalProperties = document.$defs?.ApprovalRequest?.properties as Json | undefined
  if (
    !approval ||
    Object.keys(approval).sort().join(',') !==
      'algorithm,answerSchema,defaultAllowedGrantScopes,fields,riskMutableByHook,setFields,setOrder' ||
    approval.algorithm !== 'jcs-sha256' ||
    approval.answerSchema !== 'ApprovalAnswer' ||
    approval.riskMutableByHook !== false ||
    approval.setOrder !== 'utf8' ||
    !Array.isArray(approval.fields) ||
    approval.fields.length !== approvalFields.length ||
    !approval.fields.every((field, index) => field === approvalFields[index]) ||
    !Array.isArray(approval.setFields) ||
    approval.setFields.length !== 2 ||
    approval.setFields[0] !== 'allowedResponders' ||
    approval.setFields[1] !== 'allowedGrantScopes' ||
    !Array.isArray(approval.defaultAllowedGrantScopes) ||
    approval.defaultAllowedGrantScopes.length !== 1 ||
    approval.defaultAllowedGrantScopes[0] !== 'once' ||
    !approvalFields.every((name) => approvalProperties && Object.hasOwn(approvalProperties, name))
  )
    throw new Error('invalid approval intent binding policy')
  validateLegacyIdentityMetadata(publicDocument, new Set(names))
  validateStateRuntimeMetadata(
    document,
    publicDocument,
    localMetadata as unknown as Json,
    JSON.parse(readFileSync(join(directory, 'state85-legacy-schema-documents.json'), 'utf8')),
  )
  const metadataTables: Record<string, unknown> = {
    RuntimeServiceCatalog: catalog,
    RuntimeConfigurationSchemas: configurationNames,
    RuntimeStateQueryMethods: (publicDocument['x-state-query-api'] as Json).methods,
    RuntimeStateOpenRetryPolicy: publicDocument['x-state-open-retry-policy'],
    RuntimeStateLegacyReaders: publicDocument['x-state-legacy-readers'],
    RuntimeAuthorityTransferAPI: publicDocument['x-authority-transfer-api'],
    RuntimeEventsOutboxAPI: publicDocument['x-events-outbox-api'],
  }
  for (const [key, name] of Object.entries({
    'x-author-capabilities': 'RuntimeAuthorCapabilities',
    'x-interceptor-policy': 'RuntimeInterceptorPolicy',
    'x-author-codec-policy': 'RuntimeAuthorCodecPolicy',
    'x-http-header-policy': 'RuntimeHttpHeaderPolicy',
    'x-approval-intent-policy': 'RuntimeApprovalIntentPolicy',
    'x-identity-legacy-schemas': 'RuntimeIdentityLegacySchemas',
  })) {
    if (publicDocument[key] !== undefined) metadataTables[name] = publicDocument[key]
  }
  const policy = publicDocument['x-author-codec-policy'] as Json | undefined
  const payload = policy?.payload as Json | undefined
  const positive = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  if (
    !policy ||
    Object.keys(policy).sort().join(',') !== 'maxInlineBytes,payload' ||
    !payload ||
    Object.keys(payload).sort().join(',') !== 'maxCanonicalJsonBytes,maxDepth,maxMembers' ||
    !positive(policy.maxInlineBytes) ||
    !Object.values(payload).every(positive) ||
    policy.maxInlineBytes > (payload.maxCanonicalJsonBytes as number)
  )
    throw new Error('invalid author codec policy')
  const headers = publicDocument['x-http-header-policy'] as Json | undefined
  const headerShape = document.$defs?.ControlledHttpHeaders
  const namesOfHeaders = Object.keys((headerShape?.properties ?? {}) as Json)
  if (
    !headers ||
    Object.keys(headers).sort().join(',') !== 'request,response' ||
    !Object.values(headers).every(
      (value) =>
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((name) => typeof name === 'string' && namesOfHeaders.includes(name)) &&
        new Set(value).size === value.length,
    ) ||
    new Set(Object.values(headers).flat()).size !== namesOfHeaders.length
  )
    throw new Error('invalid HTTP header policy')
  const outputs: Record<string, string> = {
    ...generateRuntimeArtifactArtifacts(publicDocument, document),
    ...generateClientTransportArtifacts(
      publicDocument,
      localMetadata as unknown as Json,
      catalog,
      new Set(names),
      document,
    ),
    ...generateRuntimeWireModules(document, localMetadata['x-page-api']),
    'gen/ts/runtime-schema-refs.ts': emitRuntimeReferences(document, publicDocument),
    'gen/ts/runtime-wire-types.ts': `${header}import type * as Schemas from './runtime-public.js'\nexport interface RuntimeWireTypes {\n${names.map((name) => `  ${name}: Schemas.${name}`).join('\n')}\n}\n`,
    'gen/ts/runtime-catalog.ts':
      header +
      Object.entries(metadataTables)
        .map(([name, value]) =>
          [
            'RuntimeAuthorCodecPolicy',
            'RuntimeHttpHeaderPolicy',
            'RuntimeAuthorityTransferAPI',
            'RuntimeEventsOutboxAPI',
            'RuntimeApprovalIntentPolicy',
            'RuntimeIdentityLegacySchemas',
            'RuntimeStateQueryMethods',
            'RuntimeStateOpenRetryPolicy',
            'RuntimeStateLegacyReaders',
          ].includes(name)
            ? `export const ${name} = ${frozenLiteral(value)}\n`
            : `export const ${name} = ${JSON.stringify(value, null, 2)} as const\n`,
        )
        .join('') +
      `export const MAX_AUTHOR_INLINE_BYTES = RuntimeAuthorCodecPolicy.maxInlineBytes\n`,
    'src/runtime/public.ts': `${header}import type { TSchema } from '@sinclair/typebox'\nimport * as RuntimeSchemas from '../../gen/ts/runtime-public.js'\nimport type { RuntimeWireTypes } from '../../gen/ts/runtime-wire-types.js'\nimport { validateRuntimeValue } from './validation.js'\nexport type { ValidationError, ValidationResult } from '../../../protocol-validation/src/validate.js'\nexport type * from '../../gen/ts/runtime-public.js'\nexport { RuntimeSchemas }\nexport type { RuntimeWireTypes } from '../../gen/ts/runtime-wire-types.js'\nexport { RuntimeSchemaRefs, RuntimeMethodSchemaRefs } from '../../gen/ts/runtime-schema-refs.js'\nconst schemas: { [K in keyof RuntimeWireTypes]: TSchema } = RuntimeSchemas\nexport function validateRuntime<K extends keyof RuntimeWireTypes>(name: K, value: unknown) {\n  return validateRuntimeValue<RuntimeWireTypes[K]>(schemas[name], value)\n}\nexport { ${Object.keys(metadataTables).join(', ')}, MAX_AUTHOR_INLINE_BYTES } from '../../gen/ts/runtime-catalog.js'\n`,
    '../extension-api/src/runtime/index.ts': `${header}export type * from '@agnes/protocol/runtime'\nexport type * from './public-api.js'\n`,
  }
  for (const [section, source] of Object.entries(local)) {
    const pieces = source.split('\nexport ')
    const imports = pieces.shift() as string
    const allLocalNames = new Set([
      ...Object.keys(localMetadata['x-local-api'].runtime),
      ...Object.keys(localMetadata['x-control-api'] ?? {}),
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
    if (section === 'client') {
      const wireExports = localMetadata['x-client-wire-exports']
      if (
        !Array.isArray(wireExports) ||
        new Set(wireExports).size !== wireExports.length ||
        wireExports.some((name) => !identifier.test(name) || !names.includes(name) || allLocalNames.has(name))
      )
        throw new Error('invalid client wire exports')
      outputs[`${moduleDirectory}/${barrel}.ts`] +=
        `export type { ${[...wireExports, 'Page'].join(', ')} } from '@agnes/protocol/runtime'\nexport type { Outcome, CallContext } from '../runtime/public-api.js'\n`
    }
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
