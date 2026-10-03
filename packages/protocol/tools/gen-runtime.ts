import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateModule, type JsonSchemaDoc } from './gen-core.js'
import { formatRuntimeArtifacts, generateFullRuntimeArtifacts } from './gen-runtime-full.js'

type Method = { requestName: string; input: string; output: string }
const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const header = '// generated from schema/runtime/prototype.json by tools/gen-runtime.ts — do not edit\n'

function validateReferences(node: unknown, definitions: ReadonlySet<string>): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) validateReferences(child, definitions)
    return
  }
  const object = node as Record<string, unknown>
  if (object.$ref !== undefined) {
    const ref = object.$ref
    if (typeof ref !== 'string' || !ref.startsWith('#/$defs/') || !definitions.has(ref.slice(8)))
      throw new Error(`unknown runtime schema reference: ${String(ref)}`)
  }
  for (const child of Object.values(object)) validateReferences(child, definitions)
}

function methodsFrom(doc: JsonSchemaDoc): Record<string, Method> {
  const raw = doc['x-state-store-control']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('runtime schema must declare x-state-store-control methods')
  const methods: Record<string, Method> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[a-zA-Z_$][\w$]*$/.test(name) || value === null || typeof value !== 'object')
      throw new Error(`invalid runtime method: ${name}`)
    const method = value as Partial<Method>
    for (const key of ['requestName', 'input', 'output'] as const) {
      if (typeof method[key] !== 'string' || !/^[a-zA-Z_$][\w$]*$/.test(method[key]))
        throw new Error(`invalid runtime method ${name}.${key}`)
    }
    if (!doc.$defs?.[method.input as string] || !doc.$defs?.[method.output as string])
      throw new Error(`unknown runtime method schema: ${name}`)
    methods[name] = method as Method
  }
  return methods
}

/** One schema owns wire validators, public wire exports and the Local authority method table. */
export function generateRuntimeArtifacts(doc: JsonSchemaDoc): Record<string, string> {
  const names = Object.keys(doc.$defs ?? {})
  if (!names.length) throw new Error('runtime schema must declare $defs')
  for (const name of names) {
    if (!/^[a-zA-Z_$][\w$]*$/.test(name)) throw new Error(`invalid runtime schema name: ${name}`)
  }
  for (const required of ['CallContextWire', 'RuntimeError']) {
    if (!names.includes(required)) throw new Error(`missing runtime schema: ${required}`)
  }
  validateReferences(doc.$defs, new Set(names))
  const methods = methodsFrom(doc)
  const wire = generateModule(doc, 'RuntimePrototype', 'packages/protocol/schema/runtime/prototype.json')
  const protocol = `${header}import type { TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { type ValidationResult, validateAgainst } from '../../../protocol-validation/src/validate.js'
import * as RuntimeSchemas from '../../gen/ts/runtime-prototype.js'
import { jcs } from '../jcs.js'

export type { ValidationError, ValidationResult } from '../../../protocol-validation/src/validate.js'
export type {
${names.map((name) => `  ${name},`).join('\n')}
} from '../../gen/ts/runtime-prototype.js'
export { RuntimeSchemas }

export interface RuntimeWireTypes {
${names.map((name) => `  ${name}: RuntimeSchemas.${name}`).join('\n')}
}

const schemas: { [K in keyof RuntimeWireTypes]: TSchema } = RuntimeSchemas

function validUInt53(schema: TSchema, value: unknown, references: Record<string, TSchema> = {}): boolean {
  const refs = { ...references, ...(schema.$defs as Record<string, TSchema> | undefined) }
  if (schema.$id) refs[schema.$id] = schema
  if (schema.$id === 'UInt53' || schema.$ref === 'UInt53') return !Object.is(value, -0)
  if (schema.$ref) {
    const target = refs[schema.$ref]
    if (!target) throw new Error('unresolved runtime schema reference')
    return validUInt53(target, value, refs)
  }
  if (schema.anyOf) {
    return (schema.anyOf as TSchema[]).some(
      (branch) => Value.Check(branch, Object.values(refs), value) && validUInt53(branch, value, refs),
    )
  }
  if (schema.allOf) return (schema.allOf as TSchema[]).every((branch) => validUInt53(branch, value, refs))
  if (schema.type === 'array' && Array.isArray(value) && schema.items)
    return value.every((item) => validUInt53(schema.items, item, refs))
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    const props = schema.properties as Record<string, TSchema> | undefined
    for (const [key, item] of Object.entries(value)) {
      const property = props?.[key]
      if (property && !validUInt53(property, item, refs)) return false
      const patterns = schema.patternProperties as Record<string, TSchema> | undefined
      for (const [pattern, rule] of Object.entries(patterns ?? {}))
        if (new RegExp(pattern).test(key) && !validUInt53(rule, item, refs)) return false
      if (!property && typeof schema.additionalProperties === 'object') {
        if (!validUInt53(schema.additionalProperties, item, refs)) return false
      }
    }
  }
  return true
}

export function validateRuntime<K extends keyof RuntimeWireTypes>(
  name: K,
  value: unknown,
): ValidationResult<RuntimeWireTypes[K]> {
  try {
    jcs(value)
  } catch {
    return { ok: false, errors: [{ path: '', message: 'invalid JSON wire value', code: 'TYPE' }] }
  }
  const schema = schemas[name]
  const result = validateAgainst<RuntimeWireTypes[K]>(schema, value)
  if (result.ok && !validUInt53(schema, value))
    return { ok: false, errors: [{ path: '', message: 'UInt53 rejects negative zero', code: 'RANGE' }] }
  return result
}
`
  const local = `${header}import type * as Wire from '@agnes/protocol/runtime'

export type {
${names.map((name) => `  ${name},`).join('\n')}
} from '@agnes/protocol/runtime'

export type CallContext = Readonly<Wire.CallContextWire & { signal: AbortSignal }>
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: Wire.RuntimeError }

export interface StateStoreControl {
${Object.entries(methods)
  .map(([name, method]) => {
    const line = `  ${name}(${method.requestName}: Wire.${method.input}, context: CallContext): Promise<Outcome<Wire.${method.output}>>`
    return line.length <= 110
      ? line
      : `  ${name}(\n    ${method.requestName}: Wire.${method.input},\n    context: CallContext,\n  ): Promise<Outcome<Wire.${method.output}>>`
  })
  .join('\n')}
}
`
  return {
    'gen/ts/runtime-prototype.ts': wire,
    'src/runtime/index.ts': protocol,
    '../extension-api/src/runtime/index.ts': local,
  }
}

export function writeRuntime(check: boolean): number {
  const schemaPath = join(pkg, 'schema/runtime/prototype.json')
  const doc = JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonSchemaDoc
  const artifacts = generateRuntimeArtifacts(doc)
  if (existsSync(join(pkg, 'schema/runtime/public.json'))) {
    const original = artifacts['src/runtime/index.ts'] as string
    const unsigned = original.slice(
      original.indexOf('function validUInt53'),
      original.indexOf('export function validateRuntime'),
    )
    artifacts['src/runtime/validation.ts'] = `${header}import type { TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { type ValidationResult, validateAgainst } from '../../../protocol-validation/src/validate.js'
import { boundedCanonicalJson } from '../../../protocol-validation/src/byte-budget.js'
import { RuntimeAuthorCodecPolicy } from '../../gen/ts/runtime-catalog.js'

${unsigned}
export function validateRuntimeValue<T>(schema: TSchema, value: unknown): ValidationResult<T> {
  const policy = RuntimeAuthorCodecPolicy.payload
  const snapshot = boundedCanonicalJson(value, {
    maxBytes: policy.maxCanonicalJsonBytes,
    maxDepth: policy.maxDepth,
    maxMembers: policy.maxMembers,
  })
  if (!snapshot.ok) return snapshot
  const json = snapshot.value.json
  const result = validateAgainst<T>(schema, json)
  if (result.ok && !validUInt53(schema, json))
    return { ok: false, errors: [{ path: '', message: 'UInt53 rejects negative zero', code: 'RANGE' }] }
  return result
}
`
    Object.assign(artifacts, generateFullRuntimeArtifacts(join(pkg, 'schema/runtime')))
    artifacts['src/runtime/index.ts'] =
      `${header}export * from './public.js'\nexport * from './artifacts.js'\nexport * from './client-transport.js'\nexport * from './client-interaction-contract.js'\nexport { canonicalJsonDigest } from './jcs-digest.js'\nexport { boundedCanonicalJson, utf8ByteLength } from '../../../protocol-validation/src/byte-budget.js'\nexport { validateControlledHttpHeaders } from './codec-policy.js'\nexport { validateOwnedAuthorSchemaSource } from './author-schema-source.js'\nexport type { GeneratedAuthorSchemaSource } from './author-schema-source.js'\n`
    const metadata = JSON.parse(readFileSync(join(pkg, 'schema/runtime/local-api.json'), 'utf8')) as {
      'x-author-overrides'?: string[]
    }
    artifacts['../extension-api/src/runtime/index.ts'] += "export * from './authoring.js'\n"
    artifacts['../extension-api/src/runtime/index.ts'] +=
      "export { defineGeneratedAuthorSchema } from './authoring-source.js'\n"
    artifacts['../extension-api/src/runtime/index.ts'] += "export * from './routing-authoring.js'\n"
    if (metadata['x-author-overrides']?.length)
      artifacts['../extension-api/src/runtime/index.ts'] +=
        `export type {\n${metadata['x-author-overrides'].map((name) => `  ${name},`).join('\n')}\n} from './authoring.js'\n`
  }
  if (existsSync(join(pkg, 'schema/runtime/public.json')))
    formatRuntimeArtifacts(artifacts, join(pkg, 'schema/runtime'))
  let stale = 0
  if (existsSync(join(pkg, 'schema/runtime/public.json'))) {
    const managedDirectories = {
      'gen/ts': /^runtime-public-\d+\.ts$/,
      '../extension-api/src/runtime': /^public-\d+\.ts$/,
      '../extension-api/src/client': /^public-\d+\.ts$/,
    }
    for (const [directory, pattern] of Object.entries(managedDirectories)) {
      const target = join(pkg, directory)
      if (!existsSync(target)) continue
      for (const name of readdirSync(target)) {
        const path = `${directory}/${name}`
        if (!pattern.test(name) || Object.hasOwn(artifacts, path)) continue
        if (check) {
          console.error(`obsolete: ${path}`)
          stale++
        } else {
          unlinkSync(join(pkg, path))
          console.log(`removed obsolete ${path}`)
        }
      }
    }
  }
  for (const [path, source] of Object.entries(artifacts)) {
    const target = join(pkg, path)
    const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
    if (source === current) continue
    if (check) {
      console.error(`stale: ${path}`)
      stale++
    } else {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, source)
      console.log(`wrote ${path}`)
    }
  }
  return stale
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  if (writeRuntime(check) && check) process.exitCode = 1
}
