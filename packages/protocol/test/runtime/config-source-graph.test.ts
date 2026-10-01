import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { JsonSchemaDoc } from '../../tools/gen-core.js'
import { normalizeRuntimeCatalog } from '../../tools/gen-runtime-catalog.js'
import { loadRuntimeSchemaGraph } from '../../tools/gen-runtime-graph.js'

const directory = fileURLToPath(new URL('../../schema/runtime', import.meta.url))
type Json = Record<string, unknown>

it('resolves the six exact configuration projections and rejects unregistered or forged authorities', () => {
  const graph = loadRuntimeSchemaGraph(directory)
  expect(loadRuntimeSchemaGraph(`${directory}/`).document).toEqual(graph.document)
  for (const name of [
    'RuntimeProfilePolicy',
    'RuntimeProfileSelectionPolicy',
    'RuntimeProfileAllowedPresets',
    'RuntimePresetRestrictions',
    'RuntimePresetSelections',
    'RuntimePresetConfigOverrides',
  ])
    expect(graph.document.$defs?.[name]).toBeDefined()
  expect(graph.document.$defs?.ConfigManagedPolicy?.properties).toMatchObject({
    policy: { $ref: '#/$defs/RuntimeProfilePolicy' },
    selectionPolicy: { $ref: '#/$defs/RuntimeProfileSelectionPolicy' },
    allowedPresets: { $ref: '#/$defs/RuntimeProfileAllowedPresets' },
    providerConfigRestrictions: { $ref: '#/$defs/RuntimePresetConfigOverrides' },
  })
  const mutations: Array<(publicDocument: JsonSchemaDoc, runtime: string) => void> = [
    (document) => {
      ;(document.$defs as Record<string, Json>).ConfigManagedPolicy = {
        $ref: 'profile.schema.json#/properties/client',
      }
    },
    (_document, runtime) => {
      const profile = JSON.parse(readFileSync(join(runtime, 'profile.schema.json'), 'utf8')) as Json
      delete (profile.properties as Json).policy
      writeFileSync(join(runtime, 'profile.schema.json'), JSON.stringify(profile))
    },
    (_document, runtime) => {
      const profile = JSON.parse(readFileSync(join(runtime, 'profile.schema.json'), 'utf8')) as Json
      profile.$id = 'https://invalid.example/profile.schema.json'
      writeFileSync(join(runtime, 'profile.schema.json'), JSON.stringify(profile))
    },
    (document) => {
      ;(document.$defs as Record<string, Json>).RuntimeProfile = { type: 'string' }
    },
    (document) => {
      ;(document.$defs as Record<string, Json>).ConfigManagedPolicy = {
        $ref: 'https://invalid.example/profile.schema.json',
      }
    },
  ]
  for (const mutate of mutations) {
    const temporary = mkdtempSync(join(tmpdir(), 'runtime-config-authority-'))
    try {
      cpSync(join(directory, '..'), temporary, { recursive: true })
      const runtime = join(temporary, 'runtime')
      const file = join(runtime, 'public.json')
      const document = JSON.parse(readFileSync(file, 'utf8')) as JsonSchemaDoc
      mutate(document, runtime)
      writeFileSync(file, JSON.stringify(document))
      expect(() => loadRuntimeSchemaGraph(runtime)).toThrow()
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }
})

it('keeps client-only Local declarations out of backend maintenance eligibility', () => {
  const source = (): JsonSchemaDoc => JSON.parse(readFileSync(join(directory, 'public.json'), 'utf8'))
  const methods = (document: JsonSchemaDoc): Json =>
    ((document['x-service-catalog'] as Json)['agh.artifacts'] as Json).methods as Json
  const document = source()
  const follow = methods(document).followDownload as Json
  expect(follow.local).toBe(true)
  follow.clientOnly = true
  const catalog = normalizeRuntimeCatalog(document)
  expect(((catalog['agh.artifacts'] as Json).methods as Json).followDownload).toMatchObject({
    local: true,
    clientOnly: true,
    sameAttemptBrokerAllowed: false,
  })
  for (const flag of ['yes', 1, null]) {
    follow.clientOnly = flag
    expect(() => normalizeRuntimeCatalog(document)).toThrow(/client-only/)
  }
  const invalid = source()
  methods(invalid).fakeBackend = { kind: 'query', clientOnly: true, input: 'Id', output: 'Id' }
  expect(() => normalizeRuntimeCatalog(invalid)).toThrow(/client-only/)
})
