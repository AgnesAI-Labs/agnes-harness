import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { JsonSchemaDoc } from './gen-core.js'

type Json = Record<string, unknown>
const roots: Record<string, string> = {
  'empty-config.schema.json': 'RuntimeEmptyAuthorConfig',
  'profile.schema.json': 'RuntimeProfile',
  'preset.schema.json': 'RuntimePreset',
  'plugin-manifest.schema.json': 'RuntimePluginManifest',
  'simple-loop.schema.json': 'RuntimeSimpleLoopCheckpoint',
}
const fragments: Record<string, string> = {
  'profile.schema.json#/properties/policy': 'RuntimeProfilePolicy',
  'profile.schema.json#/properties/selectionPolicy': 'RuntimeProfileSelectionPolicy',
  'profile.schema.json#/properties/presets/properties/allowed': 'RuntimeProfileAllowedPresets',
  'preset.schema.json#/properties/restrictions': 'RuntimePresetRestrictions',
  'preset.schema.json#/properties/selections': 'RuntimePresetSelections',
  'preset.schema.json#/properties/configOverrides': 'RuntimePresetConfigOverrides',
}

/** Resolve registered local authorities, including their exact configuration projections. */
export function loadRuntimeSchemaGraph(directory: string): {
  document: JsonSchemaDoc
  publicDocument: JsonSchemaDoc
  configurationNames: string[]
  sourceFiles: string[]
} {
  directory = resolve(directory)
  const definitions: Record<string, Json> = Object.create(null)
  const loaded = new Map<string, JsonSchemaDoc>()
  const owners = new Map<string, string>()
  const resolving = new Set<string>()
  const load = (file: string): JsonSchemaDoc => {
    let document = loaded.get(file)
    if (!document) {
      document = JSON.parse(readFileSync(file, 'utf8')) as JsonSchemaDoc
      loaded.set(file, document)
    }
    return document
  }
  const add = (file: string, pointer: string): string => {
    const root = load(file)
    const named = /^\/(?:\$defs|definitions)\/([^/]+)$/.exec(pointer)
    let name: string | undefined
    let shape: unknown
    if (named) {
      const raw = named[1] as string
      name =
        dirname(file) === directory && ['prototype.json', 'public.json'].includes(basename(file))
          ? raw
          : `External${basename(file, '.json').replace(/[^A-Za-z0-9]/g, '_')}_${raw}`
      shape = root.$defs?.[raw] ?? root.definitions?.[raw]
    } else if (dirname(file) === directory && Object.hasOwn(roots, basename(file)) && pointer === '') {
      name = roots[basename(file)]
      const { $schema: _schema, $id: _id, $defs: _defs, definitions: _definitions, ...body } = root
      shape = body
    } else {
      name = dirname(file) === directory ? fragments[`${basename(file)}#${pointer}`] : undefined
      if (!name) throw new Error(`unsupported runtime schema fragment ${basename(file)}#${pointer}`)
      shape = root
      for (const part of pointer.slice(1).split('/')) {
        const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
        if (
          !shape ||
          typeof shape !== 'object' ||
          ['__proto__', 'constructor', 'prototype'].includes(key) ||
          !Object.hasOwn(shape, key)
        )
          throw new Error(`unresolved runtime schema fragment ${pointer}`)
        shape = (shape as Json)[key]
      }
    }
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name) || !shape || typeof shape !== 'object')
      throw new Error(`unresolved runtime schema authority ${basename(file)}#${pointer}`)
    const identity = `${file}#${pointer}`
    if (owners.has(name) && owners.get(name) !== identity)
      throw new Error(`duplicate runtime schema authority for ${name}`)
    owners.set(name, identity)
    if (Object.hasOwn(definitions, name) || resolving.has(name)) return name
    resolving.add(name)
    definitions[name] = rewrite(shape, file) as Json
    resolving.delete(name)
    return name
  }
  const rewrite = (value: unknown, file: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => rewrite(item, file))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value as Json).map(([key, child]) => {
        if (key !== '$ref') return [key, rewrite(child, file)]
        if (typeof child !== 'string') throw new Error('schema reference must be a string')
        const hash = child.indexOf('#')
        const uri = hash < 0 ? child : child.slice(0, hash)
        const pointer = hash < 0 ? '' : child.slice(hash + 1)
        let target = uri ? resolve(dirname(file), uri) : file
        if (uri.startsWith('https://')) {
          const runtime = /^https:\/\/agnes\.ai\/schema\/runtime\/v1\/([a-z0-9.-]+\.json)$/.exec(uri)
          const external =
            /^https:\/\/agnes\.ai\/schema\/(agnes-v1|extension-manifest|jobs|session-v1)\.json$/.exec(uri)
          if (
            runtime &&
            ['prototype.json', 'public.json', ...Object.keys(roots)].includes(runtime[1] as string)
          )
            target = resolve(directory, runtime[1] as string)
          else if (external) target = resolve(directory, '..', `${external[1]}.json`)
          else throw new Error(`unsupported canonical runtime reference ${child}`)
          if (load(target).$id !== uri) throw new Error(`runtime schema identity mismatch ${uri}`)
        } else if (uri && !/^[a-z0-9.-]+\.json$/.test(uri)) {
          throw new Error(`unsupported external runtime reference ${child}`)
        }
        return [key, `#/$defs/${add(target, pointer)}`]
      }),
    )
  }
  for (const filename of ['prototype.json', 'public.json']) {
    const file = join(directory, filename)
    for (const name of Object.keys(load(file).$defs ?? {})) add(file, `/$defs/${name}`)
  }
  for (const filename of Object.keys(roots)) add(join(directory, filename), '')
  return {
    document: { $defs: definitions },
    publicDocument: load(join(directory, 'public.json')),
    configurationNames: Object.values(roots),
    sourceFiles: [...loaded.keys()],
  }
}
