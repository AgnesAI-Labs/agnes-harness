import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { JsonSchemaDoc } from './gen-core.js'

/** Inline only the referenced runtime payload closure; the on-disk aliases retain their authority. */
export function prepareSessionSchema(schemaPath: string): JsonSchemaDoc {
  const directory = dirname(schemaPath)
  const documents = new Map<string, JsonSchemaDoc>()
  const definitions: Record<string, Record<string, unknown>> = {}
  const owners = new Map<string, string>()
  const active = new Set<string>()
  const load = (file: string): JsonSchemaDoc => {
    if (!documents.has(file)) documents.set(file, JSON.parse(readFileSync(file, 'utf8')) as JsonSchemaDoc)
    return documents.get(file) as JsonSchemaDoc
  }
  const target = (reference: string, file: string): [string, string] => {
    const match = /^(.*?)#\/\$defs\/([^/]+)$/.exec(reference)
    if (!match) throw new Error(`unsupported session schema reference ${reference}`)
    if (!match[1]) return [file, match[2] as string]
    const allowed: Record<string, string> = {
      'https://agnes.ai/schema/runtime/v1/public.json': join(directory, 'runtime/public.json'),
      'prototype.json': join(directory, 'runtime/prototype.json'),
    }
    const destination = allowed[match[1] as string]
    if (!destination) throw new Error(`unsupported session schema authority ${reference}`)
    return [destination, match[2] as string]
  }
  const rewrite = (value: unknown, file: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => rewrite(item, file))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key !== '$ref') return [key, rewrite(child, file)]
        if (typeof child !== 'string') throw new Error('schema reference must be a string')
        return [key, `#/$defs/${add(...target(child, file))}`]
      }),
    )
  }
  const add = (file: string, name: string): string => {
    const source = load(file).$defs?.[name]
    if (!source) throw new Error(`missing session schema definition ${name}`)
    if (Object.keys(source).length === 1 && typeof source.$ref === 'string')
      return add(...target(source.$ref, file))
    const owner = owners.get(name)
    if (owner && owner !== file) throw new Error(`duplicate session schema authority ${name}`)
    owners.set(name, file)
    if (definitions[name] || active.has(name)) return name
    active.add(name)
    definitions[name] = rewrite(source, file) as Record<string, unknown>
    active.delete(name)
    return name
  }
  const document = load(schemaPath)
  for (const name of Object.keys(document.$defs ?? {})) add(schemaPath, name)
  return { ...document, $defs: definitions }
}
