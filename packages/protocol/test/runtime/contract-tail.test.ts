import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  RuntimeAuthorityTransferAPI,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '../../src/runtime/index.js'
import type { JsonSchemaDoc } from '../../tools/gen-core.js'
import { normalizeRuntimeCatalog } from '../../tools/gen-runtime-catalog.js'
import { generateFullRuntimeArtifacts, loadRuntimeSchemaGraph } from '../../tools/gen-runtime-full.js'
import { generateRuntimeReferences } from '../../tools/gen-runtime-refs.js'

const directory = fileURLToPath(new URL('../../schema/runtime', import.meta.url))
type Json = Record<string, unknown>
const object = (value: unknown): Json => value as Json
const transferSource = (doc: JsonSchemaDoc): Json => object(doc['x-authority-transfer-api'])
const catalogMethods = (doc: JsonSchemaDoc, contract: string): Json =>
  object(object(object(doc['x-service-catalog'])[contract]).methods)
const publicSource = (): JsonSchemaDoc => JSON.parse(readFileSync(join(directory, 'public.json'), 'utf8'))
const require = createRequire(import.meta.url)
const Ajv2020 = require('ajv/dist/2020.js').default
const formats = require('ajv-formats')
const digest = 'a'.repeat(64)
const config = { schema: { typeId: 'agh.sdk/empty-config@1', revision: 1, digest }, value: {} }
const preset = {
  $schema: 'https://agnes.ai/schema/runtime/v1/preset.schema.json',
  kind: 'agh.preset',
  schemaVersion: '1.0',
  id: 'preset',
  revision: 1,
  selections: [],
  configOverrides: [],
  parameters: config,
  restrictions: {},
}
const profile = {
  $schema: 'https://agnes.ai/schema/runtime/v1/profile.schema.json',
  kind: 'agh.profile',
  schemaVersion: '1.0',
  id: 'profile',
  revision: 1,
  requiredContractSet: 'agh.runtime/full-v1',
  packages: [],
  selections: [],
  providerConfigs: [],
  selectionPolicy: [],
  presets: { default: 'preset', allowed: [{ presetId: 'preset', digest }] },
  policy: {
    capabilityCeiling: [],
    minimumRecovery: 'R0',
    allowedIsolation: ['trusted-in-process'],
    sourcePolicy: { allowLocal: true, npmRegistries: [], gitOrigins: [], allowBuildScripts: false },
    grants: [],
  },
  limits: {},
  client: {
    rendererSelections: [],
    requiredTargets: ['sdk'],
    shell: { packageId: 'package', contributionId: 'shell' },
    registry: { packageId: 'package', contributionId: 'registry' },
    fallbackRenderer: { packageId: 'package', contributionId: 'renderer' },
  },
  storage: { dataDir: '/data', cacheDir: '/cache' },
  overrides: { allowWorkspaceRestrictions: false, sessionParametersSchema: config.schema },
}
const source = { sourceRef: 'source', revision: 1, digest }
const request = {
  algorithm: 'agh.config/resolve-v1',
  defaults: { profile: { source, document: profile }, preset: { source, document: preset } },
  profiles: [{ source, document: profile }],
  presets: [{ source, document: preset }],
  managed: null,
  workspace: null,
  session: null,
}

describe('configuration and authenticated control contracts', () => {
  it('keeps exact root authority references in parity with independent JSON Schema validation', () => {
    const { document } = loadRuntimeSchemaGraph(directory)
    const ajv = new Ajv2020({ strict: false })
    formats(ajv)
    const validate = ajv.compile({ ...document, $ref: '#/$defs/ConfigResolveRequest' })
    for (const [value, expected] of [
      [request, true],
      [{ ...request, profiles: [] }, false],
      [{ ...request, managed: undefined }, false],
      [
        {
          ...request,
          workspace: { source, document: { restrictions: {}, parameters: config, grant: true } },
        },
        false,
      ],
      [{ ...request, profiles: [{ source, document: { ...profile, extends: [] } }] }, false],
      [{ ...request, profiles: [{ source, document: preset }] }, false],
      [
        {
          ...request,
          managed: {
            source,
            document: {
              policy: profile.policy,
              selectionPolicy: [],
              allowedPresets: profile.presets.allowed,
              limits: {},
              packagesDeny: [],
              providerConfigRestrictions: [],
            },
          },
        },
        true,
      ],
    ] as const) {
      expect(Boolean(validate(value))).toBe(expected)
      expect(validateRuntime('ConfigResolveRequest', value).ok).toBe(expected)
    }
    // A digest/shape success is a candidate; this test does not assert trusted Host adoption.
    expect(
      validateRuntime('ConfigResolveResult', {
        status: 'candidate',
        algorithm: request.algorithm,
        sourceSetDigest: digest,
        profile,
        preset,
        provenance: [],
        profileDigest: digest,
        presetDigest: digest,
      }).ok,
    ).toBe(true)
    expect(
      validateRuntime('ConfigResolveResult', {
        status: 'published',
        algorithm: request.algorithm,
        sourceSetDigest: digest,
        profile,
        preset,
        provenance: [],
        profileDigest: digest,
        presetDigest: digest,
      }).ok,
    ).toBe(false)
  })

  it('uses the client answer authority and a nested Host form request without changing the old action', () => {
    const methods = RuntimeServiceCatalog['agh.interaction'].methods
    expect(methods.acceptResponse).toMatchObject({
      kind: 'control',
      input: 'InteractionClientRespondRequest',
      identityField: 'responseId',
    })
    expect(methods.respond).toMatchObject({ kind: 'action', input: 'InteractionRespondRequest' })
    expect(methods.respondApproval).toMatchObject({
      kind: 'control',
      identityField: 'responseId',
      sameAttemptBrokerAllowed: false,
    })
    const input = { interactionId: 'interaction', expectedVersion: 1 }
    expect(validateRuntime('ClientInteractionFormLinkInput', input).ok).toBe(true)
    expect(validateRuntime('ClientInteractionFormLinkInput', { ...input, requestId: 'untrusted' }).ok).toBe(
      false,
    )
    expect(validateRuntime('InteractionFormLinkRequest', { requestId: 'host', input }).ok).toBe(true)
    for (const value of [
      input,
      { requestId: 'host', input, trusted: true },
      { requestId: 'host', input: { ...input, expectedVersion: -0 } },
    ])
      expect(validateRuntime('InteractionFormLinkRequest', value).ok).toBe(false)
  })
})

describe('optional authority maintenance catalog', () => {
  it('derives all eligible methods and their distinct references from one template', () => {
    expect(RuntimeAuthorityTransferAPI.contracts).toHaveLength(49)
    let methods = 0
    for (const contract of RuntimeAuthorityTransferAPI.contracts) {
      const catalog = RuntimeServiceCatalog[contract].methods as Record<
        string,
        {
          kind: string
          requiredFeature?: string
          sameAttemptBrokerAllowed: boolean
          input: string
          output: string
        }
      >
      for (const operation of Object.values(RuntimeAuthorityTransferAPI.methods)) {
        expect(catalog[operation.backendMethod]).toMatchObject({
          kind: 'maintenance',
          requiredFeature: 'authority-transfer.v1',
          sameAttemptBrokerAllowed: false,
          input: operation.input,
          output: operation.output,
        })
        expect(RuntimeMethodSchemaRefs[contract][operation.backendMethod]?.input.typeId).toBe(
          `${contract}/${operation.backendMethod}.request@1`,
        )
        methods++
      }
    }
    expect(methods).toBe(392)
    expect(RuntimeMethodSchemaRefs['agh.state'].authorityProbe?.input.digest).toBe(
      RuntimeMethodSchemaRefs['agh.jobs'].authorityProbe?.input.digest,
    )
    for (const frontend of ['agh.ui-registry', 'agh.renderer', 'agh.shell'] as const)
      expect('authorityProbe' in RuntimeServiceCatalog[frontend].methods).toBe(false)
  })

  it('refuses a missing owner, malformed template, name collision or Local signature drift', () => {
    const { document } = loadRuntimeSchemaGraph(directory)
    const wire = new Set(Object.keys(document.$defs ?? {}))
    for (const mutate of [
      (doc: JsonSchemaDoc) => (transferSource(doc).contracts as string[]).pop(),
      (doc: JsonSchemaDoc) => (transferSource(doc).contracts as string[]).push('agh.renderer'),
      (doc: JsonSchemaDoc) => delete object(transferSource(doc).methods).probe,
      (doc: JsonSchemaDoc) => (object(object(transferSource(doc).methods).probe).output = 'UnknownWire'),
      (doc: JsonSchemaDoc) => (catalogMethods(doc, 'agh.state').authorityProbe = { kind: 'query' }),
    ]) {
      const doc = publicSource()
      mutate(doc)
      expect(() => normalizeRuntimeCatalog(doc, wire)).toThrow()
    }
    const base = mkdtempSync(join(tmpdir(), 'runtime-tail-'))
    try {
      cpSync(join(directory, '..'), base, { recursive: true })
      const runtime = join(base, 'runtime')
      const doc = JSON.parse(readFileSync(join(runtime, 'public.json'), 'utf8')) as JsonSchemaDoc
      object(object(transferSource(doc).methods).probe).output = 'UInt53'
      writeFileSync(join(runtime, 'public.json'), JSON.stringify(doc))
      expect(() => generateFullRuntimeArtifacts(runtime)).toThrow(/signature disagrees/)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('preserves every preexisting method reference when unrelated definitions and optional maintenance are added', () => {
    const { document, publicDocument } = loadRuntimeSchemaGraph(directory)
    const previous = structuredClone(publicDocument)
    delete previous['x-authority-transfer-api']
    for (const [contract, added] of Object.entries({
      'agh.config': ['resolve'],
      'agh.interaction': ['pending', 'responseStatus', 'acceptResponse', 'respondApproval', 'formLink'],
    }))
      for (const method of added) delete catalogMethods(previous, contract)[method]
    const before = generateRuntimeReferences(document, previous).RuntimeMethodSchemaRefs
    for (const [contract, methods] of Object.entries(before))
      for (const [method, refs] of Object.entries(methods))
        expect(
          RuntimeMethodSchemaRefs[contract as keyof typeof RuntimeMethodSchemaRefs][method as never],
        ).toEqual(refs)
  })
})
